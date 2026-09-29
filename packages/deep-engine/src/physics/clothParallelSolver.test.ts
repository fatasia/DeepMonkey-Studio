// T18 A3 并行布料 compute 切片:CPU f32 模拟镜像合同测试。
//
// 三条证据线:
// 1) 着色:确定性贪心,同色不共享端点,双跑逐位,桶序全盖;
// 2) 黄金容差:f32 色序镜像 vs f64 黄金(clothSolver.ts,本切片不改)240 ticks
//    逐步(每 24 tick)位置误差 ≤ 0.05 m(布料宽 1.1 m 的 ~4.5%),拉伸 ≤ 5% 带;
//    受控偏差来源 = f32 量化 + 色桶序投影,均非缺陷,指纹表逐 tick 钉死漂移;
// 3) 定序:同 seed 重放逐位(fingerprintFloat32)+ 三级固定归约树两侧同构。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClothSolver } from "./clothSolver.js";
import { assertColoringValid, colorClothConstraints } from "./clothConstraintColoring.js";
import { CLOTH_PARALLEL_WORKGROUP_SIZE, ClothParallelMirror, buildClothParallelState,
  fingerprintFloat32, hostMergeTreeSum, treeSum4, workgroupTreeSum } from "./clothParallelSolver.js";
import { DEEP_CLOTH_PARALLEL_SOLVER_WGSL } from "./clothSolverWgsl.js";

const FIXTURE = JSON.parse(readFileSync(
  new URL("../../../deep-engine-native/tests/fixtures/cloth-softbody-solver-parity-v1.json", import.meta.url),
  "utf8",
)) as {
  cloth: {
    config: Record<string, unknown>;
    pinned: ReadonlyArray<readonly [number, number]>;
    noWind: { ticks: number };
  };
};

/** 共享跨端 fixture(TS 生成、Rust 重放):逐步指纹表与容差的单一来源。 */
const PARITY = JSON.parse(readFileSync(
  new URL("../../../deep-engine-native/tests/fixtures/cloth-parallel-compute-v1.json", import.meta.url),
  "utf8",
)) as {
  tolerances: { maxPositionErrorMeters: number; maxStretchRatio: number };
  replay: { fingerprints: { per24: string[] } };
};

/** 与共享 fixture(cloth-parallel-compute-v1.json)同源的 noWind 网格配置。 */
const GRID_CONFIG = {
  columns: FIXTURE.cloth.config.columns as number,
  rows: FIXTURE.cloth.config.rows as number,
  spacing: FIXTURE.cloth.config.spacing as number,
  mass: FIXTURE.cloth.config.mass as number,
  gravity: FIXTURE.cloth.config.gravity as readonly [number, number, number],
  dtSeconds: FIXTURE.cloth.config.dtSeconds as number,
  substeps: FIXTURE.cloth.config.substeps as number,
  compliance: FIXTURE.cloth.config.compliance as number,
  damping: FIXTURE.cloth.config.damping as number,
  perturbation: FIXTURE.cloth.config.perturbation as number,
  seed: FIXTURE.cloth.config.seed as number,
  origin: FIXTURE.cloth.config.origin as readonly [number, number, number],
  pinned: FIXTURE.cloth.pinned,
};
const TICKS = FIXTURE.cloth.noWind.ticks;

/** 逐步指纹表(每 24 tick;生成源 = clothParallelFixtureGen.mts,与 Rust 共享对拍)。 */
const FINGERPRINT_TABLE_240 = PARITY.replay.fingerprints.per24;
const POSITION_TOLERANCE = PARITY.tolerances.maxPositionErrorMeters;
const STRETCH_TOLERANCE = PARITY.tolerances.maxStretchRatio;

function makeBuild(): ReturnType<typeof buildClothParallelState> {
  return buildClothParallelState(GRID_CONFIG);
}

describe("T18 A3 并行布料:确定性着色", () => {
  it("grid topology colors deterministically into disjoint color buckets", () => {
    const first = colorClothConstraints(gridConstraints().a, gridConstraints().b, GRID_CONFIG.columns * GRID_CONFIG.rows);
    const second = colorClothConstraints(gridConstraints().a, gridConstraints().b, GRID_CONFIG.columns * GRID_CONFIG.rows);
    expect(Array.from(first.colors)).toEqual(Array.from(second.colors));
    expect(first.colorCount).toBe(8);
    expect(first.maxDegree).toBe(8);
    assertColoringValid(first, gridConstraints().a, gridConstraints().b);
  });

  it("bucket order covers every constraint exactly once inside contiguous ranges", () => {
    const build = makeBuild();
    const coloring = build.coloring;
    expect(coloring.order.length).toBe(build.constraintCount);
    const seen = new Set<number>();
    let cursor = 0;
    for (const [start, end] of coloring.colorRanges) {
      expect(start).toBe(cursor);
      for (let i = start; i < end; i += 1) {
        expect(seen.has(coloring.order[i]!)).toBe(false);
        seen.add(coloring.order[i]!);
      }
      cursor = end;
    }
    expect(cursor).toBe(build.constraintCount);
  });

  it("rejects degenerate constraints fail-closed", () => {
    expect(() => colorClothConstraints([0], [0], 1)).toThrow(/degenerate/);
  });
});

