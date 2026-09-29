// 生成共享 fixture:cloth-parallel-compute-v1.json(T18 A3 并行布料跨端对拍)。
// TS f32 模拟镜像是该合同的生成源;Rust 测试(cloth_parallel_compute_parity.rs)
// 用自带纯 Rust 着色/f32 求解器/固定归约树重放,与夹具逐位对拍。
// 运行:node_modules/.bin/tsx scripts/clothParallelFixtureGen.mts(生成后入库)。
import { readFileSync, writeFileSync } from "node:fs";
import { colorClothConstraints } from "../src/physics/clothConstraintColoring.js";
import { ClothParallelMirror, buildClothParallelState, fingerprintFloat32,
  hostMergeTreeSum, treeSum4, workgroupTreeSum } from "../src/physics/clothParallelSolver.js";

const FIXTURE_PATH = new URL("../../deep-engine-native/tests/fixtures/cloth-parallel-compute-v1.json", import.meta.url);
// 配置/pinned/ticks 从黄金指纹 fixture(J3 Gate C)同源读取,不手抄,杜绝漂移。
const GOLDEN = JSON.parse(readFileSync(
  new URL("../../deep-engine-native/tests/fixtures/cloth-softbody-solver-parity-v1.json", import.meta.url), "utf8"));
const GRID = GOLDEN.cloth.config;
const PINNED = GOLDEN.cloth.pinned;
const TICKS = GOLDEN.cloth.noWind.ticks;

// ── 网格着色 ──
const build = buildClothParallelState({ ...GRID, pinned: PINNED });
const coloring = build.coloring;
const { a, b } = gridConstraints();

// ── 非对称小拓扑着色(覆盖非网格场景;端点与色手工可核) ──
const small = colorClothConstraints([0, 1, 2, 3, 0, 4], [1, 2, 3, 0, 4, 5], 6);

// ── 固定归约树证据(64 × f32(0.1):树=成对精确翻倍,线性=逐步累积舍入) ──
const lanes = new Array(64).fill(0.1);
const treeSum = workgroupTreeSum(lanes);
let linear = 0;
for (const lane of lanes) linear = Math.fround(Math.fround(linear) + Math.fround(lane));
if (treeSum === linear) throw new Error("tree vs linear evidence collapsed; fixture is meaningless");
const hostPartials = [1.5, 2.25, 7];
const hostMerged = hostMergeTreeSum(hostPartials);

// ── 重放证据(240 ticks;Rust f32 求解器必须逐位复现) ──
const mirror = new ClothParallelMirror(build);
const per24: string[] = [];
for (let t = 1; t <= TICKS; t += 1) {
  mirror.step();
  if (t % 24 === 0) per24.push(mirror.stateFingerprint32());
}
const fp120 = per24[4]!;
const fp240 = per24[per24.length - 1]!;
const stretch = mirror.measureStretch();
const kineticLast = mirror.kineticPerSubstep[mirror.kineticPerSubstep.length - 1];

const fixture = {
  schema: "deep-engine.cloth-parallel-compute-parity",
  schemaVersion: 1,
  note: "T18 A3 并行布料 compute 跨端对拍:TS f32 模拟镜像(clothParallelSolver.ts)生成;Rust(cloth_parallel_compute_parity.rs)用自带纯 Rust 实现逐位重放。着色=贪心按约束索引序最小可用色;归约=三级固定树(lane pairwise→workgroup 64→宿主合并);指纹=FNV-1a 双车道 f32 小端。",
  tolerances: { maxPositionErrorMeters: 0.05, maxStretchRatio: 0.05 },
  grid: { ...GRID, pinned: PINNED, ticks: TICKS },
  coloring: {
    grid: {
      particleCount: build.particleCount, constraintCount: build.constraintCount,
      colorCount: coloring.colorCount, maxDegree: coloring.maxDegree,
      colors: Array.from(coloring.colors), order: Array.from(coloring.order),
      colorRanges: coloring.colorRanges,
    },
    small: {
      particleCount: 6, a: [0, 1, 2, 3, 0, 4], b: [1, 2, 3, 0, 4, 5],
      colorCount: small.colorCount, colors: Array.from(small.colors),
      order: Array.from(small.order), colorRanges: small.colorRanges,
    },
  },
  treeReduction: {
    lanes,
    // f32 位模式(u32):Rust 侧经 from_bits 精确重建 lane 值,不经 JSON 浮点解析路径。
    lanesF32Bits: lanes.map((lane) => new Uint32Array(new Float32Array([Math.fround(lane)]).buffer)[0]!),
    workgroupTreeSum: treeSum, linearSum: linear,
    hostPartials, hostMergeTreeSum: hostMerged,
  },
  replay: {
    fingerprints: { per24, tick120: fp120, tick240: fp240 },
    kineticLastSubstep: kineticLast,
    finalStretchMaxRatio: stretch.maxRatio,
    finalStretchMeanRatio: stretch.meanRatio,
    fingerprintOfEmptyState: fingerprintFloat32(new Float32Array(6)),
  },
};

writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
console.log(`written ${FIXTURE_PATH.pathname}`);
console.log(`colors=${coloring.colorCount} fp120=${fp120} fp240=${fp240} kinetic=${kineticLast} tree=${treeSum} linear=${linear}`);

function gridConstraints() {
  const { columns, rows, spacing } = GRID;
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
