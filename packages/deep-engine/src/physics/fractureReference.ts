/**
 * T18 切片 1:预破碎数学准备(数据结构 + 确定性生成 + 断裂簿记)。
 *
 * 如实声明:本切片只交付破碎的"预"部分——分割体(胞元)、内部连接面/连接强度、
 * 断裂事件簿记与质量/动量守恒辅助;冲击求解、碎块刚体化与 Rapier 桥接是后续
 * 子任务(主计划:破碎质量/动量误差按模型容差记录)。
 *
 * 确定性:切割面位置与连接强度由 seed 派生的 mulberry 流按 (轴, 层, 胞元) 固定序
 * 生成;同 seed 逐位一致,不同 seed 统计独立。连接断裂判据(本切片,有界):
 * 连接面累计吸收冲击能量 ≥ strengthJoules 即断裂,事件幂等(重复冲击不重复断裂)。
 */
import { assertFinite, type Vec3 } from "./physicsTypes.js";

export interface FractureBoxSpec {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly divisions: readonly [number, number, number];
  /** 切割面位置抖动比例 [0, 0.5)(相对胞元厚度)。 */
  readonly jitter: number;
  readonly seed: number;
  /** 密度(kg/m³),piece.mass = volume × density。 */
  readonly density: number;
  /** 连接韧度范围(J/m²),strengthJoules = area × cohesion。 */
  readonly cohesionMin: number;
  readonly cohesionMax: number;
}

export interface FracturePiece {
  readonly id: number;
  readonly aabbMin: Vec3;
  readonly aabbMax: Vec3;
  readonly volume: number;
  readonly mass: number;
}

export interface FractureConnection {
  readonly id: number;
  readonly pieceA: number;
  readonly pieceB: number;
  /** 共享面面积(m²)。 */
  readonly area: number;
  /** 断裂所需吸收能量(J)= area × cohesion。 */
  readonly strengthJoules: number;
}

export interface PreFracturePlan {
  readonly pieces: readonly FracturePiece[];
  readonly connections: readonly FractureConnection[];
}

function mulberry(seed: number): () => number {
  let s = (seed | 0) + 0x9e3779b9 | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 确定性预破碎计划:网格胞元 + 抖动切割面 + 内部连接(强度 = 面积 × 韧度)。 */
export function buildPreFracture(spec: FractureBoxSpec): PreFracturePlan {
  const [nx, ny, nz] = spec.divisions;
  if (![nx, ny, nz].every((d) => Number.isSafeInteger(d) && d >= 1)) throw new Error(`buildPreFracture: divisions must be integers >= 1, got ${spec.divisions.join("x")}.`);
  if (!spec.min.every(Number.isFinite) || !spec.max.every(Number.isFinite)) throw new Error("buildPreFracture: bounds must be finite.");
  if ([0, 1, 2].some((a) => spec.max[a]! <= spec.min[a]!)) throw new Error("buildPreFracture: max must be > min on every axis.");
  if (!(spec.jitter >= 0) || spec.jitter >= 0.5) throw new Error(`buildPreFracture: jitter must be in [0, 0.5), got ${spec.jitter}.`);
  if (!(spec.density > 0) || !(spec.cohesionMax >= spec.cohesionMin) || !(spec.cohesionMin >= 0)) {
    throw new Error("buildPreFracture: density must be > 0 and cohesion range must satisfy 0 <= min <= max.");
  }
  const rng = mulberry(spec.seed);
  const min = spec.min; const max = spec.max;
  const span = [max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!];
  const div = [nx, ny, nz];
  // 每轴切割面:内层界面 = base + 抖动(±0.25·厚度,保证界面单调不交叉)。
  const cuts: Float64Array[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const c = new Float64Array(div[axis]! + 1);
    const step = span[axis]! / div[axis]!;
    c[0] = min[axis]!;
    for (let i = 1; i < div[axis]!; i += 1) {
      c[i] = min[axis]! + ((i + (rng() - 0.5) * spec.jitter) * step);
    }
    c[div[axis]!] = max[axis]!;
    cuts.push(c);
  }
  const pieces: FracturePiece[] = [];
  const volumeAt = (ix: number, iy: number, iz: number): number =>
    (cuts[0]![ix + 1]! - cuts[0]![ix]!) * (cuts[1]![iy + 1]! - cuts[1]![iy]!) * (cuts[2]![iz + 1]! - cuts[2]![iz]!);
  for (let iz = 0; iz < nz; iz += 1) {
    for (let iy = 0; iy < ny; iy += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        const id = pieces.length;
        const volume = volumeAt(ix, iy, iz);
        pieces.push({
          id,
          aabbMin: [cuts[0]![ix]!, cuts[1]![iy]!, cuts[2]![iz]!],
          aabbMax: [cuts[0]![ix + 1]!, cuts[1]![iy + 1]!, cuts[2]![iz + 1]!],
          volume,
          mass: volume * spec.density,
        });
      }
    }
  }
  const idx = (ix: number, iy: number, iz: number): number => (iz * ny + iy) * nx + ix;
  const connections: FractureConnection[] = [];
  // 连接面:每胞元向 +x/+y/+z 邻居各建一条;面积 = 共享面面积;强度 = 面积 × 韧度。
  const faceSpan = (axis: number, ix: number, iy: number, iz: number): number => {
    if (axis === 0) return (cuts[1]![iy + 1]! - cuts[1]![iy]!) * (cuts[2]![iz + 1]! - cuts[2]![iz]!);
    if (axis === 1) return (cuts[0]![ix + 1]! - cuts[0]![ix]!) * (cuts[2]![iz + 1]! - cuts[2]![iz]!);
    return (cuts[0]![ix + 1]! - cuts[0]![ix]!) * (cuts[1]![iy + 1]! - cuts[1]![iy]!);
  };
  for (let iz = 0; iz < nz; iz += 1) {
    for (let iy = 0; iy < ny; iy += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        const candidates: Array<[number, number, number, number]> = [
          [0, ix + 1, iy, iz], [1, ix, iy + 1, iz], [2, ix, iy, iz + 1],
        ];
        for (const [axis, jx, jy, jz] of candidates) {
          if (jx >= nx || jy >= ny || jz >= nz) continue;
          const area = faceSpan(axis, ix, iy, iz);
          const cohesion = spec.cohesionMin + (spec.cohesionMax - spec.cohesionMin) * rng();
          connections.push({ id: connections.length, pieceA: idx(ix, iy, iz), pieceB: idx(jx, jy, jz), area, strengthJoules: area * cohesion });
        }
      }
    }
  }
  return { pieces, connections };
}

