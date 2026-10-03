/**
 * T18 切片 1:布料 CPU 参考求解器(XPBD 距离约束,固定步长)。
 *
 * 范围与如实声明:本切片只做约束求解 + 重力 + 确定性风 + 锚点;
 * 碰撞/自碰撞/Rapier 接线/渲染消费是后续子任务(主计划"单个演示不关闭整个工作包")。
 *
 * XPBD(Macklin et al. 2016):每个固定步拆 substeps 个子步,每子步 1 次约束投影;
 * compliance=0 时退化为刚性距离约束。全部 f64,粒子/约束按构建序遍历,无随机源。
 * 约束静止长度由网格间距解析给出,不受 seed 初始扰动污染。
 * 风场是 (t, y) 的纯函数:复用 terrain 确定性 value noise,同 seed 逐位一致。
 *
 * sourceSizeGate 拆分(2026-10-03):合同类型(ClothWind/ClothSolverConfig/ClothSnapshot/
 * StretchStats)与 WIND_NOISE_SALT 移至 clothSolverContract.ts,代码逐行同源仅改可见性,
 * 语义零变化;本文件原样再导出合同面,消费方导入路径不变。
 */
import { createValueNoise2D } from "../terrain/terrainRandom.js";
import { createClothSelfCollision, type ClothSelfCollisionResolver } from "./clothSelfCollision.js";
import { assertFinite, type FixedStepSim, type Vec3 } from "./physicsTypes.js";
import { WIND_NOISE_SALT, type ClothSolverConfig, type ClothSnapshot, type StretchStats } from "./clothSolverContract.js";

export { WIND_NOISE_SALT };
export type { ClothSolverConfig, ClothSnapshot, StretchStats };
export type { ClothWind } from "./clothSolverContract.js";

export class ClothSolver implements FixedStepSim<ClothSnapshot> {
  readonly #cfg: ClothSolverConfig;
  readonly #count: number;
  readonly #px: Float64Array;
  readonly #py: Float64Array;
  readonly #pz: Float64Array;
  readonly #vx: Float64Array;
  readonly #vy: Float64Array;
  readonly #vz: Float64Array;
  readonly #invMass: Float64Array;
  /** 子步起点位置(q = p_prev),速度回算 v = (p − q)/h。 */
  readonly #qx: Float64Array;
  readonly #qy: Float64Array;
  readonly #qz: Float64Array;
  /** 约束端点与解析静止长度;构建顺序 (row,col) 固定,遍历序即确定性序。 */
  readonly #ca: Int32Array;
  readonly #cb: Int32Array;
  readonly #rest: Float64Array;
  readonly #lambda: Float64Array;
  readonly #noise: (x: number, z: number) => number;
  readonly #selfCollision: ClothSelfCollisionResolver | null;
  #tick = 0;