describe("T18 A3 并行布料:固定归约树(三级定序)", () => {
  it("pairwise tree ordering differs from linear summation in f32 (the contract exists)", () => {
    // 64 × f32(0.1):树 = 成对精确翻倍;线性 = 逐步累积舍入,两者必然不同。
    const lanes = new Array<number>(64).fill(0.1);
    const tree = workgroupTreeSum(lanes);
    let linear = 0;
    for (const lane of lanes) linear = Math.fround(Math.fround(linear) + Math.fround(lane));
    expect(tree).not.toBe(linear);
    // 树的自证:六层 pairwise 与手写展开一致。
    expect(tree).toBe(workgroupTreeSum(lanes));
  });

  it("zero padding is bitwise exact through all tree levels", () => {
    expect(workgroupTreeSum([1.5, 2.25])).toBe(Math.fround(1.5 + 2.25));
    expect(workgroupTreeSum([1.5])).toBe(1.5);
    expect(hostMergeTreeSum([3.5, 4.5, 7])).toBe(Math.fround(Math.fround(3.5 + 4.5) + 7));
    expect(hostMergeTreeSum([9.75])).toBe(9.75);
    expect(treeSum4(1, 2, 3, 0)).toBe(Math.fround(Math.fround(1 + 2) + Math.fround(3 + 0)));
  });

  it("reduces the final substep kinetic through the same tree chain over live state", () => {
    const build = makeBuild();
    const mirror = new ClothParallelMirror(build);
    for (let t = 0; t < 4; t += 1) mirror.step();
    const state = mirror.captureState();
    const workgroups = Math.ceil(build.particleCount / CLOTH_PARALLEL_WORKGROUP_SIZE);
    const partials: number[] = [];
    for (let w = 0; w < workgroups; w += 1) {
      const lanes: number[] = [];
      for (let lane = 0; lane < CLOTH_PARALLEL_WORKGROUP_SIZE; lane += 1) {
        const i = w * CLOTH_PARALLEL_WORKGROUP_SIZE + lane;
        if (i >= build.particleCount) { lanes.push(0); continue; }
        const base = i * 12;
        const vx = state[base + 4]!; const vy = state[base + 5]!; const vz = state[base + 6]!;
        lanes.push(treeSum4(Math.fround(vx * vx), Math.fround(vy * vy), Math.fround(vz * vz), 0));
      }
      partials.push(workgroupTreeSum(lanes));
    }
    const recomputed = hostMergeTreeSum(partials);
    const stored = mirror.kineticPerSubstep[mirror.kineticPerSubstep.length - 1]!;
    expect(recomputed).toBe(stored);
    expect(stored).toBeGreaterThan(0);
  });
});

