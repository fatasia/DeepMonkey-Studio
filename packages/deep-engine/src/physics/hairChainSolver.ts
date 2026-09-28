/**
 * T18 切片 1:毛发链 CPU 参考求解器(链式距离约束 + 弯曲限制)。
 *
 * 范围与如实声明:单链根到梢的约束求解 + 重力 + 阻尼衰减;碰撞、毛囊/头皮
 * 分布、Rapier 与渲染接线留后续子任务。弯曲限制是不等式约束:相邻第二邻居
 * 距离 d ≥ dmin = √(l1²+l2²−2·l1·l2·cos(θmax)),只在违反时投影(XPBD 单边)。
 * 每子步按 根→梢 固定序各过一遍段约束与弯曲约束(Gauss-Seidel 序,确定性)。
 * 初始扰动由 seed 派生的 mulberry 流按(链, 粒子)固定序注入。
 */
import { assertFinite, type FixedStepSim, type Vec3 } from "./physicsTypes.js";

export interface HairChainSpec {
  /** 链根(毛囊)世界坐标,恒为锚点。 */
  readonly origin: Vec3;
  /** 初始伸展方向(单位化由构造器完成)。 */
  readonly direction: Vec3;
  /** 段数(粒子数 = segments+1),≥1。 */
  readonly segments: number;
  readonly linkLength: number;
}

export interface HairChainSolverConfig {
  readonly chains: readonly HairChainSpec[];
  /** 弯曲上限(弧度,(0,π];π = 不限弯)。 */
  readonly maxBendAngle: number;
  readonly mass: number;
  readonly gravity: Vec3;
  readonly dtSeconds: number;
  readonly substeps: number;
  /** 每子步线性速度阻尼系数 [0,1)——末端摆动衰减的来源。 */
  readonly damping: number;
  /** seed 驱动的初始速度扰动幅度(m/s),≥0。 */
  readonly perturbation: number;
  readonly seed: number;
  readonly compliance: number;
}

export interface HairSnapshot {
  readonly tick: number;
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly vz: Float64Array;
}

export class HairChainSolver implements FixedStepSim<HairSnapshot> {
  readonly #cfg: HairChainSolverConfig;
  readonly #chainOffsets: Int32Array;
  readonly #chainSizes: Int32Array;
  readonly #count: number;
  readonly #px: Float64Array;
  readonly #py: Float64Array;
  readonly #pz: Float64Array;
  readonly #vx: Float64Array;
  readonly #vy: Float64Array;
  readonly #vz: Float64Array;
  readonly #invMass: Float64Array;
  readonly #qx: Float64Array;
  readonly #qy: Float64Array;
  readonly #qz: Float64Array;
  /** 全部段约束与弯曲约束(跨链拼接,构建序固定)。 */
  readonly #segA: Int32Array;
  readonly #segRest: Float64Array;
  readonly #bendA: Int32Array;
  readonly #bendRest: Float64Array;
  readonly #lambdaSeg: Float64Array;
  readonly #lambdaBend: Float64Array;
  #tick = 0;