  constructor(config: ClothSolverConfig) {
    const c = config;
    if (!Number.isSafeInteger(c.columns) || c.columns < 2 || !Number.isSafeInteger(c.rows) || c.rows < 2) {
      throw new Error(`ClothSolver: columns/rows must be integers >= 2, got ${c.columns}x${c.rows}.`);
    }
    if (!(c.spacing > 0) || !(c.mass > 0) || !(c.dtSeconds > 0) || !Number.isFinite(c.dtSeconds)) {
      throw new Error("ClothSolver: spacing, mass and dtSeconds must be positive finite numbers.");
    }
    if (!Number.isSafeInteger(c.substeps) || c.substeps < 1) throw new Error(`ClothSolver: substeps must be an integer >= 1, got ${c.substeps}.`);
    if (!(c.compliance >= 0) || !(c.damping >= 0) || c.damping >= 1 || !(c.perturbation >= 0)) {
      throw new Error("ClothSolver: compliance/perturbation must be >= 0 and damping in [0,1).");
    }
    if (!c.gravity.every(Number.isFinite)) throw new Error("ClothSolver: gravity must be finite.");
    this.#cfg = c;
    if (c.selfCollisionRadius !== undefined) {
      const r = c.selfCollisionRadius;
      if (!(r > 0) || !Number.isFinite(r) || 2 * r > c.spacing) {
        throw new Error(`ClothSolver: selfCollisionRadius must be positive finite with 2r <= spacing (${c.spacing}), got ${r}.`);
      }
      this.#selfCollision = createClothSelfCollision({ count: c.columns * c.rows, radius: r });
    } else {
      this.#selfCollision = null;
    }
    this.#count = c.columns * c.rows;
    const n = this.#count;
    this.#px = new Float64Array(n); this.#py = new Float64Array(n); this.#pz = new Float64Array(n);
    this.#vx = new Float64Array(n); this.#vy = new Float64Array(n); this.#vz = new Float64Array(n);
    this.#qx = new Float64Array(n); this.#qy = new Float64Array(n); this.#qz = new Float64Array(n);
    this.#invMass = new Float64Array(n).fill(1 / c.mass);
    this.#noise = createValueNoise2D((c.seed ^ WIND_NOISE_SALT) | 0);
    // 初始布局:XY 平面旗帜(y 向上);扰动由 mulberry 流按 (row,col) 固定序注入 z。
    let s = (c.seed | 0) + 0x9e3779b9 | 0;
    const nextUnit = (): number => {
      s = (s + 0x6d2b79f5) | 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let r = 0; r < c.rows; r += 1) {
      for (let col = 0; col < c.columns; col += 1) {
        const i = r * c.columns + col;
        const originX = c.origin?.[0] ?? 0;
        const originY = c.origin?.[1] ?? 0;
        const originZ = c.origin?.[2] ?? 0;
        this.#px[i] = originX + col * c.spacing;
        this.#py[i] = originY + r * c.spacing;
        this.#pz[i] = originZ + (c.perturbation > 0 ? (nextUnit() - 0.5) * 2 * c.perturbation : 0);
      }
    }
    // 拓扑:结构(右/下)+ 剪切(两对角);rest 由间距解析给出,不测量扰动后的位置。
    const diag = c.spacing * Math.SQRT2;
    const pairs: Array<[number, number, number]> = [];
    for (let r = 0; r < c.rows; r += 1) {
      for (let col = 0; col < c.columns; col += 1) {
        const i = r * c.columns + col;
        if (col + 1 < c.columns) pairs.push([i, i + 1, c.spacing]);
        if (r + 1 < c.rows) pairs.push([i, i + c.columns, c.spacing]);
        if (col + 1 < c.columns && r + 1 < c.rows) {
          pairs.push([i, i + c.columns + 1, diag]);
          pairs.push([i + 1, i + c.columns, diag]);
        }
      }
    }
    this.#ca = new Int32Array(pairs.length);
    this.#cb = new Int32Array(pairs.length);
    this.#rest = new Float64Array(pairs.length);
    this.#lambda = new Float64Array(pairs.length);
    for (let k = 0; k < pairs.length; k += 1) {
      const [a, b, rest] = pairs[k]!;
      this.#ca[k] = a; this.#cb[k] = b; this.#rest[k] = rest;
    }
  }

