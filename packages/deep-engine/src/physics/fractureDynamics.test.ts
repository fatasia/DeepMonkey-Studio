import { describe, expect, it } from "vitest";
import { buildPreFracture } from "./fractureReference.js";
import {
  FractureSolver, energyLedgerResidual, locateImpactPiece,
  type FractureSolverSnapshot,
} from "./fractureDynamics.js";

/**
 * PHYS-EDGE 刀 1:冲击触发层级碎裂 golden(行为先行,实现后红转绿)。
 *
 * 与 UE Chaos Destruction 的 graph 破裂对照口径(参考级):
 * - 冲击命中 piece → 命中连接吸收能量 ≥ 强度即断,超额(残差)沿连接图
 *   向未断邻接传播(每跳衰减 propagationDecay、同跳内均分),层级有序;
 * - 每次断裂后做连通性检查,与保留侧失连的 piece 组产生碎片激活事件;
 * - 能量总账:输入 = Σ已断连接吸收(= 强度)+ Σ未断连接累计 + Σ耗散。
 */

/** 1×1×3 竖链:3 胞元、2 连接(c0:0-1、c1:1-2),最简传播拓扑。 */
function chainSolver(energy = 0, opts?: { decay?: number; maxHops?: number }): { solver: FractureSolver; s0: number; s1: number } {
  const plan = buildPreFracture({
    min: [0, 0, 0], max: [0.2, 0.2, 0.6], divisions: [1, 1, 3],
    jitter: 0, seed: 7, density: 2700, cohesionMin: 10, cohesionMax: 10,
  });
  expect(plan.connections.length).toBe(2);
  const solver = new FractureSolver(plan, {
    propagationDecay: opts?.decay ?? 0.5,
    maxHops: opts?.maxHops ?? 8,
  });
  return { solver, s0: plan.connections[0]!.strengthJoules, s1: plan.connections[1]!.strengthJoules };
}

describe("单连接断裂判据(与 FractureLedger 判据同源)", () => {
  it("欠强度不断、能量累计储存;足强度断裂并产出 hop=0 事件", () => {
    const { solver, s0 } = chainSolver();
    solver.queueImpact({ atPiece: 1, energyJoules: s0 * 0.4 });
    solver.step();
    expect(solver.isBroken(0)).toBe(false);
    expect(solver.absorbedJoules(0)).toBeCloseTo(s0 * 0.4, 12);
    expect(solver.breakEvents.length).toBe(0);
    solver.queueImpact({ atPiece: 1, energyJoules: s0 * 0.4 });
    solver.step();
    expect(solver.isBroken(0)).toBe(false);
    solver.queueImpact({ atPiece: 1, energyJoules: s0 * 0.3 });
    solver.step();
    expect(solver.isBroken(0)).toBe(true);
    const ev = solver.breakEvents[0]!;
    expect(ev.connectionId).toBe(0);
    expect(ev.hop).toBe(0);
    expect(ev.absorbedJoules).toBeCloseTo(s0, 12);
  });

  it("已断连接重复冲击:幂等不重复断,能量全额记入耗散账", () => {
    const { solver, s0 } = chainSolver();
    solver.queueImpact({ atPiece: 1, energyJoules: s0 * 2 });
    solver.step();
    expect(solver.breakEvents.length).toBeGreaterThanOrEqual(1);
    const eventsAfterFirst = solver.breakEvents.length;
    solver.queueImpact({ atPiece: 1, energyJoules: s0 });
    solver.step();
    expect(solver.breakEvents.length).toBe(eventsAfterFirst);
    expect(solver.dissipatedJoules).toBeGreaterThanOrEqual(s0 - 1e-9);
  });
});

