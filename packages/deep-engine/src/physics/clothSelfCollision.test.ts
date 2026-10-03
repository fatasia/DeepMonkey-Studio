import { describe, expect, it } from "vitest";
import { createClothSelfCollision } from "./clothSelfCollision.js";
import { ClothSolver, type ClothSnapshot } from "./clothSolver.js";
import { fingerprintFloat64, replayFromStep, runTicks } from "./physicsTypes.js";

const GRAVITY = [0, -9.81, 0] as const;
const SPACING = 0.05;
const RADIUS = 0.02; // 接触距离 2r = 0.04 ≤ spacing(拓扑相邻 ≥ spacing,天然不触发)。
const TOTAL_TICKS = 240;
const WINDOW_FROM = 180;

/** 落布堆叠场景:无锚 + 地面 + 风扰动,褶皱层间形成真实自接触。 */
function makeDropSolver(selfCollision: boolean): ClothSolver {
  return new ClothSolver({
    columns: 12,
    rows: 12,
    spacing: SPACING,
    mass: 0.02,
    gravity: GRAVITY,
    dtSeconds: 1 / 60,
    substeps: 8,
    compliance: 0,
    damping: 0.01,
    perturbation: 0.008,
    seed: 20261002,
    groundY: 0,
    ...(selfCollision ? { selfCollisionRadius: RADIUS } : {}),
    wind: { direction: [0.6, 0, 0.2], baseSpeed: 1.2, gustFrequency: 0.9, spatialScale: 2.5, seed: 7 },
  });
}

/** 全对最小粒子距离;排除约束相邻对 (Δcol,Δrow) ∈ {(1,0),(0,1),(1,1)}(dc²+dr² ≤ 2)。 */
function minPairDistance(solver: ClothSolver): number {
  const columns = 12;
  const p = solver.positionsInterleaved();
  const n = p.length / 3;
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const dc = Math.abs((i % columns) - (j % columns));
      const dr = Math.abs(Math.floor(i / columns) - Math.floor(j / columns));
      if (dc * dc + dr * dr <= 2) continue;
      const dx = p[i * 3]! - p[j * 3]!; const dy = p[i * 3 + 1]! - p[j * 3 + 1]!; const dz = p[i * 3 + 2]! - p[j * 3 + 2]!;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < min) min = d;
    }
  }
  return min;
}

function stateFingerprint(s: ClothSolver): string {
  const snap: ClothSnapshot = s.capture();
  const n = snap.px.length;
  const all = new Float64Array(n * 6);
  all.set(snap.px, 0); all.set(snap.py, n); all.set(snap.pz, 2 * n);
  all.set(snap.vx, 3 * n); all.set(snap.vy, 4 * n); all.set(snap.vz, 5 * n);
  return fingerprintFloat64(all);
}

describe("ClothSelfCollision 构造合同", () => {
  it("拒绝非法半径与非正 count", () => {
    expect(() => createClothSelfCollision({ count: 0, radius: RADIUS })).toThrow(/count/);
    expect(() => createClothSelfCollision({ count: 144, radius: 0 })).toThrow(/radius/);
    expect(() => createClothSelfCollision({ count: 144, radius: -0.01 })).toThrow(/radius/);
    expect(() => createClothSelfCollision({ count: 144, radius: Number.NaN })).toThrow(/radius/);
    expect(() => createClothSelfCollision({ count: 144, radius: Number.POSITIVE_INFINITY })).toThrow(/radius/);
  });

  it("ClothSolver 参数合同:2r ≤ spacing 且半径合法", () => {
    expect(() => makeDropSolver(true)).not.toThrow();
    expect(() => new ClothSolver({
      columns: 4, rows: 4, spacing: 0.05, mass: 0.1, gravity: GRAVITY, dtSeconds: 1 / 60,
      substeps: 4, compliance: 0, damping: 0.01, perturbation: 0, seed: 1,
      selfCollisionRadius: 0.026, // 2r = 0.052 > spacing
    })).toThrow(/selfCollisionRadius/);
    expect(() => new ClothSolver({
      columns: 4, rows: 4, spacing: 0.05, mass: 0.1, gravity: GRAVITY, dtSeconds: 1 / 60,
      substeps: 4, compliance: 0, damping: 0.01, perturbation: 0, seed: 1,
      selfCollisionRadius: Number.NaN,
    })).toThrow(/selfCollisionRadius/);
  });
});

describe("自碰撞有效性:落布堆叠窗口门", () => {
  it("禁用负控:堆叠窗口内出现真实自接触穿透(min < 2r)", () => {
    const solver = makeDropSolver(false);
    runTicks(solver, TOTAL_TICKS);
    let min = Number.POSITIVE_INFINITY;
    for (let t = 0; t < TOTAL_TICKS; t += 1) {
      runTicks(solver, 1);
      if (t >= WINDOW_FROM) min = Math.min(min, minPairDistance(solver));
    }
    // 场景必须真实触发层间自接触;否则该场景对自碰撞无证明力。
    expect(min).toBeLessThan(2 * RADIUS);
  });

  it("启用:堆叠窗口内 min ≥ 0.9·2r,拉伸 ≤5%,开关真实生效", () => {
    const solver = makeDropSolver(true);
    let min = Number.POSITIVE_INFINITY;
    for (let t = 0; t < TOTAL_TICKS; t += 1) {
      runTicks(solver, 1);
      if (t >= WINDOW_FROM) min = Math.min(min, minPairDistance(solver));
    }
    expect(min).toBeGreaterThanOrEqual(0.9 * 2 * RADIUS);
    expect(solver.measureStretch().maxRatio).toBeLessThanOrEqual(0.05);
    const disabled = makeDropSolver(false);
    runTicks(disabled, TOTAL_TICKS);
    expect(stateFingerprint(solver)).not.toBe(stateFingerprint(disabled));
  });
});

describe("锚点与确定性", () => {
  it("锚点在自碰撞全程位置严格不动", () => {
    const solver = makeDropSolver(true);
    solver.setPinned(0, 11, true);
    solver.setPinned(11, 11, true);
    const i0 = solver.particleIndex(0, 11);
    const i1 = solver.particleIndex(11, 11);
    const p0 = solver.positionsInterleaved();
    const anchor0 = [p0[i0 * 3]!, p0[i0 * 3 + 1]!, p0[i0 * 3 + 2]!] as const;
    const anchor1 = [p0[i1 * 3]!, p0[i1 * 3 + 1]!, p0[i1 * 3 + 2]!] as const;
    runTicks(solver, TOTAL_TICKS);
    const p = solver.positionsInterleaved();
    for (let axis = 0; axis < 3; axis += 1) {
      expect(p[i0 * 3 + axis]).toBe(anchor0[axis]);
      expect(p[i1 * 3 + axis]).toBe(anchor1[axis]);
    }
  });

  it("同参数双跑逐位一致", () => {
    const a = makeDropSolver(true);
    const b = makeDropSolver(true);
    runTicks(a, TOTAL_TICKS);
    runTicks(b, TOTAL_TICKS);
    expect(stateFingerprint(a)).toBe(stateFingerprint(b));
  });

  it("快照回放:第 100 步 restore 后续跑与连续运行逐位一致", () => {
    const continuous = makeDropSolver(true);
    runTicks(continuous, TOTAL_TICKS);
    const replay = makeDropSolver(true);
    runTicks(replay, 100);
    replayFromStep(replay, replay.capture(), TOTAL_TICKS - 100);
    expect(stateFingerprint(replay)).toBe(stateFingerprint(continuous));
  });
});
