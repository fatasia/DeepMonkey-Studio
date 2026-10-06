/**
 * G1 桥缺口 2 —— bake↔dgc 误差域标定实证脚本(quick_sphere/synthetic50k 双样本)。
 *
 * 口径(与 dgcClusterLodBridge.ts 的统一域合同一致):
 *   bake error 序列   = bakeClusterLodDag 节点 error(聚类 cell 边长,level0=0,k≥1 单级量);
 *   dgc error 序列    = buildMeshletDag(TS 权威实现,与 golden fixture 逐位钉死)层 error
 *                       (累计顶点位移,统一域真值);
 *   α = median( 全部 (样本, 层级) 的 Δdgc_k / bakeCell_k ),Δdgc_k = dgcErr[k] - dgcErr[k-1]。
 * 验证:BAKE_CELL_ERROR_TO_DISPLACEMENT 是否等于该双样本中位数;并输出映射后的
 * 累计序列与 dgc 真值的逐级偏差(统一域漂移率)作为合同声明的量化证据。
 *
 * 运行:pnpm --filter @bim-studio/deep-engine exec tsx scripts/g1BridgeErrorCalibration.ts
 * 证据:test-output/G1BRIDGE2-error-calibration.json(不入库,交付时归档)。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildMeshletDag } from "../src/geometry/meshletDag.js";
import { bakeClusterLodDag } from "../src/rayTracing/clusterLodBake.js";
import { BAKE_CELL_ERROR_TO_DISPLACEMENT, calibrateBakeErrorToDisplacement } from "../src/geometry/dgcClusterLodBridge.js";
import { b64ToBytes, type GoldenJson } from "../src/geometry/dgcEncoder.testUtils.js";

const FIXTURES = new URL("../../deep-engine-native/geometry_dag/tests/fixtures/", import.meta.url);
const EVIDENCE_DIR = new URL("../test-output/", import.meta.url);

/** dgc 臂网格与层序列必须与 golden 逐位一致——golden 是 Rust↔TS 逐位对拍存档,先钉再标定。 */
function loadPinnedSample(name: string) {
  const json = JSON.parse(readFileSync(new URL(`${name}.golden.json`, FIXTURES), "utf8")) as GoldenJson;
  const geometry = {
    positions: new Float32Array(b64ToBytes(json.input.positionsB64).buffer),
    indices: new Uint32Array(b64ToBytes(json.input.indicesB64).buffer),
  };
  const dag = buildMeshletDag(geometry, { levels: json.levels.length, maxTriangles: json.options.maxTriangles });
  if (dag.levels.length !== json.levels.length) {
    throw new Error(`${name}: dgc arm level count ${dag.levels.length} != golden ${json.levels.length}`);
  }
  json.levels.forEach((level, k) => {
    if (dag.levels[k]!.error !== level.error) {
      throw new Error(`${name}: dgc arm error drift at L${k}: ${dag.levels[k]!.error} != golden ${level.error}`);
    }
  });
  return { name, geometry, golden: json, dgcErrors: dag.levels.map((level) => level.error) };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** 复刻 bake 链 simplifyByVertexClustering 的 cell 键与质心聚合:测 bake 自身单级最大位移
 *  (次级口径,仅作"0.85 由来"的解释证据——bake 链自洽标定,不是统一域口径)。 */
function bakeChainSelfDisplacement(vertices: Float32Array, cell: number): number {
  const cells = new Map<string, { sum: [number, number, number]; count: number }>();
  for (let v = 0; v < vertices.length / 3; v++) {
    const x = vertices[v * 3]!, y = vertices[v * 3 + 1]!, z = vertices[v * 3 + 2]!;
    const key = `${Math.floor(x / cell)}|${Math.floor(y / cell)}|${Math.floor(z / cell)}`;
    const entry = cells.get(key) ?? { sum: [0, 0, 0] as [number, number, number], count: 0 };
    entry.sum[0]! += x; entry.sum[1]! += y; entry.sum[2]! += z; entry.count += 1;
    cells.set(key, entry);
  }
  let maxDisp = 0;
  for (let v = 0; v < vertices.length / 3; v++) {
    const x = vertices[v * 3]!, y = vertices[v * 3 + 1]!, z = vertices[v * 3 + 2]!;
    const entry = cells.get(`${Math.floor(x / cell)}|${Math.floor(y / cell)}|${Math.floor(z / cell)}`)!;
    maxDisp = Math.max(maxDisp, Math.hypot(x - entry.sum[0]! / entry.count, y - entry.sum[1]! / entry.count, z - entry.sum[2]! / entry.count));
  }
  return maxDisp;
}

interface SampleEvidence {
  name: string;
  triangles: number;
  dgcErrors: number[];
  bakeCellSizes: number[];
  perLevel: { level: number; dgcIncrement: number; bakeCell: number; ratio: number; bakeSelfDisplacement: number; bakeSelfRatio: number }[];
  mappedSeries: number[];
  mappedDeviation: { level: number; mapped: number; dgcTrue: number; relative: number }[];
  maxAbsRelativeDeviation: number;
}

const samples: SampleEvidence[] = [];
const pooledRatios: { sample: string; level: number; ratio: number }[] = [];

for (const name of ["quick_sphere", "synthetic50k"] as const) {
  const sample = loadPinnedSample(name);
  // bake 臂:同一源网格、与 dgc 臂相同的层数;level0ClusterSize=64 与 golden 构建参数同粒度。
  const baked = bakeClusterLodDag({
    geometryId: sample.name,
    vertices: sample.geometry.positions,
    indices: sample.geometry.indices,
    level0ClusterSize: 64,
    levelCount: sample.golden.levels.length,
  });
  const bakeCellSizes: number[] = [];
  for (let level = 1; level < sample.golden.levels.length; level++) {
    const levelNodes = baked.dag.nodes.filter((node) => node.level === level);
    if (levelNodes.length === 0) throw new Error(`${name}: bake arm produced no level ${level} nodes`);
    const uniqueErrors = new Set(levelNodes.map((node) => node.error));
    if (uniqueErrors.size !== 1) throw new Error(`${name}: bake level ${level} error is not uniform: ${[...uniqueErrors]}`);
    bakeCellSizes.push(levelNodes[0]!.error);
  }
  const dgcErrors = sample.dgcErrors;
  const mappedSeries = calibrateBakeErrorToDisplacement([0, ...bakeCellSizes]).slice(1);
  const perLevel = bakeCellSizes.map((cell, index) => {
    const level = index + 1;
    const dgcIncrement = dgcErrors[level]! - dgcErrors[level - 1]!;
    const ratio = dgcIncrement / cell;
    // 次级口径:bake 链自身该级 simplify 的实测最大质心位移 / cell(0.85 的可能由来)。
    const prior = level === 1 ? sample.geometry.positions : baked.levelGeometry[level - 1]!.vertices;
    const bakeSelfDisplacement = bakeChainSelfDisplacement(prior, cell);
    pooledRatios.push({ sample: name, level, ratio });
    return { level, dgcIncrement, bakeCell: cell, ratio, bakeSelfDisplacement, bakeSelfRatio: bakeSelfDisplacement / cell };
  });
  // 偏差对齐:mappedSeries[k] 是 level k+1 的映射值,与 dgcErrors[k+1](该层累计真值)比。
  const mappedDeviation = mappedSeries.map((mapped, index) => {
    const level = index + 1;
    const dgcTrue = dgcErrors[level]!;
    return { level, mapped, dgcTrue, relative: dgcTrue === 0 ? 0 : (mapped - dgcTrue) / dgcTrue };
  });
  samples.push({
    name,
    triangles: sample.geometry.indices.length / 3,
    dgcErrors,
    bakeCellSizes,
    perLevel,
    mappedSeries,
    mappedDeviation,
    maxAbsRelativeDeviation: Math.max(...mappedDeviation.map((row) => Math.abs(row.relative))),
  });
}

const derivedAlpha = median(pooledRatios.map((entry) => entry.ratio));
const pinnedAlpha = BAKE_CELL_ERROR_TO_DISPLACEMENT;
const alphaDeviation = Math.abs(derivedAlpha - pinnedAlpha);
const verdict = alphaDeviation <= 0.02
  ? `成立:|derived−pinned| = ${alphaDeviation.toFixed(6)} ≤ 0.02`
  : `不成立:双样本中位数 α = ${derivedAlpha.toFixed(6)},与常量 ${pinnedAlpha} 偏差 ${alphaDeviation.toFixed(6)} > 0.02 → 应修正常量`;

const evidence = {
  schema: "deep-engine.g1-bridge-error-calibration/1",
  caliber: "α = median(Δdgc_k / bakeCell_k) over (quick_sphere, synthetic50k) × (levels ≥ 1); 统一域 = 累计顶点位移",
  derivedAlpha,
  pinnedAlpha,
  alphaAbsoluteDeviation: alphaDeviation,
  verdict,
  samples,
  pooledRatios,
};
mkdirSync(EVIDENCE_DIR, { recursive: true });
const evidencePath = new URL("G1BRIDGE2-error-calibration.json", EVIDENCE_DIR);
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

console.log("=== G1 桥缺口 2 标定实证(双样本) ===");
for (const sample of samples) {
  console.log(`\n[${sample.name}] triangles=${sample.triangles}`);
  for (const row of sample.perLevel) {
    console.log(`  L${row.level}: dgcΔ=${row.dgcIncrement.toPrecision(9)} bakeCell=${row.bakeCell.toPrecision(9)} ratio=${row.ratio.toFixed(6)} | bake自测位移=${row.bakeSelfDisplacement.toPrecision(6)} 自测比=${row.bakeSelfRatio.toFixed(4)}`);
  }
  console.log(`  dgcErrors      = ${sample.dgcErrors.map((value) => value.toPrecision(9)).join(", ")}`);
  console.log(`  mapped(α→累计) = ${sample.mappedSeries.map((value) => value.toPrecision(9)).join(", ")}`);
  for (const row of sample.mappedDeviation) {
    console.log(`  偏差 L${row.level}: mapped=${row.mapped.toPrecision(9)} vs 真值=${row.dgcTrue.toPrecision(9)} (${(row.relative * 100).toFixed(2)}%)`);
  }
  console.log(`  max|相对偏差|  = ${(sample.maxAbsRelativeDeviation * 100).toFixed(2)}%`);
}
console.log(`\n双样本中位数 α = ${derivedAlpha.toFixed(9)};常量 = ${pinnedAlpha}`);
console.log(`裁决:${verdict}`);
if (alphaDeviation > 0.02) process.exitCode = 1;
