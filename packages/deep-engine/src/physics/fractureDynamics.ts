/**
 * PHYS-EDGE 刀 1:冲击触发层级碎裂(在 T18 预破碎计划之上)。
 *
 * 对标 UE Chaos Destruction 的 graph 破裂(参考级,如实声明边界):
 * - 冲击命中 piece,从其触接连接中**最弱者**(平局取 id 小)起裂——裂纹弱面优先;
 * - 连接吸收能量达到强度即断,超额残差沿连接图向未断邻接传播:每跳乘
 *   propagationDecay,同跳邻接间均分,层序与邻接枚举按 connection id 升序确定;
 * - 每次断裂后做连通性检查:保留侧 = 含本次冲击源的分量,其余连通分量(按最小
 *   piece id 排序)逐组产出碎片激活事件,已脱离件不再重复产出;
 * - 能量总账(精确):输入 = Σ已断连接吸收(= 强度)+ Σ未断连接累计 + Σ耗散
 *   (断裂截断、衰减损耗、已断连接/无邻接时残差直落)。
 *
 * 与 fractureReference 的分工:buildPreFracture 计划与连接强度语义原样复用;
 * FractureLedger 的 applyImpact 是"全额累计"语义,本求解器需要"封顶 + 残差流出"
 * 才能守住总账,故 absorbed/broken 自管,不混用两种记账(避免合同漂移)。
 * 固定步长:queueImpact 排队输入、step() 按 FIFO 处理;快照含队列,回放逐位一致。
 */
import { type PreFracturePlan } from "./fractureReference.js";
import { assertFinite, fingerprintFloat64, type FixedStepSim, type Vec3 } from "./physicsTypes.js";

export interface FracturePropagationConfig {
  /** 每跳传播能量保留比例 ∈ [0,1];0 = 仅冲击面断裂。 */
  readonly propagationDecay: number;
  /** 传播跳数上限 ≥1:超出上限的残差直落耗散账。 */
  readonly maxHops: number;
}

export interface ImpactInput {
  /** 直接指定命中 piece(与 atPoint 同时给出时优先生效)。 */
  readonly atPiece?: number;
  /** 世界坐标命中点:包含胞元优先,否则取中心最近,平局取 id 小。 */
  readonly atPoint?: Vec3;
  readonly energyJoules: number;
}

export interface FractureBreakEvent {
  readonly connectionId: number;
  readonly pieceA: number;
  readonly pieceB: number;
  /** 断裂吸收(恒等于连接强度)。 */
  readonly absorbedJoules: number;
  /** 相对冲击源的跳数(起裂面 = 0)。 */
  readonly hop: number;
  /** 断裂后按规则向邻接分配前流出的残差(J)。 */
  readonly residualJoules: number;
}

export interface FragmentActivationEvent {
  /** 脱离冲击源侧的连通分量成员(升序)。 */
  readonly pieces: readonly number[];
  /** 触发分离的断裂连接 id。 */
  readonly viaConnectionId: number;
}

export interface FractureSolverSnapshot {
  readonly tick: number;
  readonly absorbed: readonly number[];
  readonly broken: readonly number[];
  readonly queued: readonly ImpactInput[];
  readonly breakEvents: readonly FractureBreakEvent[];
  readonly activationEvents: readonly FragmentActivationEvent[];
  readonly inputJoules: number;
  readonly dissipatedJoules: number;
  readonly brokenStrengthSum: number;
}

/** 冲击源 piece;atPiece 直接用,atPoint 走几何定位(见 locateImpactPiece)。 */
function resolveImpactPiece(plan: PreFracturePlan, impact: ImpactInput): number {
  if (impact.atPiece !== undefined) {
    if (!Number.isSafeInteger(impact.atPiece) || impact.atPiece < 0 || impact.atPiece >= plan.pieces.length) {
      throw new Error(`FractureSolver: atPiece ${impact.atPiece} out of range.`);
    }
    return impact.atPiece;
  }
  if (impact.atPoint === undefined) throw new Error("FractureSolver: impact needs atPiece or atPoint.");
  return locateImpactPiece(plan, impact.atPoint);
}