describe("层级传播(确定层序 + 衰减 + 跳数上限)", () => {
  it("足量冲击:残差传 c1 → 链式断裂,层序 hop 0→1 确定", () => {
    const { solver, s0, s1 } = chainSolver();
    solver.queueImpact({ atPiece: 1, energyJoules: s0 + s1 + 5 });
    solver.step();
    expect(solver.breakEvents.length).toBe(2);
    expect(solver.breakEvents[0]!.connectionId).toBe(0);
    expect(solver.breakEvents[0]!.hop).toBe(0);
    expect(solver.breakEvents[1]!.connectionId).toBe(1);
    expect(solver.breakEvents[1]!.hop).toBe(1);
    // 残差账:c0 断后 residual = 输入 − s0,衰减 0.5 后入 c1。
    const residual0 = solver.breakEvents[0]!.residualJoules;
    expect(residual0).toBeCloseTo(s1 + 5, 9);
    expect(solver.breakEvents[1]!.absorbedJoules).toBeCloseTo(s1, 9);
  });

  it("弱冲击:只断冲击面,残差衰减后不足以断邻接(邻接储存部分能量)", () => {
    const { solver, s0, s1 } = chainSolver();
    solver.queueImpact({ atPiece: 1, energyJoules: s0 + s1 * 0.4 });
    solver.step();
    expect(solver.isBroken(0)).toBe(true);
    expect(solver.isBroken(1)).toBe(false);
    // 残差 s1*0.4 + 5?无——输入 − s0 = s1·0.4,衰减 0.5 → c1 吸收 s1·0.2。
    expect(solver.absorbedJoules(1)).toBeCloseTo(s1 * 0.2, 9);
  });

  it("maxHops 截断:深链中超出跳数的残差记耗散,不再断裂", () => {
    const plan = buildPreFracture({
      min: [0, 0, 0], max: [0.2, 0.2, 1.2], divisions: [1, 1, 6],
      jitter: 0, seed: 11, density: 2700, cohesionMin: 10, cohesionMax: 10,
    });
    expect(plan.connections.length).toBe(5);
    const solver = new FractureSolver(plan, { propagationDecay: 0.9, maxHops: 3 });
    solver.queueImpact({ atPiece: 0, energyJoules: 1000 });
    solver.step();
    const hops = solver.breakEvents.map((e) => e.hop);
    expect(Math.max(...hops)).toBeLessThanOrEqual(2);
    expect(solver.isBroken(4)).toBe(false);
    // 能量守恒含耗散账。
    expect(Math.abs(energyLedgerResidual(solver.state()))).toBeLessThan(1e-9);
  });

  it("decay=0:冲击面断后残差不传播(仅面断裂)", () => {
    const { solver, s0, s1 } = chainSolver(0, { decay: 0 });
    solver.queueImpact({ atPiece: 1, energyJoules: s0 + s1 });
    solver.step();
    expect(solver.isBroken(0)).toBe(true);
    expect(solver.isBroken(1)).toBe(false);
    expect(solver.dissipatedJoules).toBeCloseTo(s1, 9);
  });
});

describe("碎片激活(连通性分离事件)", () => {
  it("链全断:两个单件依次脱离,成员与次序确定", () => {
    const { solver, s0, s1 } = chainSolver();
    solver.queueImpact({ atPiece: 1, energyJoules: s0 + s1 + 5 });
    solver.step();
    expect(solver.activationEvents.length).toBe(2);
    // 断 c0 后 {0} 脱离;断 c1 后保留侧 {1},脱离 {2}。
    expect([...solver.activationEvents[0]!.pieces]).toEqual([0]);
    expect([...solver.activationEvents[1]!.pieces]).toEqual([2]);
    expect(solver.activationEvents[0]!.viaConnectionId).toBe(0);
    expect(solver.activationEvents[1]!.viaConnectionId).toBe(1);
    expect(solver.detachedPieces()).toEqual([0, 2]);
  });

  it("部分断裂不误报激活;重复冲击不产生重复激活", () => {
    const { solver, s0 } = chainSolver();
    solver.queueImpact({ atPiece: 1, energyJoules: s0 * 0.5 });
    solver.step();
    expect(solver.activationEvents.length).toBe(0);
    solver.queueImpact({ atPiece: 1, energyJoules: s0 + 100 });
    solver.step();
    const activations = solver.activationEvents.length;
    solver.queueImpact({ atPiece: 1, energyJoules: 500 });
    solver.step();
    expect(solver.activationEvents.length).toBe(activations);
  });

  it("3×1×1 面阵:激活事件按分量最小 piece id 排序", () => {
    const plan = buildPreFracture({
      min: [0, 0, 0], max: [0.6, 0.2, 0.2], divisions: [3, 1, 1],
      jitter: 0, seed: 3, density: 2700, cohesionMin: 10, cohesionMax: 10,
    });
    expect(plan.connections.length).toBe(2);
    const solver = new FractureSolver(plan, { propagationDecay: 1, maxHops: 8 });
    solver.queueImpact({ atPiece: 1, energyJoules: 100 });
    solver.step();
    expect(solver.activationEvents.map((e) => [...e.pieces].join("+"))).toEqual(["0", "2"]);
  });
});

