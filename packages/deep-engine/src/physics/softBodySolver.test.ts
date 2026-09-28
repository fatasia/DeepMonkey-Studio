import { describe, expect, it } from "vitest";
import { SoftBodySolver } from "./softBodySolver.js";
import { fingerprintFloat64, replayFromStep, runTicks } from "./physicsTypes.js";

const H = 0.5;
/** 单位立方体 Kuhn 六四面体分解(主对角 0→6);环绕方向故意不一致,构造器会规整。 */
const CUBE_TETS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6],
];
const CUBE_VERTICES = [
  [0, 0, 0], [H, 0, 0], [H, H, 0], [0, H, 0],
  [0, 0, H], [H, 0, H], [H, H, H], [0, H, H],
] as const;

interface SoftBodyOverrides {
  readonly tets?: ReadonlyArray<readonly [number, number, number, number]>;
  readonly gravity?: readonly [number, number, number];
  readonly pinned?: readonly number[];
  readonly substeps?: number;
  readonly damping?: number;
}

function makeSolver(overrides: SoftBodyOverrides = {}): SoftBodySolver {
  return new SoftBodySolver({
    positions: CUBE_VERTICES,
    tets: overrides.tets ?? CUBE_TETS,
    mass: 0.25,
    gravity: overrides.gravity ?? [0, -9.81, 0],
    dtSeconds: 1 / 60,
    substeps: overrides.substeps ?? 10,
    complianceDistance: 0,
    complianceVolume: 0,
    damping: overrides.damping ?? 0.02,
    pinned: overrides.pinned ?? [0, 1, 2, 3],
  });
}

function fingerprint(s: SoftBodySolver): string {
  const snap = s.capture();
  const all = new Float64Array(snap.px.length * 6);
  all.set(snap.px, 0); all.set(snap.py, snap.px.length); all.set(snap.pz, 2 * snap.px.length);
  all.set(snap.vx, 3 * snap.px.length); all.set(snap.vy, 4 * snap.px.length); all.set(snap.vz, 5 * snap.px.length);
  return fingerprintFloat64(all);
}

describe("SoftBodySolver 构造合同", () => {
  it("拒绝非法输入并给出可操作原因", () => {
    expect(() => new SoftBodySolver({
      positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      tets: [[0, 1, 2, 0]], mass: 1, gravity: [0, -9.81, 0], dtSeconds: 1 / 60,
      substeps: 4, complianceDistance: 0, complianceVolume: 0, damping: 0, pinned: [],
    })).toThrow(/>= 4 vertices/);
    expect(() => makeSolver({ tets: [[0, 1, 2, 99]] })).toThrow(/out of range/);
    expect(() => makeSolver({ tets: [[0, 1, 2, 3]] })).toThrow(/degenerate/);
    expect(() => makeSolver({ gravity: [Number.NaN, 0, 0] })).toThrow(/gravity/);
    // 重复顶点构成退化四面体:被"零体积"守卫拦下(零长度边守卫为其纵深防御)。
    expect(() => new SoftBodySolver({
      positions: [[0, 0, 0], [0, 0, 0], [1, 0, 0], [0, 1, 0]],
      tets: [[0, 1, 2, 3]], mass: 1, gravity: [0, -9.81, 0], dtSeconds: 1 / 60,
      substeps: 4, complianceDistance: 0, complianceVolume: 0, damping: 0, pinned: [],
    })).toThrow(/degenerate|zero rest length/);
    expect(() => makeSolver({ pinned: [42] })).toThrow(/out of range/);
  });

  it("环绕方向规整:负体积输入与正体积输入得到相同的正体积集合", () => {
    const normal = makeSolver();
    const flipped = makeSolver({ tets: CUBE_TETS.map((t) => [t[0], t[2], t[1], t[3]] as const) });
    const a = normal.tetVolumes();
    const b = flipped.tetVolumes();
    for (let t = 0; t < a.length; t += 1) {
      expect(a[t]).toBeGreaterThan(0);
      expect(b[t]).toBeCloseTo(a[t], 12);
    }
    expect(normal.tetCount).toBe(6);
  });
});

describe("T18 验收:软体体积误差 ≤5% 目标体积", () => {
  it("底面四角锚定 + 重力,240 tick 后逐四面体与总体积误差均 ≤5%", () => {
    const solver = makeSolver();
    runTicks(solver, 240);
    const stats = solver.measureVolumeError();
    console.log(`[T18 softbody] gravity+4 pins, 240 ticks: maxTetVolumeError=${(stats.maxTetRatio * 100).toFixed(4)}% totalVolumeError=${(stats.totalRatio * 100).toFixed(4)}% tets=${stats.tetCount}`);
    expect(stats.maxTetRatio).toBeLessThanOrEqual(0.05);
    expect(stats.totalRatio).toBeLessThanOrEqual(0.05);
  });

  it("零重力零初速:状态严格不动,体积误差恒 0", () => {
    const solver = makeSolver({ gravity: [0, 0, 0] });
    runTicks(solver, 120);
    const stats = solver.measureVolumeError();
    expect(stats.maxTetRatio).toBe(0);
    const snap = solver.capture();
    expect(snap.px[6]).toBe(H);
    expect(snap.py[6]).toBe(H);
  });
});

describe("确定性:同输入逐位重放 + 局部回放", () => {
  it("两次独立 240 tick 运行逐位一致", () => {
    const a = makeSolver();
    const b = makeSolver();
    runTicks(a, 240);
    runTicks(b, 240);
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(a.capture().px).toEqual(b.capture().px);
    expect(a.capture().vz).toEqual(b.capture().vz);
  });

  it("局部回放:从第 100 步快照重放 140 步与连续运行逐位一致", () => {
    const a = makeSolver();
    runTicks(a, 240);
    const b = makeSolver();
    runTicks(b, 100);
    const snapshot = b.capture();
    expect(snapshot.tick).toBe(100);
    replayFromStep(b, snapshot, 140);
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it("锚点在全程严格保持初位", () => {
    const solver = makeSolver();
    const start = solver.capture();
    runTicks(solver, 240);
    const end = solver.capture();
    for (const i of [0, 1, 2, 3]) {
      expect(end.px[i]).toBe(start.px[i]);
      expect(end.py[i]).toBe(start.py[i]);
      expect(end.pz[i]).toBe(start.pz[i]);
    }
  });
});
