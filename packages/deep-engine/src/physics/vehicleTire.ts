/**
 * PHYS-EDGE 刀 2(之一):车辆轮胎滑移模型 + 引擎扭矩曲线 + 简单变速逻辑。
 *
 * 对标 UE Chaos Vehicles 的轮胎/动力总成(参考级,确定性固定步长):
 * - 轮胎:简化 Pacejka 魔术公式 F(s) = D·sin(C·atan(B·s)),D = μ·Fz、E = 0、
 *   C = 1.65;B 由峰值滑移 sPeak 标定(B = tan(π/(2C))/sPeak)。联合滑移
 *   (纵滑 sx、侧偏 tanα)按滑移向量方向分配 → 摩擦圆 |F| ≤ μ·Fz 自动成立。
 * - 引擎:怠速—峰值—红线三段分段线性扭矩曲线;怠速以下钳制到怠速扭矩
 *   (滑动离合近似,起步不熄火);红线以上断油。扭矩曲线数值取自典型汽油机量级,
 *   是参考参数不是标定数据(如实声明)。
 * - 变速:比例数组 + 主减速比 + 效率;engineRpm ≥ 升挡阈值升、≤ 降挡阈值降
 *   (阈值差即滞回),换挡窗口内扭矩系数为 0(动力中断);1 挡不降、顶挡不升。
 */
import { assertFinite } from "./physicsTypes.js";

/** 简化 Pacejka 形状因子:E=0 时峰值位于 B·s = tan(π/(2C))。 */
const PACEJKA_C = 1.65;
const PACEJKA_PEAK_SLOPE = Math.tan(Math.PI / (2 * PACEJKA_C));

export interface TireModelConfig {
  /** 峰值附着系数。 */
  readonly muPeak: number;
  /** 峰值滑移(复合滑移模长,纵滑/侧偏共用)。 */
  readonly sPeak: number;
}

export interface EngineConfig {
  readonly idleRpm: number;
  /** 怠速输出扭矩(滑动离合近似的起步扭矩,N·m)。 */
  readonly idleTorqueNm: number;
  readonly peakTorqueNm: number;
  readonly peakTorqueRpm: number;
  readonly redlineRpm: number;
  /** 红线扭矩(N·m),超过 redlineRpm 断油为 0。 */
  readonly redlineTorqueNm: number;
}

export interface GearboxConfig {
  /** 前进挡传动比(1 挡在前)。 */
  readonly ratios: readonly number[];
  readonly finalDrive: number;
  /** 传动系效率 ∈ (0,1]。 */
  readonly drivelineEfficiency: number;
  readonly shiftUpRpm: number;
  readonly shiftDownRpm: number;
  /** 换挡后动力中断的步数(同一固定步长口径)。 */
  readonly shiftDelaySteps: number;
  readonly wheelRadius: number;
}

export interface GearboxState {
  /** 当前挡位(1 基)。 */
  readonly gear: number;
  readonly stepsInGear: number;
}

/** B 标定:E=0 时峰值滑移 sPeak → B = tan(π/(2C))/sPeak。 */
export function tireStiffnessB(tire: TireModelConfig): number {
  if (!(tire.muPeak > 0) || !(tire.sPeak > 0)) throw new Error("tireStiffnessB: muPeak and sPeak must be positive.");
  return PACEJKA_PEAK_SLOPE / tire.sPeak;
}

/** 理论峰值滑移位置(数值扫描对照用)。 */
export function tirePeakSlip(tire: TireModelConfig): number {
  tireStiffnessB(tire); // 参数守卫。
  return PACEJKA_PEAK_SLOPE / tireStiffnessB(tire);
}

function pacejkaMagnitude(slip: number, loadN: number, tire: TireModelConfig): number {
  if (loadN <= 0) return 0;
  const d = tire.muPeak * loadN;
  if (slip <= 1e-12) return 0;
  const b = tireStiffnessB(tire);
  return d * Math.sin(PACEJKA_C * Math.atan(b * slip));
}

export interface TireForce {
  /** 轮胎纵向力(N,前进为正)。 */
  readonly fx: number;
  /** 轮胎侧向力(N,左侧为正)。 */
  readonly fy: number;
}

/** 联合滑移轮胎力:合力沿滑移向量方向分配(摩擦圆自动成立)。
 * 纵向力沿滑移方向(fx = mag·sx/s,驱动滑移产正向推力);侧向力**反对**侧偏
 * 滑移速度(fy = −mag·tanα/s,侧偏产生恢复力)——转会如何取号由整车层验证。 */
export function pacejkaTireForce(slipRatioX: number, tanSlipAngle: number, loadN: number, tire: TireModelConfig): TireForce {
  if (!Number.isFinite(slipRatioX) || !Number.isFinite(tanSlipAngle)) throw new Error("pacejkaTireForce: slips must be finite.");
  if (loadN <= 0) return { fx: 0, fy: 0 };
  const s = Math.hypot(slipRatioX, tanSlipAngle);
  if (s < 1e-9) return { fx: 0, fy: 0 };
  const magnitude = pacejkaMagnitude(s, loadN, tire);
  return { fx: (magnitude * slipRatioX) / s, fy: (-magnitude * tanSlipAngle) / s };
}

