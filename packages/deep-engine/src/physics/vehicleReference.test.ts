import { describe, expect, it } from "vitest";
import { dampingRatio, flatRoad, QuarterCarSim, rampRoad, rideFrequencyHz, slopeNormalGravity, staticSagM } from "./vehicleReference.js";

const MASS = 250;
const SPRING = 25000;
const DAMPER = 2000;
const G = 9.81;
const DT = 1 / 240;

function makeSim(road = flatRoad, gravityNormal = G): QuarterCarSim {
  return new QuarterCarSim({ quarterMassKg: MASS, springNPerM: SPRING, damperNsPerM: DAMPER, gravityNormal, dtSeconds: DT }, road);
}

describe("解析参考(独立真值)", () => {
  it("静态下沉量 m·g/k", () => {
    expect(staticSagM(MASS, SPRING, G)).toBeCloseTo(0.0981, 12);
    expect(() => staticSagM(0, SPRING)).toThrow(/positive/);
    expect(() => staticSagM(MASS, -1)).toThrow(/positive/);
  });

  it("坡道法向重力 g·cosθ 与对应下沉量", () => {
    const theta = (10 * Math.PI) / 180;
    const gN = slopeNormalGravity(G, theta);
    expect(gN).toBeCloseTo(G * Math.cos(theta), 12);
    expect(staticSagM(MASS, SPRING, gN)).toBeCloseTo((MASS * G * Math.cos(theta)) / SPRING, 12);
  });

  it("固有频率与阻尼比", () => {
    expect(rideFrequencyHz(MASS, SPRING)).toBeCloseTo(Math.sqrt(SPRING / MASS) / (2 * Math.PI), 12);
    expect(dampingRatio(MASS, SPRING, DAMPER)).toBeCloseTo(0.4, 12);
    expect(() => rideFrequencyHz(0, 1)).toThrow(/positive/);
    expect(() => dampingRatio(MASS, SPRING, -1)).toThrow(/damper/);
  });
});

describe("T18 验收:静态悬挂有解析对照(平地/坡道)", () => {
  it("平地:固定步长仿真收敛到 −m·g/k(≤1% 误差)", () => {
    const sim = makeSim();
    const sag = staticSagM(MASS, SPRING, G);
    const used = sim.settleTicks(5000);
    console.log(`[T18 vehicle] flat: settled in ${used} ticks, deflection=${sim.deflection().toFixed(6)} m, analytic sag=${sag.toFixed(6)} m`);
    expect(used).toBeGreaterThan(0);
    expect(Math.abs(sim.deflection() + sag) / sag).toBeLessThanOrEqual(0.01);
  });

  it("坡道 10°:恒速爬坡稳态压缩 = −m·g·cosθ/k(≤1.5% 误差)", () => {
    const theta = (10 * Math.PI) / 180;
    const forwardSpeed = 5;
    const sim = makeSim(rampRoad(forwardSpeed * Math.sin(theta)), slopeNormalGravity(G, theta));
    const sag = staticSagM(MASS, SPRING, slopeNormalGravity(G, theta));
    const used = sim.settleTicks(6000);
    console.log(`[T18 vehicle] slope 10°: settled in ${used} ticks, deflection=${sim.deflection().toFixed(6)} m, analytic=${sag.toFixed(6)} m`);
    expect(used).toBeGreaterThan(0);
    expect(Math.abs(sim.deflection() + sag) / sag).toBeLessThanOrEqual(0.015);
  });

  it("settleTicks 参数守卫与未稳定返回 −1", () => {
    expect(() => makeSim().settleTicks(0)).toThrow(/maxTicks/);
    const tiny = new QuarterCarSim({ quarterMassKg: MASS, springNPerM: SPRING, damperNsPerM: 0, gravityNormal: G, dtSeconds: DT });
    expect(tiny.settleTicks(50, 1e-4, 1e-6, 32)).toBe(-1);
  });
});

describe("确定性:固定步长重放", () => {
  it("两次独立仿真逐位一致;快照恢复后继续一致", () => {
    const a = makeSim(rampRoad(0.8));
    const b = makeSim(rampRoad(0.8));
    for (let i = 0; i < 600; i += 1) { a.step(); b.step(); }
    expect(b.bodyHeight()).toBe(a.bodyHeight());
    expect(b.bodyVelocity()).toBe(a.bodyVelocity());
    for (let i = 0; i < 100; i += 1) { a.step(); b.step(); }
    const snapshot = b.capture();
    expect(snapshot.tick).toBe(700);
    b.restore(snapshot);
    for (let i = 0; i < 50; i += 1) { a.step(); b.step(); }
    expect(b.capture()).toEqual(a.capture());
  });

  it("构造参数守卫", () => {
    expect(() => new QuarterCarSim({ quarterMassKg: 0, springNPerM: SPRING, damperNsPerM: 0, gravityNormal: G, dtSeconds: DT })).toThrow(/positive/);
    expect(() => new QuarterCarSim({ quarterMassKg: MASS, springNPerM: SPRING, damperNsPerM: -1, gravityNormal: G, dtSeconds: DT })).toThrow(/damper/);
    expect(() => rampRoad(Number.NaN)).toThrow(/finite/);
  });
});
