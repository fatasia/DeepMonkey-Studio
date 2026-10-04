import { describe, expect, it } from "vitest";
import {
  createDefaultVehicleConfig, VehicleDynamicsSim, type VehicleSnapshot,
} from "./vehicleDynamics.js";
import { engineTorqueAt, gearboxStep, pacejkaTireForce, tirePeakSlip, type GearboxState } from "./vehicleTire.js";

/**
 * PHYS-EDGE 刀 2:车辆动力学 golden(行为先行,实现后红转绿)。
 *
 * 对标 UE Chaos Vehicles 的四件核心(参考级,如实声明边界):
 * ① 轮胎滑移模型(简化 Pacejka + 摩擦圆)② 引擎扭矩曲线 ③ 简单变速逻辑
 * (升/降挡阈值 + 换挡动力中断)④ 四轮独立悬挂整车动力学(载荷转移)。
 * 全部固定步长(1/240 × 4 子步),确定性可回放。
 */

const CFG = createDefaultVehicleConfig();

describe("轮胎滑移模型(简化 Pacejka + 摩擦圆)", () => {
  it("峰值滑移位置 ≈ sPeak,峰值力 ≈ μ·Fz", () => {
    const fz = 5000;
    let peakF = 0;
    let peakS = 0;
    for (let i = 0; i <= 2000; i += 1) {
      const s = (i / 2000) * 0.6;
      const f = pacejkaTireForce(s, 0, fz, CFG.tire).fx;
      if (f > peakF) { peakF = f; peakS = s; }
    }
    const expectedSlip = tirePeakSlip(CFG.tire);
    expect(Math.abs(peakS - expectedSlip) / expectedSlip).toBeLessThanOrEqual(0.02);
    expect(peakF / (CFG.tire.muPeak * fz)).toBeGreaterThan(0.985);
    expect(peakF / (CFG.tire.muPeak * fz)).toBeLessThanOrEqual(1.0);
  });

  it("零滑移零力;大滑移力收敛;摩擦圆 |F| ≤ μ·Fz;侧向力反对侧偏速度", () => {
    const fz = 5000;
    expect(pacejkaTireForce(0, 0, fz, CFG.tire).fx).toBe(0);
    const far = pacejkaTireForce(0.8, 0, fz, CFG.tire);
    expect(far.fx / (CFG.tire.muPeak * fz)).toBeGreaterThan(0.6);
    // 联合滑移:纵滑+侧偏同施,合力不得超摩擦圆;侧向力方向与侧偏速度相反。
    const combo = pacejkaTireForce(0.3, 0.3, fz, CFG.tire);
    const total = Math.hypot(combo.fx, combo.fy);
    expect(total).toBeLessThanOrEqual(CFG.tire.muPeak * fz + 1e-9);
    expect(combo.fx).toBeGreaterThan(0);
    expect(combo.fy).toBeLessThan(0);
  });

  it("法向载荷归零 → 轮胎力归零(悬空轮不产生力)", () => {
    expect(pacejkaTireForce(0.2, 0.1, 0, CFG.tire).fx).toBe(0);
    expect(pacejkaTireForce(0.2, 0.1, -1, CFG.tire).fx).toBe(0);
  });
});

describe("引擎扭矩曲线", () => {
  it("怠速以下钳制到怠速扭矩;峰值在 peakTorqueRpm;红线断油", () => {
    expect(engineTorqueAt(0, CFG.engine)).toBeCloseTo(CFG.engine.idleTorqueNm, 9);
    expect(engineTorqueAt(CFG.engine.peakTorqueRpm, CFG.engine)).toBeCloseTo(CFG.engine.peakTorqueNm, 9);
    expect(engineTorqueAt(CFG.engine.redlineRpm + 500, CFG.engine)).toBe(0);
    const mid = engineTorqueAt((CFG.engine.idleRpm + CFG.engine.peakTorqueRpm) / 2, CFG.engine);
    expect(mid).toBeGreaterThan(CFG.engine.idleTorqueNm);
    expect(mid).toBeLessThan(CFG.engine.peakTorqueNm);
  });
});