/** 冲击定位:包含点者优先,否则中心欧氏最近,平局取 id 小(确定性)。 */
export function locateImpactPiece(plan: PreFracturePlan, point: Vec3): number {
  if (!point.every(Number.isFinite)) throw new Error("locateImpactPiece: point must be finite.");
  let bestId = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  let bestContains = false;
  for (const piece of plan.pieces) {
    const contains = [0, 1, 2].every((a) => point[a]! >= piece.aabbMin[a]! && point[a]! <= piece.aabbMax[a]!);
    const center = [0, 1, 2].map((a) => (piece.aabbMin[a]! + piece.aabbMax[a]!) / 2);
    const dist = Math.hypot(point[0]! - center[0]!, point[1]! - center[1]!, point[2]! - center[2]!);
    const better = contains !== bestContains ? contains
      : dist < bestDist - 1e-15 || (dist <= bestDist + 1e-15 && (bestId < 0 || piece.id < bestId));
    if (better) { bestId = piece.id; bestDist = dist; bestContains = contains; }
  }
  return bestId;
}

/** 能量总账残差:输入 −(已断强度和 + 未断累计 + 耗散),守恒时为 0。 */
export function energyLedgerResidual(snapshot: FractureSolverSnapshot): number {
  let unbroken = 0;
  for (let i = 0; i < snapshot.absorbed.length; i += 1) {
    if (snapshot.broken[i] !== 1) unbroken += snapshot.absorbed[i]!;
  }
  return snapshot.inputJoules - (snapshot.brokenStrengthSum + unbroken + snapshot.dissipatedJoules);
}

export class FractureSolver implements FixedStepSim<FractureSolverSnapshot> {
  readonly #plan: PreFracturePlan;
  readonly #config: FracturePropagationConfig;
  /** piece → 触接连接 id(升序)。 */
  readonly #touching: number[][];
  readonly #absorbed: Float64Array;
  readonly #broken: Uint8Array;
  readonly #queued: ImpactInput[] = [];
  readonly #breakEvents: FractureBreakEvent[] = [];
  readonly #activationEvents: FragmentActivationEvent[] = [];
  readonly #detached: Uint8Array;
  #inputJoules = 0;
  #dissipatedJoules = 0;
  #brokenStrengthSum = 0;
  #tick = 0;

  constructor(plan: PreFracturePlan, config: FracturePropagationConfig) {
    if (!(config.propagationDecay >= 0) || config.propagationDecay > 1) {
      throw new Error(`FractureSolver: propagationDecay must be in [0, 1], got ${config.propagationDecay}.`);
    }
    if (!Number.isSafeInteger(config.maxHops) || config.maxHops < 1) {
      throw new Error(`FractureSolver: maxHops must be an integer >= 1, got ${config.maxHops}.`);
    }
    this.#plan = plan;
    this.#config = config;
    this.#absorbed = new Float64Array(plan.connections.length);
    this.#broken = new Uint8Array(plan.connections.length);
    this.#touching = plan.pieces.map(() => [] as number[]);
    plan.connections.forEach((conn, id) => {
      this.#touching[conn.pieceA]!.push(id);
      this.#touching[conn.pieceB]!.push(id);
    });
    this.#detached = new Uint8Array(plan.pieces.length);
  }