/** 计划质量守恒:Σpiece.mass − Σvolume×density 的闭式核对(容差内恒 0)。 */
export function planTotalMass(plan: PreFracturePlan): number {
  return plan.pieces.reduce((sum, p) => sum + p.mass, 0);
}

export interface FractureEvent {
  readonly connectionId: number;
  readonly pieceA: number;
  readonly pieceB: number;
  /** 断裂时的累计吸收能量(J)。 */
  readonly absorbedJoules: number;
}

/** 断裂簿记:能量判据 + 幂等事件;冲击动量拆分辅助(总动量守恒)。 */
export class FractureLedger {
  readonly #plan: PreFracturePlan;
  readonly #absorbed: Float64Array;
  readonly #broken: Uint8Array;
  readonly #events: FractureEvent[] = [];

  constructor(plan: PreFracturePlan) {
    this.#plan = plan;
    this.#absorbed = new Float64Array(plan.connections.length);
    this.#broken = new Uint8Array(plan.connections.length);
  }

  get intactCount(): number {
    return this.#plan.connections.length - this.#events.length;
  }

  get events(): readonly FractureEvent[] {
    return this.#events;
  }

  isBroken(connectionId: number): boolean {
    return this.#broken[connectionId] === 1;
  }

  /** 冲击累计;吸收 ≥ 强度即断裂。已断裂连接幂等返回 null。 */
  applyImpact(connectionId: number, energyJoules: number): FractureEvent | null {
    if (!Number.isSafeInteger(connectionId) || connectionId < 0 || connectionId >= this.#plan.connections.length) {
      throw new Error(`FractureLedger: connectionId ${connectionId} out of range.`);
    }
    if (!Number.isFinite(energyJoules) || energyJoules < 0) throw new Error(`FractureLedger: energy must be finite >= 0, got ${energyJoules}.`);
    if (this.#broken[connectionId] === 1) return null;
    this.#absorbed[connectionId] = this.#absorbed[connectionId]! + energyJoules;
    const conn = this.#plan.connections[connectionId]!;
    if (this.#absorbed[connectionId]! < conn.strengthJoules) return null;
    this.#broken[connectionId] = 1;
    const event: FractureEvent = { connectionId, pieceA: conn.pieceA, pieceB: conn.pieceB, absorbedJoules: this.#absorbed[connectionId]! };
    this.#events.push(event);
    return event;
  }

  /** 断裂冲量拆分参考约定:传递冲量 J 记为 A 得 +J、B 得 −J(总动量守恒)。 */
  breakImpulseDeltas(connectionId: number, impulse: Vec3): { deltaA: Vec3; deltaB: Vec3 } {
    if (!impulse.every(Number.isFinite)) throw new Error("FractureLedger: impulse must be finite.");
    return { deltaA: [...impulse] as Vec3, deltaB: [-impulse[0], -impulse[1], -impulse[2]] as Vec3 };
  }
}

/** 动量守恒哨兵:断裂事件对的动量增量之和应为零向量。 */
export function momentumResidual(deltas: ReadonlyArray<{ deltaA: Vec3; deltaB: Vec3 }>): Vec3 {
  const r: [number, number, number] = [0, 0, 0];
  for (const { deltaA, deltaB } of deltas) {
    r[0] += deltaA[0] + deltaB[0]; r[1] += deltaA[1] + deltaB[1]; r[2] += deltaA[2] + deltaB[2];
  }
  assertFinite(r, "momentum");
  return r;
}