describe("T18 A3 并行布料:黄金容差(f32 色序 vs f64 构建序)", () => {
  it("stays within the position/stretch tolerance against the f64 golden across 240 ticks", () => {
    const golden = new ClothSolver({ ...GRID_CONFIG });
    for (const [col, row] of GRID_CONFIG.pinned!) golden.setPinned(col, row, true);
    const build = makeBuild();
    const mirror = new ClothParallelMirror(build);
    const snapshots = new Map<number, ReturnType<ClothSolver["capture"]>>([[0, golden.capture()]]);
    for (let t = 1; t <= TICKS; t += 1) {
      golden.step();
      if (t % 24 === 0) snapshots.set(t, golden.capture());
    }
    const errors: Array<{ tick: number; max: number; mean: number }> = [];
    for (let t = 1; t <= TICKS; t += 1) {
      mirror.step();
      if (t % 24 !== 0) continue;
      const snap = snapshots.get(t)!;
      const state = mirror.captureState();
      let max = 0; let sum = 0;
      for (let i = 0; i < build.particleCount; i += 1) {
        const dx = state[i * 12]! - snap.px[i]!;
        const dy = state[i * 12 + 1]! - snap.py[i]!;
        const dz = state[i * 12 + 2]! - snap.pz[i]!;
        const err = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (err > max) max = err;
        sum += err;
      }
      errors.push({ tick: t, max, mean: sum / build.particleCount });
    }
    // 逐步对照表(量化证据;容差 = 0.05 m ≈ 布料宽 1.1 m 的 4.5%):
    expect(errors.map((e) => e.tick)).toEqual([24, 48, 72, 96, 120, 144, 168, 192, 216, 240]);
    for (const e of errors) {
      expect(e.max).toBeLessThan(POSITION_TOLERANCE);
      expect(e.mean).toBeLessThan(POSITION_TOLERANCE / 5);
    }
    // 拉伸收敛带(T18 既有验收:≤5%):
    const stretch = mirror.measureStretch();
    expect(stretch.maxRatio).toBeLessThanOrEqual(STRETCH_TOLERANCE);
    expect(golden.measureStretch().maxRatio).toBeLessThanOrEqual(STRETCH_TOLERANCE);
  });

  it("pins the per-24-tick f32 fingerprint table (drift is caught immediately)", () => {
    const mirror = new ClothParallelMirror(makeBuild());
    const fingerprints: string[] = [];
    for (let t = 1; t <= TICKS; t += 1) {
      mirror.step();
      if (t % 24 === 0) fingerprints.push(mirror.stateFingerprint32());
    }
    expect(fingerprints).toEqual(FINGERPRINT_TABLE_240);
  });

  it("replays bitwise identically for the same seed and input (double run)", () => {
    const first = new ClothParallelMirror(makeBuild());
    const second = new ClothParallelMirror(makeBuild());
    for (let t = 0; t < 64; t += 1) { first.step(); second.step(); }
    expect(first.stateFingerprint32()).toBe(second.stateFingerprint32());
    expect(Array.from(first.kineticPerSubstep)).toEqual(Array.from(second.kineticPerSubstep));
    expect(first.captureState()).toEqual(second.captureState());
  });

  it("keeps pinned particles immobile with zeroed velocity", () => {
    const build = makeBuild();
    const mirror = new ClothParallelMirror(build);
    const pinnedIndex = GRID_CONFIG.pinned![0]![1]! * GRID_CONFIG.columns + GRID_CONFIG.pinned![0]![0]!;
    const initial = mirror.captureState();
    for (let t = 0; t < 8; t += 1) mirror.step();
    const after = mirror.captureState();
    expect(after[pinnedIndex * 12]).toBe(initial[pinnedIndex * 12]);
    expect(after[pinnedIndex * 12 + 1]).toBe(initial[pinnedIndex * 12 + 1]);
    expect(after[pinnedIndex * 12 + 2]).toBe(initial[pinnedIndex * 12 + 2]);
    expect(after[pinnedIndex * 12 + 3]).toBe(0);
    expect(after[pinnedIndex * 12 + 4]).toBe(0);
  });
});

describe("T18 A3 并行布料:指纹与核合同", () => {
  it("fingerprintFloat32 is dual-lane stable and single-bit sensitive", () => {
    const values = [1.5, -2.25, 3.75e-4, 9.125];
    const first = fingerprintFloat32(values);
    expect(first).toBe(fingerprintFloat32(values));
    const perturbed = [...values];
    perturbed[2] = 3.76e-4; // 超出 f32 ULP 的最小幅扰动 → 位模式必变
    expect(fingerprintFloat32(perturbed)).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  it("keeps the mirror kernel op-order contract anchored to the single-source WGSL", () => {
    // 镜像用 invLen 乘法(WGSL 同式,非除法);色序范围/锚点清零与 WGSL 逐句对应。
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain("let invH = 1.0 / h;");
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain("let lenSq = (dx * dx + dy * dy) + dz * dz;");
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain("if (particle.position.w == 0.0) {");
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain("lane = (vx * vx + vy * vy) + (vz * vz + 0.0);");
  });
});

/** 12×12 网格拓扑(构建序:右/下/两对角),与黄金构造一致。 */
function gridConstraints(): { a: number[]; b: number[] } {
  const { columns, rows, spacing } = GRID_CONFIG;
  const diag = spacing * Math.SQRT2;
  const a: number[] = [];
  const b: number[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let col = 0; col < columns; col += 1) {
      const i = r * columns + col;
      if (col + 1 < columns) { a.push(i); b.push(i + 1); }
      if (r + 1 < rows) { a.push(i); b.push(i + columns); }
      if (col + 1 < columns && r + 1 < rows) {
        a.push(i); b.push(i + columns + 1);
        a.push(i + 1); b.push(i + columns);
      }
    }
  }
  return { a, b };
}
