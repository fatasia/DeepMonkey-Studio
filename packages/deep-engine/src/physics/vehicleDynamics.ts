/**
 * PHYS-EDGE 刀 2(之二):四轮独立悬挂整车动力学(固定步长确定性参考)。
 *
 * 对标 UE Chaos Vehicles 的整车模拟(参考级,如实声明边界):
 * - 车体 6 自由度(x/y/z + yaw/roll/pitch)+ 4 轮独立转动 = 10 自由度;
 * - 每角独立弹簧-阻尼悬挂,法向载荷 = 悬挂力(忽略轮胎垂向刚度,轮贴路面);
 *   载荷转移由俯仰/侧倾力矩(含轮胎力作用高度 = 质心高度)自然产生,非查表;
 * - 轮胎力走 vehicleTire 的简化 Pacejka + 摩擦圆;驱动/制动经车轮转动动力学
 *   (转动惯量)与滑移耦合;制动含滑移调节(超过峰值滑移自动回收制动力矩,
 *   参考级"ABS 近似",非产品 ABS;无转向机构/无倒挡/单路面)。
 * - 固定步长 dt,内部 4 子步;零随机源、固定遍历序,同输入逐位一致,快照可回放。
 * 解析对照:静态轴荷按质心位置分配(m·g·b/L、m·g·a/L),初始位姿取悬挂
 * 静态平衡解(computeStaticPose),静态工况零漂移。
 */
import { assertFinite, fingerprintFloat64, type FixedStepSim } from "./physicsTypes.js";
import {
  gearboxDriveForce, gearboxStep, pacejkaTireForce, tireLongitudinalStiffness, tireStiffnessB,
  type EngineConfig, type GearboxConfig, type GearboxState, type TireModelConfig, type TireForce,
} from "./vehicleTire.js";

/** 每个固定步内部的子步数(刚硬的轮速/悬挂动力学稳定裕量)。 */
const SUBSTEPS = 4;

export interface VehicleConfig {
  readonly massKg: number;
  /** 质心到前轴(+x 车头方向)/后轴的距离(m,后轴为负)。 */
  readonly frontAxleX: number;
  readonly rearAxleX: number;
  /** 半轮距(m)。 */
  readonly trackHalfY: number;
  /** 质心到轮触点平面的高度(m,轮胎力力矩臂)。 */
  readonly cgHeight: number;
  /** 悬挂自由长度(m)。 */
  readonly suspensionFreeLength: number;
  readonly cornerSpringNPerM: number;
  readonly cornerDamperNsPerM: number;
  readonly rollInertia: number;
  readonly pitchInertia: number;
  readonly yawInertia: number;
  readonly wheelRadius: number;
  readonly wheelInertia: number;
  readonly maxBrakeTorquePerWheelNm: number;
  /** 空气阻力合并系数(0.5·ρ·Cd·A,N/(m/s)²)。 */
  readonly dragCoeffArea: number;
  readonly rollingResistance: number;
  /** 滑移分母速度下限(m/s,低速奇异保护)。 */
  readonly minTireSpeed: number;
  readonly dtSeconds: number;
  readonly engine: EngineConfig;
  readonly gearbox: GearboxConfig;
  readonly tire: TireModelConfig;
  /** 解析静态位姿(golden 参照;仿真构造器自行重算,不信任输入值)。 */
  readonly staticPitch: number;
  readonly staticCgHeight: number;
}

/** 静态平衡位姿:各角压缩 = 轴荷/2/k,前后压缩差给出俯仰角(低头为正)。 */
export function computeStaticPose(cfg: VehicleConfig): { pitch: number; cgHeight: number } {
  const wheelbase = cfg.frontAxleX - cfg.rearAxleX;
  if (!(wheelbase > 0)) throw new Error("computeStaticPose: wheelbase must be positive.");
  const g = 9.81;
  const frontLoad = cfg.massKg * (-cfg.rearAxleX / wheelbase) * g;
  const rearLoad = cfg.massKg * (cfg.frontAxleX / wheelbase) * g;
  const frontSag = frontLoad / 2 / cfg.cornerSpringNPerM;
  const rearSag = rearLoad / 2 / cfg.cornerSpringNPerM;
  const pitch = (frontSag - rearSag) / wheelbase;
  const cgHeight = cfg.suspensionFreeLength + cfg.cgHeight - frontSag + cfg.frontAxleX * pitch;
  return { pitch, cgHeight };
}