  get tick(): number { return this.#tick; }
  get constraintCount(): number { return this.#rest.length; }
  particleIndex(col: number, row: number): number { return row * this.#cfg.columns + col; }
  /** 位置 SoA 只读引用(内部缓冲;跨帧/跨会话消费请用 capture)。 */
  positions(): Float64Array { return this.#px; }
  /** xyz 交错位置拷贝(渲染消费;F6 运行会话 readout 走此形态)。 */
  positionsInterleaved(): Float64Array {
    const out = new Float64Array(this.#count * 3);
    for (let i = 0; i < this.#count; i += 1) {
      out[i * 3] = this.#px[i]!; out[i * 3 + 1] = this.#py[i]!; out[i * 3 + 2] = this.#pz[i]!;
    }
    return out;
  }

  /** 锚点:invMass=0 且速度清零;解绑恢复单位质量。 */
  setPinned(col: number, row: number, pinned: boolean): void {
    const i = this.particleIndex(col, row);
    this.#invMass[i] = pinned ? 0 : 1 / this.#cfg.mass;
    if (pinned) { this.#vx[i] = 0; this.#vy[i] = 0; this.#vz[i] = 0; }
  }

  /** 锚点(运行包 pinned 粒子索引 = row·columns+col 直通形态)。 */
  setPinnedIndex(index: number, pinned = true): void {
    const i = Math.floor(index / this.#cfg.columns);
    this.setPinned(index - i * this.#cfg.columns, i, pinned);
  }

  isPinned(col: number, row: number): boolean {
    return this.#invMass[this.particleIndex(col, row)] === 0;
  }

  /** 拉伸误差统计(验收指标:收敛后 maxRatio ≤ 5% 目标约束长度)。 */
  measureStretch(): StretchStats {
    let max = 0; let sum = 0;
    for (let k = 0; k < this.#rest.length; k += 1) {
      const a = this.#ca[k]!; const b = this.#cb[k]!; const rest = this.#rest[k]!;
      const dx = this.#px[a]! - this.#px[b]!; const dy = this.#py[a]! - this.#py[b]!; const dz = this.#pz[a]! - this.#pz[b]!;
      const ratio = Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - rest) / rest;
      if (ratio > max) max = ratio;
      sum += ratio;
    }
    return { maxRatio: max, meanRatio: sum / this.#rest.length, constraintCount: this.#rest.length };
  }

  step(): void {
    for (let sub = 0; sub < this.#cfg.substeps; sub += 1) this.stepSubstep(sub);
    this.#tick += 1;
    assertFinite(this.#px, "cloth.px"); assertFinite(this.#py, "cloth.py"); assertFinite(this.#pz, "cloth.pz");
  }

  /** 内部缓冲只读引用(会话级跨软体互碰投影消费;调用方不得写入)。 */
  particleBuffers(): { px: Float64Array; py: Float64Array; pz: Float64Array; inverseMass: Float64Array; count: number } {
    return { px: this.#px, py: this.#py, pz: this.#pz, inverseMass: this.#invMass, count: this.#count };
  }

  /** 单子步(互碰会话的子步级编排消费);tick 计数与 finite 审计仍属 step()。
   * substep 是本 tick 内的子步序号,时间基与连续 step() 逐位一致。 */
  stepSubstep(substep: number): void {
    const c = this.#cfg;
    const h = c.dtSeconds / c.substeps;
    const t = this.#tick * c.dtSeconds + substep * h;
    const dampingScale = 1 - c.damping * h;
    const alphaTilde = c.compliance / (h * h);
    const px = this.#px; const py = this.#py; const pz = this.#pz;
    const vx = this.#vx; const vy = this.#vy; const vz = this.#vz;
    const qx = this.#qx; const qy = this.#qy; const qz = this.#qz;
    const invMass = this.#invMass;
    this.#qx.set(this.#px); this.#qy.set(this.#py); this.#qz.set(this.#pz);
    const groundY = c.groundY;
    for (let i = 0; i < this.#count; i += 1) {
      if (invMass[i] === 0) continue;
      const w = this.windAcceleration(t, py[i]!);
      vx[i] = (vx[i]! + (c.gravity[0] + w[0]) * h) * dampingScale;
      vy[i] = (vy[i]! + (c.gravity[1] + w[1]) * h) * dampingScale;
      vz[i] = (vz[i]! + (c.gravity[2] + w[2]) * h) * dampingScale;
      px[i] = px[i]! + vx[i]! * h; py[i] = py[i]! + vy[i]! * h; pz[i] = pz[i]! + vz[i]! * h;
      // 地面接触:积分后位置投影(y = groundY 钳制);速度由 (p−q)/h 回算自然
      // 消去法向分量,切向摩擦不在本切片(与运行包合同注释一致)。
      if (groundY !== undefined && py[i]! < groundY) py[i] = groundY;
    }
    c.contacts?.project(px, py, pz, invMass, c.groundY);
    this.#selfCollision?.resolve(px, py, pz, invMass);
    this.#lambda.fill(0);
    for (let k = 0; k < this.#rest.length; k += 1) this.#project(k, alphaTilde);
    // 约束投影可能把粒子再次推到地面下;速度回算前再钳制一次,
    // 保证回算出的法向速度非负(接触不吸附)。
    if (c.groundY !== undefined) {
      for (let i = 0; i < this.#count; i += 1) {
        if (this.#invMass[i] !== 0 && py[i]! < c.groundY) py[i] = c.groundY;
      }
    }
    c.contacts?.project(px, py, pz, invMass, c.groundY);
    this.#selfCollision?.resolve(px, py, pz, invMass);
    const invH = 1 / h;
    for (let i = 0; i < this.#count; i += 1) {
      if (invMass[i] === 0) { vx[i] = 0; vy[i] = 0; vz[i] = 0; continue; }
      vx[i] = (px[i]! - qx[i]!) * invH;
      vy[i] = (py[i]! - qy[i]!) * invH;
      vz[i] = (pz[i]! - qz[i]!) * invH;
    }
  }

  /** XPBD 距离约束投影:Δλ = (−C − α̃λ)/(w1+w2+α̃);Δp = Δλ·w·∇C。 */
  #project(k: number, alphaTilde: number): void {
    const a = this.#ca[k]!; const b = this.#cb[k]!;
    const wa = this.#invMass[a]!; const wb = this.#invMass[b]!;
    const denom = wa + wb;
    if (denom === 0) return;
    const dx = this.#px[a]! - this.#px[b]!; const dy = this.#py[a]! - this.#py[b]!; const dz = this.#pz[a]! - this.#pz[b]!;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len === 0) return;
    const lambda = (this.#rest[k]! - len - alphaTilde * this.#lambda[k]!) / (denom + alphaTilde);
    this.#lambda[k] = this.#lambda[k]! + lambda;
    const nx = dx / len; const ny = dy / len; const nz = dz / len;
    this.#px[a] = this.#px[a]! + wa * lambda * nx; this.#py[a] = this.#py[a]! + wa * lambda * ny; this.#pz[a] = this.#pz[a]! + wa * lambda * nz;
    this.#px[b] = this.#px[b]! - wb * lambda * nx; this.#py[b] = this.#py[b]! - wb * lambda * ny; this.#pz[b] = this.#pz[b]! - wb * lambda * nz;
  }

  windAcceleration(t: number, y: number): Vec3 {
    const w = this.#cfg.wind;
    if (!w) return [0, 0, 0];
    const speed = w.baseSpeed * (0.5 + this.#noise(t * w.gustFrequency, y * w.spatialScale));
    return [w.direction[0] * speed, w.direction[1] * speed, w.direction[2] * speed];
  }

  capture(): ClothSnapshot {
    return {
      tick: this.#tick,
      px: new Float64Array(this.#px), py: new Float64Array(this.#py), pz: new Float64Array(this.#pz),
      vx: new Float64Array(this.#vx), vy: new Float64Array(this.#vy), vz: new Float64Array(this.#vz),
    };
  }

  restore(snapshot: ClothSnapshot): void {
    this.#px.set(snapshot.px); this.#py.set(snapshot.py); this.#pz.set(snapshot.pz);
    this.#vx.set(snapshot.vx); this.#vy.set(snapshot.vy); this.#vz.set(snapshot.vz);
    this.#tick = snapshot.tick;
  }
}
