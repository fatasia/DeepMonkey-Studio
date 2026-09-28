import { describe, expect, it } from "vitest";
import { HairChainSolver, type HairChainSpec } from "./hairChainSolver.js";
import { fingerprintFloat64, replayFromStep, runTicks } from "./physicsTypes.js";

const LINK = 0.08;
const MAX_BEND = Math.PI / 2;

function makeChains(count: number, segments = 12): HairChainSpec[] {
  return Array.from({ length: count }, (_, i): HairChainSpec => ({
    origin: [0.1 * i, 2, 0],
    direction: [0, -1, 0],
    segments,
    linkLength: LINK,
  }));
}

interface HairOverrides {
  readonly chains?: HairChainSpec[];
  readonly damping?: number;
  readonly perturbation?: number;
  readonly maxBendAngle?: number;
  readonly seed?: number;
}

function makeSolver(overrides: HairOverrides = {}): HairChainSolver {
  return new HairChainSolver({
    chains: overrides.chains ?? makeChains(3),
    maxBendAngle: overrides.maxBendAngle ?? MAX_BEND,
    mass: 0.01,
    gravity: [0, -9.81, 0],
    dtSeconds: 1 / 60,
    substeps: 4,
    compliance: 0,
    damping: overrides.damping ?? 0.5,
    perturbation: overrides.perturbation ?? 1.2,
    seed: overrides.seed ?? 1818,
  });
}

function chainBaseOffset(segments: number[], chain: number): number {
  let base = 0;
  for (let c = 0; c < chain; c += 1) base += segments[c] + 1;
  return base;
}

function fingerprint(s: HairChainSolver): string {
  const snap = s.capture();
  const all = new Float64Array(snap.px.length * 6);
  all.set(snap.px, 0); all.set(snap.py, snap.px.length); all.set(snap.pz, 2 * snap.px.length);
  all.set(snap.vx, 3 * snap.px.length); all.set(snap.vy, 4 * snap.px.length); all.set(snap.vz, 5 * snap.px.length);
  return fingerprintFloat64(all);
}

describe("HairChainSolver 构造合同", () => {
  it("拒绝非法输入", () => {
    expect(() => makeSolver({ chains: [] })).toThrow(/non-empty/);
    expect(() => makeSolver({ chains: makeChains(1, 0) })).toThrow(/segments/);
    expect(() => makeSolver({ chains: [{ origin: [0, 2, 0], direction: [0, -1, 0], segments: 4, linkLength: 0 }] })).toThrow(/linkLength/);
    expect(() => makeSolver({ maxBendAngle: 0 })).toThrow(/maxBendAngle/);
    expect(() => makeSolver({ maxBendAngle: Math.PI + 0.1 })).toThrow(/maxBendAngle/);
    expect(() => makeSolver({ chains: [{ origin: [0, 2, 0], direction: [0, 0, 0], segments: 4, linkLength: LINK }] })).toThrow(/direction/);
    expect(() => makeSolver({ damping: 1 })).toThrow(/damping/);
  });

  it("单段链(2 粒子)合法且无弯曲约束", () => {
    const solver = makeSolver({ chains: makeChains(1, 1), perturbation: 0 });
    runTicks(solver, 30);
    expect(solver.chainCount).toBe(1);
    expect(solver.tipIndex(0)).toBe(1);
  });
});

describe("T18 验收:毛发链段长误差与弯曲限制", () => {
  it("600 tick 全程段长误差 ≤5%(每 30 tick 抽检)", () => {
    const solver = makeSolver();
    let worst = 0;
    for (let i = 0; i < 20; i += 1) {
      runTicks(solver, 30);
      worst = Math.max(worst, solver.measureSegmentStretch().maxRatio);
    }
    console.log(`[T18 hair] worst segment stretch over 600 ticks = ${(worst * 100).toFixed(4)}%`);
    expect(worst).toBeLessThanOrEqual(0.05);
  });

  it("弯曲限制不被违反:第二邻居距离始终 ≥ dmin − 1e-6", () => {
    const solver = makeSolver();
    const segments = 12;
    const dmin = 2 * LINK * Math.sin(MAX_BEND / 2);
    let worst = Infinity;
    for (let i = 0; i < 20; i += 1) {
      runTicks(solver, 30);
      const snap = solver.capture();
      for (let c = 0; c < solver.chainCount; c += 1) {
        const base = chainBaseOffset([segments, segments, segments], c);
        for (let k = 0; k + 2 <= segments; k += 1) {
          const a = base + k; const b = base + k + 2;
          const d = Math.hypot(snap.px[a] - snap.px[b], snap.py[a] - snap.py[b], snap.pz[a] - snap.pz[b]);
          worst = Math.min(worst, d);
        }
      }
    }
    console.log(`[T18 hair] min second-neighbour distance = ${worst.toFixed(6)} m, dmin = ${dmin.toFixed(6)} m`);
    expect(worst).toBeGreaterThanOrEqual(dmin - 1e-6);
  });
});

describe("T18 验收:末端摆动衰减确定性", () => {
  it("末端速度衰减到初值的 2% 以下,分窗包络严格下降", () => {
    const solver = makeSolver();
    const restTipY = 2 - 12 * LINK;
    const windows: number[] = [];
    for (let w = 0; w < 10; w += 1) {
      let peak = 0;
      for (let i = 0; i < 60; i += 1) {
        solver.step();
        const tip = solver.tipPosition(0);
        const deviation = Math.hypot(tip[0] - 0, tip[2] - 0, tip[1] - restTipY);
        peak = Math.max(peak, deviation);
      }
      windows.push(peak);
    }
    console.log(`[T18 hair] tip deviation envelope: ${windows.map((v) => v.toFixed(4)).join(" -> ")}`);
    const finalSpeed = solver.tipSpeed(0);
    console.log(`[T18 hair] final tip speed = ${finalSpeed.toFixed(6)} m/s`);
    for (let w = 1; w < windows.length; w += 1) expect(windows[w]).toBeLessThan(windows[w - 1]);
    expect(finalSpeed).toBeLessThan(0.02);
  });

  it("链根在全程严格锚定", () => {
    const solver = makeSolver();
    const start = solver.capture();
    runTicks(solver, 300);
    const end = solver.capture();
    for (let c = 0; c < solver.chainCount; c += 1) {
      const root = chainBaseOffset([12, 12, 12], c);
      expect(end.px[root]).toBe(start.px[root]);
      expect(end.py[root]).toBe(start.py[root]);
    }
  });
});

describe("确定性:同 seed 逐位重放 + 局部回放", () => {
  it("两次独立运行逐位一致;异 seed 发散", () => {
    const a = makeSolver();
    const b = makeSolver();
    runTicks(a, 300);
    runTicks(b, 300);
    expect(fingerprint(a)).toBe(fingerprint(b));
    const c = makeSolver({ seed: 1819 });
    runTicks(c, 300);
    expect(fingerprint(c)).not.toBe(fingerprint(a));
  });

  it("局部回放:从第 150 步快照重放 150 步与连续运行逐位一致", () => {
    const a = makeSolver();
    runTicks(a, 300);
    const b = makeSolver();
    runTicks(b, 150);
    const snapshot = b.capture();
    expect(snapshot.tick).toBe(150);
    replayFromStep(b, snapshot, 150);
    expect(fingerprint(b)).toBe(fingerprint(a));
  });
});