/** 典型前纵置后驱轿车量级参数(参考参数,非标定数据;如实声明)。 */
export function createDefaultVehicleConfig(): VehicleConfig {
  const base = {
    massKg: 1200, frontAxleX: 1.2, rearAxleX: -1.4, trackHalfY: 0.75,
    cgHeight: 0.5, suspensionFreeLength: 0.4,
    cornerSpringNPerM: 60000, cornerDamperNsPerM: 4500,
    rollInertia: 500, pitchInertia: 2000, yawInertia: 2200,
    wheelRadius: 0.31, wheelInertia: 0.9, maxBrakeTorquePerWheelNm: 1500,
    dragCoeffArea: 0.46, rollingResistance: 0.013, minTireSpeed: 0.5,
    dtSeconds: 1 / 240,
    engine: { idleRpm: 800, idleTorqueNm: 100, peakTorqueNm: 200, peakTorqueRpm: 4500, redlineRpm: 6500, redlineTorqueNm: 80 },
    gearbox: { ratios: [3.4, 2.0, 1.35, 1.0], finalDrive: 3.9, drivelineEfficiency: 0.9, shiftUpRpm: 6000, shiftDownRpm: 1500, shiftDelaySteps: 6, wheelRadius: 0.31 },
    tire: { muPeak: 1.0, sPeak: 0.12 },
  };
  const pose = computeStaticPose({ ...base, staticPitch: 0, staticCgHeight: 0 });
  return { ...base, staticPitch: pose.pitch, staticCgHeight: pose.cgHeight };
}

export interface DriverInput { readonly throttle: number; readonly brake: number; readonly steerAngle: number; }

export interface VehicleSnapshot {
  readonly tick: number;
  readonly x: number; readonly y: number; readonly z: number;
  readonly yaw: number; readonly roll: number; readonly pitch: number;
  readonly vx: number; readonly vy: number; readonly vz: number;
  readonly yawRate: number; readonly rollRate: number; readonly pitchRate: number;
  readonly omega: readonly number[];
  readonly gear: number; readonly stepsInGear: number;
  readonly throttle: number; readonly brake: number; readonly steerAngle: number;
}

/** 制动滑移调节:滑移超过峰值按比例回收制动力矩(参考级 ABS 近似)。 */
function brakeSlipFactor(slipMagnitude: number, sPeak: number): number {
  if (slipMagnitude <= sPeak) return 1;
  const over = (slipMagnitude - sPeak) / sPeak;
  return Math.max(0.05, 1 - 2.5 * over);
}

const GRAVITY = 9.81;

export class VehicleDynamicsSim implements FixedStepSim<VehicleSnapshot> {
  readonly #cfg: VehicleConfig;
  readonly #corners: ReadonlyArray<{ x: number; y: number; driven: boolean }>;
  #x = 0; #y = 0; #z = 0;
  #yaw = 0; #roll = 0; #pitch = 0;
  #vx = 0; #vy = 0; #vz = 0;
  #yawRate = 0; #rollRate = 0; #pitchRate = 0;
  readonly #omega = new Float64Array(4);
  readonly #lastDrivenFx = new Float64Array(4);
  #gb: GearboxState;
  #input: DriverInput = { throttle: 0, brake: 0, steerAngle: 0 };
  #tick = 0;

