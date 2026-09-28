import { describe, expect, it } from "vitest";
import { ClothSolver, type ClothSnapshot } from "./clothSolver.js";
import { fingerprintFloat64, replayFromStep, runTicks } from "./physicsTypes.js";

const GRAVITY = [0, -9.81, 0] as const;

function makeSolver(overrides: Partial<ConstructorParameters<typeof ClothSolver>[0]> = {}): ClothSolver {
  return new ClothSolver({
    columns: 12,
    rows: 12,
    spacing: 0.1,
    mass: 0.2,
    gravity: GRAVITY,
    dtSeconds: 1 / 60,
    substeps: 8,
    compliance: 0,
    damping: 0.01,
    perturbation: 0.005,
    seed: 20260927,
    wind: null,
    ...overrides,
  });
}

function makeFlag(solver: ClothSolver): ClothSolver {
  solver.setPinned(0, 11, true);
  solver.setPinned(11, 11, true);
  return solver;
}

function stateFingerprint(s: ClothSolver): string {
  const px = s.positions();
  const snap = s.capture();
  const all = new Float64Array(px.length * 6);
  all.set(snap.px, 0); all.set(snap.py, px.length); all.set(snap.pz, 2 * px.length);
  all.set(snap.vx, 3 * px.length); all.set(snap.vy, 4 * px.length); all.set(snap.vz, 5 * px.length);
  return fingerprintFloat64(all);
}

describe("ClothSolver 构造合同", () => {
  it("拒绝非法参数并列明原因", () => {
    expect(() => makeSolver({ columns: 1 })).toThrow(/columns\/rows/);
    expect(() => makeSolver({ spacing: 0 })).toThrow(/positive/);
    expect(() => makeSolver({ mass: -1 })).toThrow(/positive/);
    expect(() => makeSolver({ substeps: 0 })).toThrow(/substeps/);
    expect(() => makeSolver({ damping: 1 })).toThrow(/damping/);
    expect(() => makeSolver({ perturbation: -0.1 })).toThrow(/perturbation/);
    expect(() => makeSolver({ gravity: [0, Number.NaN, 0] })).toThrow(/gravity/);
  });

  it("锚点查询与解绑语义", () => {
    const solver = makeFlag(makeSolver());
    expect(solver.isPinned(0, 11)).toBe(true);
    expect(solver.isPinned(5, 5)).toBe(false);
    solver.setPinned(0, 11, false);
    expect(solver.isPinned(0, 11)).toBe(false);
  });
});

describe("T18 验收:布料拉伸误差 ≤5% 目标约束长度", () => {
  it("240 tick 后全约束残差 ≤ 5%(双锚点旗帜,含确定性风)", () => {
    const solver = makeFlag(makeSolver({
      wind: { direction: [0, 0, 1], baseSpeed: 2.5, gustFrequency: 1.5, spatialScale: 0.5, seed: 7 },
    }));
    runTicks(solver, 240);
    const stats = solver.measureStretch();
    console.log(`[T18 cloth] 240 ticks: maxStretch=${(stats.maxRatio * 100).toFixed(4)}% meanStretch=${(stats.meanRatio * 100).toFixed(4)}% constraints=${stats.constraintCount}`);
    expect(stats.maxRatio).toBeLessThanOrEqual(0.05);
    expect(Number.isFinite(stats.maxRatio)).toBe(true);
  });

  it("无风纯重力场景残差同样 ≤5%,锚点位置严格不动", () => {
    const solver = makeFlag(makeSolver());
    const start = solver.capture();
    runTicks(solver, 240);
    const stats = solver.measureStretch();
    console.log(`[T18 cloth] no-wind: maxStretch=${(stats.maxRatio * 100).toFixed(4)}%`);
    expect(stats.maxRatio).toBeLessThanOrEqual(0.05);
    const pinned = solver.particleIndex(0, 11);
    const end = solver.capture();
    expect(end.px[pinned]).toBe(start.px[pinned]);
    expect(end.py[pinned]).toBe(start.py[pinned]);
    expect(end.pz[pinned]).toBe(start.pz[pinned]);
    expect(end.vx[pinned]).toBe(0);
  });
});

describe("确定性:同 seed 逐位重放 + 局部回放", () => {
  it("两次独立 240 tick 运行逐位一致", () => {
    const a = makeFlag(makeSolver());
    const b = makeFlag(makeSolver());
    runTicks(a, 240);
    runTicks(b, 240);
    expect(stateFingerprint(a)).toBe(stateFingerprint(b));
    expect(a.capture().px).toEqual(b.capture().px);
    expect(a.capture().vz).toEqual(b.capture().vz);
  });

  it("局部回放:从第 100 步快照重放 140 步与连续运行逐位一致", () => {
    const a = makeFlag(makeSolver({ wind: { direction: [0, 0, 1], baseSpeed: 2.5, gustFrequency: 1.5, spatialScale: 0.5, seed: 7 } }));
    runTicks(a, 240);
    const b = makeFlag(makeSolver({ wind: { direction: [0, 0, 1], baseSpeed: 2.5, gustFrequency: 1.5, spatialScale: 0.5, seed: 7 } }));
    runTicks(b, 100);
    const snapshot: ClothSnapshot = b.capture();
    expect(snapshot.tick).toBe(100);
    replayFromStep(b, snapshot, 140);
    expect(stateFingerprint(b)).toBe(stateFingerprint(a));
  });

  it("restore 回原求解器再推进同样逐位一致(快照可复用)", () => {
    const a = makeFlag(makeSolver());
    runTicks(a, 100);
    const snapshot = a.capture();
    runTicks(a, 140);
    const direct = stateFingerprint(a);
    a.restore(snapshot);
    expect(a.tick).toBe(100);
    runTicks(a, 140);
    expect(stateFingerprint(a)).toBe(direct);
  });

  it("不同 seed 初始扰动不同,状态发散(扰动真实生效)", () => {
    const a = makeFlag(makeSolver({ seed: 1 }));
    const b = makeFlag(makeSolver({ seed: 2 }));
    runTicks(a, 30);
    runTicks(b, 30);
    expect(stateFingerprint(a)).not.toBe(stateFingerprint(b));
  });
});

describe("确定性风场", () => {
  it("风场是 (t,y) 纯函数:同参数两次求值逐位一致", () => {
    const solver = makeSolver({ wind: { direction: [1, 0, 0], baseSpeed: 3, gustFrequency: 2, spatialScale: 0.5, seed: 7 } });
    const w1 = solver.windAcceleration(1.234, 0.5);
    const w2 = solver.windAcceleration(1.234, 0.5);
    expect(w1).toEqual(w2);
    expect(solver.windAcceleration(0, 0)).not.toEqual(solver.windAcceleration(1 / 60, 0));
  });

  it("有风与无风终态不同(风真实进入动力学)", () => {
    const calm = makeFlag(makeSolver());
    const windy = makeFlag(makeSolver({ wind: { direction: [0, 0, 1], baseSpeed: 4, gustFrequency: 1.5, spatialScale: 0.5, seed: 7 } }));
    runTicks(calm, 240);
    runTicks(windy, 240);
    expect(stateFingerprint(calm)).not.toBe(stateFingerprint(windy));
  });
});