describe("冲击定位与守卫", () => {
  it("atPoint 命中包含胞元;未命中取中心最近;平局取 id 小", () => {
    const plan = buildPreFracture({
      min: [0, 0, 0], max: [0.4, 0.2, 0.2], divisions: [2, 1, 1],
      jitter: 0, seed: 5, density: 2700, cohesionMin: 10, cohesionMax: 10,
    });
    expect(locateImpactPiece(plan, [0.05, 0.1, 0.1])).toBe(0);
    expect(locateImpactPiece(plan, [0.35, 0.1, 0.1])).toBe(1);
    // 未命中:两点等距于两胞元中心 → 取 id 0。
    expect(locateImpactPiece(plan, [0.2, 0.5, 0.5])).toBe(0);
    expect(() => locateImpactPiece(plan, [0.1, Number.NaN, 0])).toThrow(/finite/);
  });

  it("非法冲击能量/越界 piece/非法配置抛可操作错误", () => {
    const { solver, s0 } = chainSolver();
    expect(() => solver.queueImpact({ atPiece: 1, energyJoules: -1 })).toThrow(/energy/);
    expect(() => solver.queueImpact({ atPiece: 1, energyJoules: Number.POSITIVE_INFINITY })).toThrow(/energy/);
    expect(() => solver.queueImpact({ atPiece: 99, energyJoules: s0 })).toThrow(/out of range/);
    expect(() => solver.queueImpact({ energyJoules: 1 })).toThrow(/atPiece or atPoint/);
    expect(() => new FractureSolver(buildPreFracture({
      min: [0, 0, 0], max: [0.2, 0.2, 0.2], divisions: [1, 1, 1],
      jitter: 0, seed: 1, density: 1, cohesionMin: 1, cohesionMax: 1,
    }), { propagationDecay: 1.1, maxHops: 4 })).toThrow(/propagationDecay/);
    expect(() => new FractureSolver(buildPreFracture({
      min: [0, 0, 0], max: [0.2, 0.2, 0.2], divisions: [1, 1, 1],
      jitter: 0, seed: 1, density: 1, cohesionMin: 1, cohesionMax: 1,
    }), { propagationDecay: 0.5, maxHops: 0 })).toThrow(/maxHops/);
  });
});

describe("能量守恒总账", () => {
  it("输入 = 已断吸收 + 未断累计 + 耗散,任意工况残差 ≤1e-9", () => {
    const plan = buildPreFracture({
      min: [0, 0, 0], max: [0.6, 0.4, 0.4], divisions: [3, 2, 2],
      jitter: 0.2, seed: 20260927, density: 2700, cohesionMin: 50, cohesionMax: 120,
    });
    const solver = new FractureSolver(plan, { propagationDecay: 0.6, maxHops: 6 });
    solver.queueImpact({ atPoint: [0.3, 0.2, 0.2], energyJoules: 900 });
    solver.step();
    solver.queueImpact({ atPoint: [0.05, 0.05, 0.05], energyJoules: 400 });
    solver.step();
    expect(solver.breakEvents.length).toBeGreaterThan(0);
    expect(Math.abs(energyLedgerResidual(solver.state()))).toBeLessThan(1e-9);
  });
});

describe("固定步长回放确定性", () => {
  it("双跑逐位一致;快照恢复后继续逐位一致(含队列)", () => {
    const build = () => new FractureSolver(buildPreFracture({
      min: [0, 0, 0], max: [0.6, 0.4, 0.4], divisions: [3, 2, 2],
      jitter: 0.2, seed: 42, density: 2700, cohesionMin: 50, cohesionMax: 120,
    }), { propagationDecay: 0.6, maxHops: 6 });
    const a = build();
    const b = build();
    a.queueImpact({ atPoint: [0.3, 0.2, 0.2], energyJoules: 800 });
    b.queueImpact({ atPoint: [0.3, 0.2, 0.2], energyJoules: 800 });
    a.step();
    b.step();
    a.queueImpact({ atPoint: [0.05, 0.05, 0.05], energyJoules: 300 });
    b.queueImpact({ atPoint: [0.05, 0.05, 0.05], energyJoules: 300 });
    a.step();
    b.step();
    expect(b.breakEvents.length).toBe(a.breakEvents.length);
    expect(b.activationEvents).toEqual(a.activationEvents);
    expect(b.dissipatedJoules).toBe(a.dissipatedJoules);
    // 第三步入队但不 step:快照必须包含待处理队列。
    a.queueImpact({ atPoint: [0.5, 0.3, 0.3], energyJoules: 200 });
    b.queueImpact({ atPoint: [0.5, 0.3, 0.3], energyJoules: 200 });
    const snapshot: FractureSolverSnapshot = b.capture();
    const c = build();
    c.restore(snapshot);
    for (let i = 0; i < 3; i += 1) { a.step(); c.step(); }
    expect(c.breakEvents).toEqual(a.breakEvents);
    expect(c.activationEvents).toEqual(a.activationEvents);
    expect(c.state()).toEqual(a.state());
  });

  it("restore 后能量账仍然守恒", () => {
    const plan = buildPreFracture({
      min: [0, 0, 0], max: [0.4, 0.4, 0.4], divisions: [2, 2, 2],
      jitter: 0.3, seed: 99, density: 2700, cohesionMin: 40, cohesionMax: 90,
    });
    const a = new FractureSolver(plan, { propagationDecay: 0.7, maxHops: 5 });
    a.queueImpact({ atPoint: [0.2, 0.2, 0.2], energyJoules: 1500 });
    a.step();
    const b = new FractureSolver(plan, { propagationDecay: 0.7, maxHops: 5 });
    b.restore(a.capture());
    b.queueImpact({ atPoint: [0.35, 0.35, 0.35], energyJoules: 600 });
    b.step();
    expect(Math.abs(energyLedgerResidual(b.state()))).toBeLessThan(1e-9);
  });
});