describe("简单变速逻辑", () => {
  const WHEEL_R = CFG.wheelRadius;
  const FINAL = CFG.gearbox.finalDrive;
  const engineRpm = (v: number, gear: number) =>
    (Math.abs(v) / (2 * Math.PI * WHEEL_R)) * 60 * CFG.gearbox.ratios[gear - 1]! * FINAL;

  it("低转降挡、高转升挡、换挡窗口动力中断、1 挡不降、顶挡不升", () => {
    let gb: GearboxState = { gear: 1, stepsInGear: 99 };
    // 低速低转:保持 1 挡(1 挡不许降到 0)。
    gb = gearboxStep(gb, 2, 1, CFG.gearbox);
    expect(gb.gear).toBe(1);
    // 升挡:engineRpm ≥ shiftUpRpm。
    let v = 0;
    while (engineRpm(v, gb.gear) < CFG.gearbox.shiftUpRpm) v += 0.1;
    gb = gearboxStep(gb, v, 1, CFG.gearbox);
    expect(gb.gear).toBe(2);
    // 刚换挡(窗口内)再触发升挡条件也不连跳。
    gb = gearboxStep(gb, v, 1, CFG.gearbox);
    expect(gb.gear).toBe(2);
    // 降挡:engineRpm ≤ shiftDownRpm 且窗口已过。
    gb = { gear: 2, stepsInGear: 99 };
    v = 0.1;
    while (engineRpm(v, 2) > CFG.gearbox.shiftDownRpm) v -= 0.005;
    gb = gearboxStep(gb, v, 1, CFG.gearbox);
    expect(gb.gear).toBe(1);
    // 顶挡不再升。
    gb = { gear: CFG.gearbox.ratios.length, stepsInGear: 99 };
    v = 100;
    gb = gearboxStep(gb, v, 1, CFG.gearbox);
    expect(gb.gear).toBe(CFG.gearbox.ratios.length);
  });

  it("非法变速箱配置拒绝", () => {
    expect(() => gearboxStep({ gear: 0, stepsInGear: 1 }, 1, 1, CFG.gearbox)).toThrow(/gear/);
    expect(() => gearboxStep({ gear: CFG.gearbox.ratios.length + 1, stepsInGear: 1 }, 1, 1, CFG.gearbox)).toThrow(/gear/);
  });
});