  constructor(cfg: VehicleConfig) {
    const pose = computeStaticPose(cfg);
    if (!(cfg.massKg > 0) || !(cfg.dtSeconds > 0)) throw new Error("VehicleDynamicsSim: mass and dt must be positive.");
    if (!(cfg.cornerSpringNPerM > 0) || !(cfg.wheelRadius > 0) || !(cfg.wheelInertia > 0)) {
      throw new Error("VehicleDynamicsSim: spring/wheel geometry must be positive.");
    }
    tireStiffnessB(cfg.tire); // 轮胎参数守卫。
    this.#cfg = cfg;
    this.#corners = [
      { x: cfg.frontAxleX, y: cfg.trackHalfY, driven: false },
      { x: cfg.frontAxleX, y: -cfg.trackHalfY, driven: false },
      { x: cfg.rearAxleX, y: cfg.trackHalfY, driven: true },
      { x: cfg.rearAxleX, y: -cfg.trackHalfY, driven: true },
    ];
    this.#z = pose.cgHeight;
    this.#pitch = pose.pitch;
    this.#gb = { gear: 1, stepsInGear: cfg.gearbox.shiftDelaySteps };
  }

  get tick(): number { return this.#tick; }

  setDriverInput(input: DriverInput): void {
    const clamp01 = (v: number) => {
      if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`setDriverInput: pedal must be in [0, 1], got ${v}.`);
      return v;
    };
    if (!Number.isFinite(input.steerAngle) || Math.abs(input.steerAngle) > 0.6) {
      throw new Error(`setDriverInput: steerAngle must be finite within ±0.6 rad, got ${input.steerAngle}.`);
    }
    this.#input = { throttle: clamp01(input.throttle), brake: clamp01(input.brake), steerAngle: input.steerAngle };
  }

  /** golden 场景注入:直线初速(世界系)并令车轮纯滚。 */
  injectVelocity(vx: number, vy: number): void {
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) throw new Error("injectVelocity: velocities must be finite.");
    this.#vx = vx; this.#vy = vy;
    const u = Math.cos(this.#yaw) * vx + Math.sin(this.#yaw) * vy;
    for (let i = 0; i < 4; i += 1) this.#omega[i] = u / this.#cfg.wheelRadius;
  }

  speed(): number { return Math.hypot(this.#vx, this.#vy); }

  /** 各角悬挂法向载荷(N;FL/FR/RL/RR)。 */
  wheelLoads(): { frontLeft: number; frontRight: number; rearLeft: number; rearRight: number } {
    const loads = this.#suspensionLoads();
    return { frontLeft: loads[0]!, frontRight: loads[1]!, rearLeft: loads[2]!, rearRight: loads[3]! };
  }

  /** 驱动轮轮胎纵向合力(N,最近子步缓存)。 */
  driveForce(): number { return this.#lastDrivenFx[2]! + this.#lastDrivenFx[3]!; }

  #suspensionLoads(): Float64Array {
    const c = this.#cfg;
    const loads = new Float64Array(4);
    for (let i = 0; i < 4; i += 1) {
      const corner = this.#corners[i]!;
      const wz = this.#z - c.cgHeight - corner.x * this.#pitch + corner.y * this.#roll;
      const compression = c.suspensionFreeLength - wz;
      const wzRate = this.#vz - corner.x * this.#pitchRate + corner.y * this.#rollRate;
      loads[i] = Math.max(0, c.cornerSpringNPerM * compression - c.cornerDamperNsPerM * wzRate);
    }
    return loads;
  }

  step(): void {
    const c = this.#cfg;
    this.#gb = gearboxStep(this.#gb, this.#bodyVelocity().u, this.#input.throttle, c.gearbox);
    const h = c.dtSeconds / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s += 1) this.#substep(h);
    this.#tick += 1;
    assertFinite([this.#x, this.#y, this.#z, this.#vx, this.#vy, this.#vz, this.#yaw, this.#roll, this.#pitch], "vehicleBody");
    assertFinite(this.#omega, "vehicleWheels");
  }

  #bodyVelocity(): { u: number; v: number } {
    const cy = Math.cos(this.#yaw);
    const sy = Math.sin(this.#yaw);
    return { u: cy * this.#vx + sy * this.#vy, v: -sy * this.#vx + cy * this.#vy };
  }

  #substep(h: number): void {
    const c = this.#cfg;
    const { u, v } = this.#bodyVelocity();
    const loads = this.#suspensionLoads();
    const speed = Math.hypot(u, v);
    const driveForce = gearboxDriveForce(this.#gb, u, this.#input.throttle, c.gearbox, c.engine);
    const steer = this.#input.steerAngle;
    const ct = Math.cos(steer);
    const st = Math.sin(steer);
    let sumFx = 0;
    let sumFy = 0;
    let tauZ = 0;
    let tauPitch = 0;
    let tauRoll = 0;
    let sumLoad = 0;
    for (let i = 0; i < 4; i += 1) {
      const corner = this.#corners[i]!;
      const load = loads[i]!;
      sumLoad += load;
      // 接触点车身系速度 + 车轮系旋转(前轮转向)。
      const vu = u - this.#yawRate * corner.y;
      const vv = v + this.#yawRate * corner.x;
      const wct = corner.driven ? 1 : ct;
      const wst = corner.driven ? 0 : st;
      const ut = wct * vu + wst * vv;
      const vt = -wst * vu + wct * vv;
      const denom = Math.max(Math.abs(ut), c.minTireSpeed);
      const slipX = (this.#omega[i]! * c.wheelRadius - ut) / denom;
      const tanAlpha = vt / denom;
      const force: TireForce = pacejkaTireForce(slipX, tanAlpha, load, c.tire);
      const fxb = wct * force.fx - wst * force.fy;
      const fyb = wst * force.fx + wct * force.fy;
      if (corner.driven) this.#lastDrivenFx[i] = force.fx;
      sumFx += fxb;
      sumFy += fyb;
      tauZ += corner.x * fyb - corner.y * fxb;
      tauPitch += -corner.x * load - c.cgHeight * fxb;
      tauRoll += corner.y * load + c.cgHeight * fyb;
      // 车轮转动:驱动扭矩 + 轮胎反扭矩 + 受滑移调节的制动力矩。
      // 轮速半隐式更新:沿滑移上升段的纵向刚度进入分母,消除"一步跨过滑移
      // 平衡带"的数值滑转(下降段钳 0,保留真实车轮滑转行为)。
      const brakeFactor = brakeSlipFactor(Math.abs(slipX), c.tire.sPeak);
      const tauBrake = -this.#input.brake * c.maxBrakeTorquePerWheelNm * brakeFactor * Math.tanh(this.#omega[i]! * 30);
      const tauDrive = corner.driven ? (driveForce * c.wheelRadius) / 2 : 0;
      const tauNet = tauDrive - force.fx * c.wheelRadius + tauBrake;
      const stiffness = tireLongitudinalStiffness(slipX, tanAlpha, load, c.tire);
      const implicitDenom = c.wheelInertia + h * stiffness * c.wheelRadius * c.wheelRadius / denom;
      this.#omega[i] = this.#omega[i]! + (h / implicitDenom) * tauNet;
    }
    // 滚阻(纵向)+ 空气阻力(速度向量方向)。
    sumFx -= c.rollingResistance * sumLoad * Math.sign(u);
    sumFx -= c.dragCoeffArea * speed * u;
    sumFy -= c.dragCoeffArea * speed * v;
    // 世界系积分(半隐式欧拉)。
    const cy = Math.cos(this.#yaw);
    const sy = Math.sin(this.#yaw);
    this.#vx += ((cy * sumFx - sy * sumFy) / c.massKg) * h;
    this.#vy += ((sy * sumFx + cy * sumFy) / c.massKg) * h;
    this.#vz += (sumLoad / c.massKg - GRAVITY) * h;
    this.#x += this.#vx * h;
    this.#y += this.#vy * h;
    this.#z += this.#vz * h;
    this.#yawRate += (tauZ / c.yawInertia) * h;
    this.#yaw += this.#yawRate * h;
    this.#pitchRate += (tauPitch / c.pitchInertia) * h;
    this.#pitch += this.#pitchRate * h;
    this.#rollRate += (tauRoll / c.rollInertia) * h;
    this.#roll += this.#rollRate * h;
    // 停车静摩擦守卫:制动下近零速直接钳静止(防滑移调节微爬行)。
    if (this.#input.brake >= 0.5 && Math.abs(u) < 0.05 && Math.abs(v) < 0.05) {
      this.#vx = 0; this.#vy = 0;
      this.#omega.fill(0);
    }
  }

  snapshot(): VehicleSnapshot {
    return {
      tick: this.#tick,
      x: this.#x, y: this.#y, z: this.#z,
      yaw: this.#yaw, roll: this.#roll, pitch: this.#pitch,
      vx: this.#vx, vy: this.#vy, vz: this.#vz,
      yawRate: this.#yawRate, rollRate: this.#rollRate, pitchRate: this.#pitchRate,
      omega: [...this.#omega],
      gear: this.#gb.gear, stepsInGear: this.#gb.stepsInGear,
      throttle: this.#input.throttle, brake: this.#input.brake, steerAngle: this.#input.steerAngle,
    };
  }

  capture(): VehicleSnapshot { return this.snapshot(); }

  restore(snapshot: VehicleSnapshot): void {
    this.#x = snapshot.x; this.#y = snapshot.y; this.#z = snapshot.z;
    this.#yaw = snapshot.yaw; this.#roll = snapshot.roll; this.#pitch = snapshot.pitch;
    this.#vx = snapshot.vx; this.#vy = snapshot.vy; this.#vz = snapshot.vz;
    this.#yawRate = snapshot.yawRate; this.#rollRate = snapshot.rollRate; this.#pitchRate = snapshot.pitchRate;
    this.#omega.set(snapshot.omega);
    this.#gb = { gear: snapshot.gear, stepsInGear: snapshot.stepsInGear };
    this.#input = { throttle: snapshot.throttle, brake: snapshot.brake, steerAngle: snapshot.steerAngle };
    this.#tick = snapshot.tick;
  }

  /** 回放证据指纹(位姿 + 速度 + 轮速位模式)。 */
  fingerprint(): string {
    return fingerprintFloat64([
      this.#x, this.#y, this.#z, this.#yaw, this.#roll, this.#pitch,
      this.#vx, this.#vy, this.#vz, this.#yawRate, this.#rollRate, this.#pitchRate,
      ...this.#omega,
    ]);
  }
}