/**
 * 纵向切向刚度 ∂fx/∂sx(当前工况;下降段钳 0,供轮速半隐式积分稳定上升段)。
 * fx = F(s)·ex,ex = sx/s ⇒ ∂fx/∂sx = F′(s)·ex² + F(s)·(1−ex²)/s;小滑移取 F′(0)。
 */
export function tireLongitudinalStiffness(slipRatioX: number, tanSlipAngle: number, loadN: number, tire: TireModelConfig): number {
  if (loadN <= 0) return 0;
  const s = Math.hypot(slipRatioX, tanSlipAngle);
  const b = tireStiffnessB(tire);
  const d = tire.muPeak * loadN;
  const slopePrime = (sAbs: number): number =>
    (d * PACEJKA_C * b * Math.cos(PACEJKA_C * Math.atan(b * sAbs))) / (1 + (b * sAbs) * (b * sAbs));
  if (s < 1e-9) return slopePrime(0);
  const ex = slipRatioX / s;
  const f = pacejkaMagnitude(s, loadN, tire);
  const k = slopePrime(s) * ex * ex + (f / s) * (1 - ex * ex);
  return Math.max(0, k);
}

/** 引擎扭矩曲线:怠速以下钳制;峰值段线性;红线断油。 */
export function engineTorqueAt(rpm: number, engine: EngineConfig): number {
  if (!Number.isFinite(rpm)) throw new Error("engineTorqueAt: rpm must be finite.");
  if (rpm >= engine.redlineRpm) return 0;
  if (rpm <= engine.idleRpm) return engine.idleTorqueNm;
  if (rpm <= engine.peakTorqueRpm) {
    const t = (rpm - engine.idleRpm) / (engine.peakTorqueRpm - engine.idleRpm);
    return engine.idleTorqueNm + t * (engine.peakTorqueNm - engine.idleTorqueNm);
  }
  const t = (rpm - engine.peakTorqueRpm) / (engine.redlineRpm - engine.peakTorqueRpm);
  return engine.peakTorqueNm + t * (engine.redlineTorqueNm - engine.peakTorqueNm);
}

/** 车速 → 该挡 engine rpm(|v|,倒挡按 0 处理)。 */
export function wheelSpeedToEngineRpm(forwardSpeed: number, gear: number, gearbox: GearboxConfig): number {
  const ratio = gearbox.ratios[gear - 1];
  if (ratio === undefined) throw new Error(`wheelSpeedToEngineRpm: gear ${gear} out of range.`);
  const wheelRpm = (Math.abs(forwardSpeed) / (2 * Math.PI * gearbox.wheelRadius)) * 60;
  return wheelRpm * ratio * gearbox.finalDrive;
}

/** 变速步进:升降挡阈值 + 窗口动力中断;非法挡位拒绝。 */
export function gearboxStep(state: GearboxState, forwardSpeed: number, throttle: number, gearbox: GearboxConfig): GearboxState {
  if (!Number.isSafeInteger(state.gear) || state.gear < 1 || state.gear > gearbox.ratios.length) {
    throw new Error(`gearboxStep: gear ${state.gear} out of range [1, ${gearbox.ratios.length}].`);
  }
  const rpm = wheelSpeedToEngineRpm(forwardSpeed, state.gear, gearbox);
  let gear = state.gear;
  if (state.stepsInGear >= gearbox.shiftDelaySteps) {
    if (rpm >= gearbox.shiftUpRpm && gear < gearbox.ratios.length) gear += 1;
    else if (rpm <= gearbox.shiftDownRpm && gear > 1) gear -= 1;
  }
  const stepsInGear = gear === state.gear ? state.stepsInGear + 1 : 0;
  return { gear, stepsInGear };
}

/** 该步驱动轮缘总力(N;换挡窗口内为 0;红线断油为 0)。 */
export function gearboxDriveForce(state: GearboxState, forwardSpeed: number, throttle: number, gearbox: GearboxConfig, engine: EngineConfig): number {
  if (state.stepsInGear < gearbox.shiftDelaySteps) return 0;
  const rpm = wheelSpeedToEngineRpm(forwardSpeed, state.gear, gearbox);
  const torque = engineTorqueAt(rpm, engine);
  if (torque <= 0) return 0;
  const ratio = gearbox.ratios[state.gear - 1]!;
  return throttle * torque * ratio * gearbox.finalDrive * gearbox.drivelineEfficiency / gearbox.wheelRadius;
}

/** 有限性哨兵(供整车步进统一调用)。 */
export function assertVehicleFinite(values: ArrayLike<number>, label: string): void {
  assertFinite(values, label);
}