  constructor(config: HairChainSolverConfig) {
    if (!Array.isArray(config.chains) || config.chains.length === 0) throw new Error("HairChainSolver: chains must be a non-empty array.");
    if (!(config.maxBendAngle > 0) || config.maxBendAngle > Math.PI) throw new Error(`HairChainSolver: maxBendAngle must be in (0, π], got ${config.maxBendAngle}.`);
    if (!(config.mass > 0) || !(config.dtSeconds > 0) || !Number.isSafeInteger(config.substeps) || config.substeps < 1) {
      throw new Error("HairChainSolver: mass/dtSeconds must be positive and substeps an integer >= 1.");
    }
    if (!(config.damping >= 0) || config.damping >= 1 || !(config.perturbation >= 0)) {
      throw new Error("HairChainSolver: damping must be in [0,1) and perturbation >= 0.");
    }
    if (!config.gravity.every(Number.isFinite)) throw new Error("HairChainSolver: gravity must be finite.");
    this.#cfg = config;
    this.#chainOffsets = new Int32Array(config.chains.length);
    this.#chainSizes = new Int32Array(config.chains.length);
    let total = 0; let segTotal = 0; let bendTotal = 0;
    for (let c = 0; c < config.chains.length; c += 1) {
      const spec = config.chains[c]!;
      if (!Number.isSafeInteger(spec.segments) || spec.segments < 1) throw new Error(`HairChainSolver: chain ${c} segments must be an integer >= 1, got ${spec.segments}.`);
      if (!(spec.linkLength > 0)) throw new Error(`HairChainSolver: chain ${c} linkLength must be positive.`);
      if (!spec.origin.every(Number.isFinite) || !spec.direction.every(Number.isFinite)) throw new Error(`HairChainSolver: chain ${c} origin/direction must be finite.`);
      const len = Math.hypot(spec.direction[0], spec.direction[1], spec.direction[2]);
      if (len === 0) throw new Error(`HairChainSolver: chain ${c} direction must be non-zero.`);
      this.#chainOffsets[c] = total;
      this.#chainSizes[c] = spec.segments + 1;
      total += spec.segments + 1;
      segTotal += spec.segments;
      bendTotal += spec.segments >= 2 ? spec.segments - 1 : 0;
    }
    this.#count = total;
    this.#px = new Float64Array(total); this.#py = new Float64Array(total); this.#pz = new Float64Array(total);
    this.#vx = new Float64Array(total); this.#vy = new Float64Array(total); this.#vz = new Float64Array(total);
    this.#qx = new Float64Array(total); this.#qy = new Float64Array(total); this.#qz = new Float64Array(total);
    this.#invMass = new Float64Array(total).fill(1 / config.mass);
    // 布局:链沿 direction 直线展开;根锚定;扰动按(链, 粒子)固定序注入速度。
    let s = (config.seed | 0) + 0x9e3779b9 | 0;
    const nextUnit = (): number => {
      s = (s + 0x6d2b79f5) | 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let c = 0; c < config.chains.length; c += 1) {
      const spec = config.chains[c]!;
      const len = Math.hypot(spec.direction[0], spec.direction[1], spec.direction[2]);
      const dx = spec.direction[0] / len; const dy = spec.direction[1] / len; const dz = spec.direction[2] / len;
      for (let i = 0; i <= spec.segments; i += 1) {
        const p = this.#chainOffsets[c]! + i;
        this.#px[p] = spec.origin[0] + dx * i * spec.linkLength;
        this.#py[p] = spec.origin[1] + dy * i * spec.linkLength;
        this.#pz[p] = spec.origin[2] + dz * i * spec.linkLength;
        if (config.perturbation > 0 && i > 0) {
          this.#vx[p] = (nextUnit() - 0.5) * 2 * config.perturbation;
          this.#vy[p] = (nextUnit() - 0.5) * 2 * config.perturbation;
          this.#vz[p] = (nextUnit() - 0.5) * 2 * config.perturbation;
        }
      }
      this.#invMass[this.#chainOffsets[c]!] = 0;
    }
    this.#segA = new Int32Array(segTotal); this.#segRest = new Float64Array(segTotal);
    this.#bendA = new Int32Array(bendTotal); this.#bendRest = new Float64Array(bendTotal);
    this.#lambdaSeg = new Float64Array(segTotal); this.#lambdaBend = new Float64Array(bendTotal);
    let si = 0; let bi = 0;
    for (let c = 0; c < config.chains.length; c += 1) {
      const spec = config.chains[c]!;
      const base = this.#chainOffsets[c]!;
      for (let i = 0; i < spec.segments; i += 1) { this.#segA[si] = base + i; this.#segRest[si] = spec.linkLength; si += 1; }
      // 弯曲限制 rest = dmin(等长链 = 2l·sin(θmax/2));不等式,违反才投影。
      const dmin = Math.sqrt(2 * spec.linkLength * spec.linkLength * (1 - Math.cos(config.maxBendAngle)));
      for (let i = 0; i + 2 <= spec.segments; i += 1) { this.#bendA[bi] = base + i; this.#bendRest[bi] = dmin; bi += 1; }
    }
  }

  get tick(): number { return this.#tick; }
  get chainCount(): number { return this.#chainSizes.length; }
  tipIndex(chain: number): number { return this.#chainOffsets[chain]! + this.#chainSizes[chain]! - 1; }
  tipPosition(chain: number): Vec3 {
    const i = this.tipIndex(chain);
    return [this.#px[i]!, this.#py[i]!, this.#pz[i]!];
  }
  tipSpeed(chain: number): number {
    const i = this.tipIndex(chain);
    return Math.hypot(this.#vx[i]!, this.#vy[i]!, this.#vz[i]!);
  }

  /** 段长误差统计(全链,验收:|len−rest|/rest ≤ 5%)。 */
  measureSegmentStretch(): { maxRatio: number; meanRatio: number } {
    let max = 0; let sum = 0;
    for (let k = 0; k < this.#segRest.length; k += 1) {
      const a = this.#segA[k]!; const rest = this.#segRest[k]!;
      const d = Math.hypot(this.#px[a]! - this.#px[a + 1]!, this.#py[a]! - this.#py[a + 1]!, this.#pz[a]! - this.#pz[a + 1]!);
      const ratio = Math.abs(d - rest) / rest;
      if (ratio > max) max = ratio;
      sum += ratio;
    }
    return { maxRatio: max, meanRatio: sum / this.#segRest.length };
  }

  step(): void {
    const c = this.#cfg;
    const h = c.dtSeconds / c.substeps;
    const dampingScale = 1 - c.damping * h;
    const alphaTilde = c.compliance / (h * h);
    const px = this.#px; const py = this.#py; const pz = this.#pz;
    const vx = this.#vx; const vy = this.#vy; const vz = this.#vz;
    const qx = this.#qx; const qy = this.#qy; const qz = this.#qz;
    const invMass = this.#invMass;
    for (let sub = 0; sub < c.substeps; sub += 1) {
      this.#qx.set(this.#px); this.#qy.set(this.#py); this.#qz.set(this.#pz);
      for (let i = 0; i < this.#count; i += 1) {
        if (invMass[i] === 0) continue;
        vx[i] = (vx[i]! + c.gravity[0] * h) * dampingScale;
        vy[i] = (vy[i]! + c.gravity[1] * h) * dampingScale;
        vz[i] = (vz[i]! + c.gravity[2] * h) * dampingScale;
        px[i] = px[i]! + vx[i]! * h; py[i] = py[i]! + vy[i]! * h; pz[i] = pz[i]! + vz[i]! * h;
      }
      this.#lambdaSeg.fill(0); this.#lambdaBend.fill(0);
      for (let k = 0; k < this.#segRest.length; k += 1) this.#projectPair(this.#segA[k]!, this.#segA[k]! + 1, this.#segRest[k]!, alphaTilde, this.#lambdaSeg, k, false);
      for (let k = 0; k < this.#bendRest.length; k += 1) this.#projectPair(this.#bendA[k]!, this.#bendA[k]! + 2, this.#bendRest[k]!, alphaTilde, this.#lambdaBend, k, true);
      const invH = 1 / h;
      for (let i = 0; i < this.#count; i += 1) {
        if (invMass[i] === 0) { vx[i] = 0; vy[i] = 0; vz[i] = 0; continue; }
        vx[i] = (px[i]! - qx[i]!) * invH;
        vy[i] = (py[i]! - qy[i]!) * invH;
        vz[i] = (pz[i]! - qz[i]!) * invH;
      }
    }
    this.#tick += 1;
    assertFinite(this.#px, "hair.px"); assertFinite(this.#py, "hair.py"); assertFinite(this.#pz, "hair.pz");
  }

  /** Gauss-Seidel 距离投影;inequality=true 时仅 len < rest(弯折超限)才作用。 */
  #projectPair(a: number, b: number, rest: number, alphaTilde: number, lambda: Float64Array, slot: number, inequality: boolean): void {
    const wa = this.#invMass[a]!; const wb = this.#invMass[b]!;
    const denom = wa + wb;
    if (denom === 0) return;
    const dx = this.#px[a]! - this.#px[b]!; const dy = this.#py[a]! - this.#py[b]!; const dz = this.#pz[a]! - this.#pz[b]!;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len === 0) return;
    if (inequality && len >= rest) { lambda[slot] = 0; return; }
    const l = (rest - len - alphaTilde * lambda[slot]!) / (denom + alphaTilde);
    lambda[slot] = inequality ? Math.max(0, l) : l;
    const applied = lambda[slot]!;
    const nx = dx / len; const ny = dy / len; const nz = dz / len;
    this.#px[a] = this.#px[a]! + wa * applied * nx; this.#py[a] = this.#py[a]! + wa * applied * ny; this.#pz[a] = this.#pz[a]! + wa * applied * nz;
    this.#px[b] = this.#px[b]! - wb * applied * nx; this.#py[b] = this.#py[b]! - wb * applied * ny; this.#pz[b] = this.#pz[b]! - wb * applied * nz;
  }

  capture(): HairSnapshot {
    return {
      tick: this.#tick,
      px: new Float64Array(this.#px), py: new Float64Array(this.#py), pz: new Float64Array(this.#pz),
      vx: new Float64Array(this.#vx), vy: new Float64Array(this.#vy), vz: new Float64Array(this.#vz),
    };
  }

  restore(snapshot: HairSnapshot): void {
    this.#px.set(snapshot.px); this.#py.set(snapshot.py); this.#pz.set(snapshot.pz);
    this.#vx.set(snapshot.vx); this.#vy.set(snapshot.vy); this.#vz.set(snapshot.vz);
    this.#tick = snapshot.tick;
  }
}
