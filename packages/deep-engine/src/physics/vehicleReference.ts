/**
 * T18 切片 1:车辆悬架数学准备——1/4 车(quarter-car)解析参考 + 固定步长对照仿真。
 *
 * 如实声明:本切片交付静态悬挂解析解(平地/坡道)与单自由度对照仿真;
 * 轮胎接触模型、Rapier raycast vehicle、动力总成与整车动力学是后续子任务。
 *
 * 解析参考(独立真值,非仿真拟合):
 * - 静态下沉量(平地): x_eq = m·g / k;
 * - 坡道 θ(路面法向坐标系):法向重力 g·cosθ,下沉量 x_eq = m·g·cosθ / k;
 *   沿坡分量 m·g·sinθ 由轮胎纵向前束/驱动承担,不在本单自由度参考内(已声明);
 * - 固有频率 f = √(k/m)/(2π);阻尼比 ζ = c / (2·√(k·m))。
 * 对照仿真:半隐式欧拉固定步长,与解析解一致应在 1% 内(阻尼充分时)。
 */
import { assertFinite, type FixedStepSim } from "./physicsTypes.js";

/** 平地静态下沉量(米,压缩为正)。 */
export function staticSagM(quarterMassKg: number, springNPerM: number, gravityNormal = 9.81): number {
  if (!(quarterMassKg > 0) || !(springNPerM > 0)) throw new Error("staticSagM: mass and spring rate must be positive.");
  return (quarterMassKg * gravityNormal) / springNPerM;
}

/** 坡道法向重力分量(θ 为坡角,弧度)。 */
export function slopeNormalGravity(gravity: number, angleRad: number): number {
  if (!Number.isFinite(gravity) || !Number.isFinite(angleRad)) throw new Error("slopeNormalGravity: inputs must be finite.");
  return gravity * Math.cos(angleRad);
}

/** 悬架固有频率(Hz)。 */
export function rideFrequencyHz(quarterMassKg: number, springNPerM: number): number {
  if (!(quarterMassKg > 0) || !(springNPerM > 0)) throw new Error("rideFrequencyHz: mass and spring rate must be positive.");
  return Math.sqrt(springNPerM / quarterMassKg) / (2 * Math.PI);
}

/** 阻尼比 ζ ∈ [0,∞);<1 欠阻尼,=1 临界,>1 过阻尼(均收敛)。 */
export function dampingRatio(quarterMassKg: number, springNPerM: number, damperNsPerM: number): number {
  if (!(quarterMassKg > 0) || !(springNPerM > 0) || !(damperNsPerM >= 0)) throw new Error("dampingRatio: mass/spring must be positive and damper >= 0.");
  return damperNsPerM / (2 * Math.sqrt(springNPerM * quarterMassKg));
}

export interface QuarterCarConfig {
  readonly quarterMassKg: number;
  readonly springNPerM: number;
  readonly damperNsPerM: number;
  /** 路面法向重力(m/s²);坡道场景传入 slopeNormalGravity 的结果。 */
  readonly gravityNormal: number;
  readonly dtSeconds: number;
}

export interface RoadInput {
  /** 路面高度(m),t = tick·dtSeconds。 */
  heightAt(t: number): number;
  /** 路面竖向速率(m/s)。 */
  rateAt(t: number): number;
}

/** 平地:路面静止。 */
export const flatRoad: RoadInput = { heightAt: () => 0, rateAt: () => 0 };

/** 匀速爬坡(路面法向坐标下的恒速斜坡输入)。 */
export function rampRoad(rateMs: number): RoadInput {
  if (!Number.isFinite(rateMs)) throw new Error("rampRoad: rate must be finite.");
  return { heightAt: (t) => rateMs * t, rateAt: () => rateMs };
}

export interface QuarterCarSnapshot {
  readonly tick: number;
  /** 车身高度(路面坐标系)。 */
  readonly z: number;
  readonly v: number;
}

export class QuarterCarSim implements FixedStepSim<QuarterCarSnapshot> {
  readonly #cfg: QuarterCarConfig;
  readonly #road: RoadInput;
  #z = 0;
  #v = 0;
  #tick = 0;

  constructor(config: QuarterCarConfig, road: RoadInput = flatRoad) {
    if (!(config.quarterMassKg > 0) || !(config.springNPerM > 0) || !(config.dtSeconds > 0)) {
      throw new Error("QuarterCarSim: mass, spring rate and dt must be positive.");
    }
    if (!(config.damperNsPerM >= 0) || !Number.isFinite(config.gravityNormal)) {
      throw new Error("QuarterCarSim: damper must be >= 0 and gravity finite.");
    }
    this.#cfg = config;
    this.#road = road;
  }

  get tick(): number { return this.#tick; }
  /** 悬架压缩量(米,正 = 压缩):车身低于路面输入的部分。 */
  deflection(): number { return this.#z - this.#road.heightAt(this.#tick * this.#cfg.dtSeconds); }
  bodyHeight(): number { return this.#z; }
  bodyVelocity(): number { return this.#v; }

  step(): void {
    const c = this.#cfg;
    const t = this.#tick * c.dtSeconds;
    const zr = this.#road.heightAt(t);
    const vr = this.#road.rateAt(t);
    const deflection = this.#z - zr;
    const accel = (-c.springNPerM * deflection - c.damperNsPerM * (this.#v - vr)) / c.quarterMassKg - c.gravityNormal;
    this.#v += accel * c.dtSeconds;
    this.#z += this.#v * c.dtSeconds;
    this.#tick += 1;
    assertFinite([this.#z, this.#v], "quarterCar");
  }

  /**
   * 步进直至稳定:|v − vr| < epsVelocity 连续 holdTicks 个 tick 且压缩量变化
   * < epsDeflection,返回消耗的 tick 数(确定性;maxTicks 内未稳定返回 −1)。
   */
  settleTicks(maxTicks: number, epsVelocity = 1e-4, epsDeflection = 1e-6, holdTicks = 32): number {
    if (!Number.isSafeInteger(maxTicks) || maxTicks < 1) throw new Error(`settleTicks: maxTicks must be an integer >= 1, got ${maxTicks}.`);
    let hold = 0;
    let lastDeflection = this.deflection();
    for (let i = 0; i < maxTicks; i += 1) {
      const t = this.#tick * this.#cfg.dtSeconds;
      this.step();
      const settled = Math.abs(this.#v - this.#road.rateAt(t + this.#cfg.dtSeconds)) < epsVelocity
        && Math.abs(this.deflection() - lastDeflection) < epsDeflection;
      lastDeflection = this.deflection();
      hold = settled ? hold + 1 : 0;
      if (hold >= holdTicks) return i + 1;
    }
    return -1;
  }

  capture(): QuarterCarSnapshot {
    return { tick: this.#tick, z: this.#z, v: this.#v };
  }

  restore(snapshot: QuarterCarSnapshot): void {
    this.#z = snapshot.z;
    this.#v = snapshot.v;
    this.#tick = snapshot.tick;
  }
}