  get tick(): number { return this.#tick; }
  get breakEvents(): readonly FractureBreakEvent[] { return this.#breakEvents; }
  get activationEvents(): readonly FragmentActivationEvent[] { return this.#activationEvents; }
  get dissipatedJoules(): number { return this.#dissipatedJoules; }

  isBroken(connectionId: number): boolean { return this.#broken[connectionId] === 1; }
  absorbedJoules(connectionId: number): number { return this.#absorbed[connectionId]!; }

  /** 已脱离(产出过激活事件)的 piece id 升序。 */
  detachedPieces(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.#detached.length; i += 1) if (this.#detached[i] === 1) out.push(i);
    return out;
  }

  /** 排队一次冲击(step 时按入队序处理);能量与定位守卫在此前置校验。 */
  queueImpact(impact: ImpactInput): void {
    if (!Number.isFinite(impact.energyJoules) || impact.energyJoules < 0) {
      throw new Error(`FractureSolver: impact energy must be finite >= 0, got ${impact.energyJoules}.`);
    }
    resolveImpactPiece(this.#plan, impact); // 定位校验前置,坏输入不入队。
    this.#queued.push(impact);
  }

  step(): void {
    const queue = this.#queued.splice(0, this.#queued.length);
    for (const impact of queue) {
      this.#inputJoules += impact.energyJoules;
      const origin = resolveImpactPiece(this.#plan, impact);
      this.#propagateFrom(this.#entryConnection(origin), impact.energyJoules, 0, origin);
    }
    this.#tick += 1;
    assertFinite([this.#inputJoules, this.#dissipatedJoules], "fractureSolver");
  }

  /** 起裂连接:命中 piece 触接连接中最弱者(平局取 id 小);全部已断返回 −1。 */
  #entryConnection(piece: number): number {
    let best = -1;
    let bestStrength = Number.POSITIVE_INFINITY;
    for (const id of this.#touching[piece]!) {
      const strength = this.#plan.connections[id]!.strengthJoules;
      if (strength < bestStrength - 1e-15 || (strength <= bestStrength + 1e-15 && (best < 0 || id < best))) {
        best = id;
        bestStrength = Math.min(strength, bestStrength);
      }
    }
    return best;
  }

  /** 残差传播主循环:断裂 → 邻接均分(带衰减)→ 层序推进;队列序即事件序。 */
  #propagateFrom(entryConnectionId: number, energyJoules: number, entryHop: number, originPiece: number): void {
    const queue: Array<{ conn: number; energy: number; hop: number }> =
      entryConnectionId >= 0 ? [{ conn: entryConnectionId, energy: energyJoules, hop: entryHop }] : [];
    if (entryConnectionId < 0) this.#dissipatedJoules += energyJoules; // 命中完全碎离的 piece。
    for (let head = 0; head < queue.length; head += 1) {
      const { conn, energy, hop } = queue[head]!;
      if (this.#broken[conn] === 1) { this.#dissipatedJoules += energy; continue; }
      const strength = this.#plan.connections[conn]!.strengthJoules;
      const space = Math.max(0, strength - this.#absorbed[conn]!);
      const inc = Math.min(energy, space);
      this.#absorbed[conn] = this.#absorbed[conn]! + inc;
      const flow = energy - inc;
      if (this.#absorbed[conn]! < strength - 1e-12) continue; // 未断,能量储存。
      this.#broken[conn] = 1;
      this.#brokenStrengthSum += strength;
      const planConn = this.#plan.connections[conn]!;
      const event: FractureBreakEvent = {
        connectionId: conn, pieceA: planConn.pieceA, pieceB: planConn.pieceB,
        absorbedJoules: strength, hop, residualJoules: flow,
      };
      this.#breakEvents.push(event);
      this.#emitActivations(originPiece, conn);
      const neighbors = this.#intactNeighbors(planConn.pieceA, planConn.pieceB, conn);
      const nextHop = hop + 1;
      if (neighbors.length === 0 || nextHop >= this.#config.maxHops) {
        this.#dissipatedJoules += flow;
        continue;
      }
      const share = (flow * this.#config.propagationDecay) / neighbors.length;
      this.#dissipatedJoules += flow * (1 - this.#config.propagationDecay);
      for (const n of neighbors) queue.push({ conn: n, energy: share, hop: nextHop });
    }
  }

  /** 断裂后的连通性分离:保留侧 = 含冲击源分量;其余分量按最小 id 逐组激活。 */
  #emitActivations(originPiece: number, viaConnectionId: number): void {
    const kept = this.#component(originPiece);
    const groups: number[][] = [];
    for (let p = 0; p < this.#plan.pieces.length; p += 1) {
      if (kept[p] === 1 || this.#detached[p] === 1) continue;
      const comp = this.#component(p);
      const group: number[] = [];
      for (let q = 0; q < comp.length; q += 1) {
        if (comp[q] === 1 && this.#detached[q] === 0) { group.push(q); this.#detached[q] = 1; }
      }
      if (group.length > 0) groups.push(group);
    }
    groups.sort((g, h) => g[0]! - h[0]!);
    for (const group of groups) this.#activationEvents.push({ pieces: group, viaConnectionId });
  }

  /** 仅沿未断连接的 BFS 分量(布尔表)。 */
  #component(seed: number): Uint8Array {
    const seen = new Uint8Array(this.#plan.pieces.length);
    const stack = [seed];
    seen[seed] = 1;
    while (stack.length > 0) {
      const p = stack.pop()!;
      for (const connId of this.#touching[p]!) {
        if (this.#broken[connId] === 1) continue;
        const c = this.#plan.connections[connId]!;
        const other = c.pieceA === p ? c.pieceB : c.pieceA;
        if (seen[other] === 0) { seen[other] = 1; stack.push(other); }
      }
    }
    return seen;
  }

  #intactNeighbors(pieceA: number, pieceB: number, self: number): number[] {
    const out: number[] = [];
    for (const p of [pieceA, pieceB]) {
      for (const id of this.#touching[p]!) {
        if (id === self || this.#broken[id] === 1) continue;
        if (!out.includes(id)) out.push(id);
      }
    }
    return out.sort((a, b) => a - b);
  }

  state(): FractureSolverSnapshot {
    return {
      tick: this.#tick,
      absorbed: [...this.#absorbed],
      broken: [...this.#broken],
      queued: this.#queued.map((q) => ({ ...q })),
      breakEvents: this.#breakEvents.map((e) => ({ ...e })),
      activationEvents: this.#activationEvents.map((e) => ({ ...e, pieces: [...e.pieces] })),
      inputJoules: this.#inputJoules,
      dissipatedJoules: this.#dissipatedJoules,
      brokenStrengthSum: this.#brokenStrengthSum,
    };
  }

  capture(): FractureSolverSnapshot { return this.state(); }

  restore(snapshot: FractureSolverSnapshot): void {
    this.#absorbed.set(snapshot.absorbed);
    this.#broken.set(snapshot.broken);
    this.#queued.length = 0;
    this.#queued.push(...snapshot.queued.map((q) => ({ ...q })));
    this.#breakEvents.length = 0;
    this.#breakEvents.push(...snapshot.breakEvents.map((e) => ({ ...e })));
    this.#activationEvents.length = 0;
    this.#activationEvents.push(...snapshot.activationEvents.map((e) => ({ ...e, pieces: [...e.pieces] })));
    this.#inputJoules = snapshot.inputJoules;
    this.#dissipatedJoules = snapshot.dissipatedJoules;
    this.#brokenStrengthSum = snapshot.brokenStrengthSum;
    this.#tick = snapshot.tick;
    this.#detached.fill(0);
    for (const event of this.#activationEvents) {
      for (const p of event.pieces) this.#detached[p] = 1;
    }
  }

  /** 回放证据指纹(absorbed + 断裂/激活事件位模式)。 */
  fingerprint(): string {
    const flat: number[] = [...this.#absorbed, this.#inputJoules, this.#dissipatedJoules, this.#brokenStrengthSum];
    for (const e of this.#breakEvents) flat.push(e.connectionId, e.hop, e.residualJoules);
    for (const e of this.#activationEvents) for (const p of e.pieces) flat.push(p);
    return fingerprintFloat64(flat);
  }
}