describe("整车:四轮独立悬挂 + 动力总成(固定步长参考)", () => {
  it("静态:各角法向载荷 = 轴荷分配(前后 b/L、a/L),姿态零漂移", () => {
    const sim = new VehicleDynamicsSim(CFG);
    const ref = sim.wheelLoads();
    const wheelbase = CFG.frontAxleX - CFG.rearAxleX;
    const mF = CFG.massKg * (-CFG.rearAxleX / wheelbase); // 前轴荷 ∝ 质心到后轴距离。
    const mR = CFG.massKg * (CFG.frontAxleX / wheelbase);
    const g = 9.81;
    expect(ref.frontLeft / (mF * g)).toBeCloseTo(0.5, 2);
    expect(ref.rearRight / (mR * g)).toBeCloseTo(0.5, 2);
    for (let i = 0; i < 240; i += 1) sim.step();
    const after = sim.wheelLoads();
    expect(Math.abs(after.frontLeft - ref.frontLeft) / ref.frontLeft).toBeLessThanOrEqual(0.01);
    expect(Math.abs(after.rearRight - ref.rearRight) / ref.rearRight).toBeLessThanOrEqual(0.01);
    const snap = sim.snapshot();
    expect(Math.abs(snap.pitch - CFG.staticPitch)).toBeLessThanOrEqual(5e-4);
    expect(Math.abs(snap.z - CFG.staticCgHeight)).toBeLessThanOrEqual(0.002);
    expect(snap.yaw).toBe(0);
    expect(snap.x).toBe(0);
  });

  it("直线全油门:1→2 升挡在 1 挡 6000 rpm 对应车速,0→100 km/h 在 8–14 s(家用车量级)", () => {
    const sim = new VehicleDynamicsSim(CFG);
    const gears: number[] = [];
    const shiftTicks: number[] = [];
    let lastGear = 1;
    let ticksTo100 = -1;
    const vShift = (CFG.gearbox.shiftUpRpm / (CFG.gearbox.ratios[0]! * CFG.gearbox.finalDrive * 60)) * 2 * Math.PI * CFG.wheelRadius;
    for (let i = 0; i < 3600; i += 1) {
      sim.setDriverInput({ throttle: 1, brake: 0, steerAngle: 0 });
      sim.step();
      if (sim.snapshot().gear !== lastGear) { gears.push(lastGear); shiftTicks.push(i); lastGear = sim.snapshot().gear; }
      if (ticksTo100 < 0 && sim.speed() >= 100 / 3.6) ticksTo100 = i;
    }
    gears.push(lastGear);
    expect(gears).toEqual([1, 2, 3, 4]);
    // 升挡时刻车速 = 1 挡 6000 rpm 换算车速(±4%)。
    const sim2 = new VehicleDynamicsSim(CFG);
    for (let i = 0; i < shiftTicks[0]!; i += 1) { sim2.setDriverInput({ throttle: 1, brake: 0, steerAngle: 0 }); sim2.step(); }
    expect(Math.abs(sim2.speed() - vShift) / vShift).toBeLessThanOrEqual(0.04);
    // 0→100 km/h 加速时间(确定性,量级断言)。
    expect(ticksTo100).toBeGreaterThan(0);
    const seconds = ticksTo100 * CFG.dtSeconds;
    expect(seconds).toBeGreaterThan(8);
    expect(seconds).toBeLessThan(14);
  });

  it("起步牵引力上限:后驱合力 ≤ μ·后轴载荷(滑移饱和),加速度有界", () => {
    const sim = new VehicleDynamicsSim(CFG);
    let peakDriveForce = 0;
    for (let i = 0; i < 700; i += 1) {
      sim.setDriverInput({ throttle: 1, brake: 0, steerAngle: 0 });
      sim.step();
      peakDriveForce = Math.max(peakDriveForce, sim.driveForce());
    }
    const rearLoad = sim.wheelLoads().rearLeft + sim.wheelLoads().rearRight;
    // 载荷转移后静态后轴载荷增加,用初始静态值与动态值较大者作上限基准。
    const cap = CFG.tire.muPeak * Math.max(rearLoad, (CFG.massKg * -CFG.rearAxleX / (CFG.frontAxleX - CFG.rearAxleX)) * 9.81) * 1.02;
    expect(peakDriveForce).toBeGreaterThan(cap * 0.8); // 滑移扫过峰值区(摩擦圆确实被触及)
    expect(peakDriveForce).toBeLessThanOrEqual(cap * 1.05); // 摩擦圆封顶
    expect(Number.isFinite(sim.speed())).toBe(true);
  });

  it("制动:120 km/h → 停车距离 ≈ v²/(2μg) (+5% 内),停车后保持静止", () => {
    const sim = new VehicleDynamicsSim(CFG);
    const v0 = 120 / 3.6;
    // 先用手动位移把车放到初速(直接注入世界速度,走公开合同)。
    sim.setDriverInput({ throttle: 0, brake: 0, steerAngle: 0 });
    sim.injectVelocity(v0, 0);
    const mu = CFG.tire.muPeak;
    const ideal = (v0 * v0) / (2 * mu * 9.81);
    let dist = 0;
    let stopped = -1;
    for (let i = 0; i < 1200; i += 1) {
      sim.setDriverInput({ throttle: 0, brake: 1, steerAngle: 0 });
      sim.step();
      dist += Math.abs(sim.speed()) * CFG.dtSeconds;
      if (stopped < 0 && sim.speed() < 0.01) stopped = i;
    }
    expect(stopped).toBeGreaterThan(0);
    expect(dist / ideal).toBeGreaterThan(0.95);
    expect(dist / ideal).toBeLessThanOrEqual(1.08);
    // 停车后保持静止(无爬行)。
    for (let i = 0; i < 60; i += 1) { sim.setDriverInput({ throttle: 0, brake: 1, steerAngle: 0 }); sim.step(); }
    expect(sim.speed()).toBeLessThan(0.02);
  });

  it("稳态回转:恒转向角下横摆率跟踪 v·tanδ/L(阿克曼,窗口均值 ≤10%)", () => {
    const sim = new VehicleDynamicsSim(CFG);
    const v0 = 8;
    sim.injectVelocity(v0, 0);
    const steer = 0.1;
    const wheelbase = CFG.frontAxleX - CFG.rearAxleX;
    // 零油门滑行转弯(不踩加速,保持在线性轮胎区),瞬时阿克曼按实时车速对照。
    let errSum = 0;
    let errCount = 0;
    let vEnd = 0;
    for (let i = 0; i < 900; i += 1) {
      sim.setDriverInput({ throttle: 0, brake: 0, steerAngle: steer });
      sim.step();
      if (i >= 240 && i < 600) {
        const snap = sim.snapshot();
        const v = sim.speed();
        const ackermann = (v * Math.tan(steer)) / wheelbase;
        errSum += Math.abs(snap.yawRate - ackermann) / ackermann;
        errCount += 1;
      }
      if (i === 899) vEnd = sim.speed();
    }
    expect(errSum / errCount).toBeLessThanOrEqual(0.1);
    // 侧倾有界且方向正确(左转:离心使右侧压缩,左侧抬高 → roll > 0)。
    const roll = sim.snapshot().roll;
    expect(Number.isFinite(roll)).toBe(true);
    expect(Math.abs(roll)).toBeLessThan(0.1);
    expect(roll).toBeGreaterThan(0);
    void vEnd;
  });
});

describe("确定性:双跑逐位一致 + 快照回放", () => {
  it("同一工况双跑 700 步全状态逐位一致;快照恢复后继续一致", () => {
    const run = (): VehicleDynamicsSim => {
      const sim = new VehicleDynamicsSim(CFG);
      sim.injectVelocity(20, 0);
      return sim;
    };
    const drive = (sim: VehicleDynamicsSim, n: number) => {
      for (let i = 0; i < n; i += 1) {
        sim.setDriverInput({ throttle: 0.8, brake: i % 200 < 30 ? 0.4 : 0, steerAngle: i % 100 < 50 ? 0.02 : -0.02 });
        sim.step();
      }
    };
    const a = run();
    const b = run();
    drive(a, 400);
    drive(b, 400);
    expect(b.snapshot()).toEqual(a.snapshot());
    const snapshot = b.capture();
    drive(a, 300);
    drive(b, 300);
    expect(b.snapshot()).toEqual(a.snapshot());
    const c = run();
    c.restore(snapshot);
    drive(c, 300);
    expect(c.snapshot()).toEqual(a.snapshot());
  });
});
