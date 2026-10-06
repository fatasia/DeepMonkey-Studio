/**
 * P1 质量主线(六引擎对标刀位 1):native sdf-gi 双端对拍 fixture 生成器(TS 侧)。
 *
 * 单源 fixture:packages/deep-engine/fixtures/sdf-gi-native-parity-v1.json
 *   - TS 段:bakeSdfSceneGrid + deriveSdfGiProbeLattice + traceSdfSkyVisibilityWithHits
 *     + updateProbeShWithSdfGi 的生产 CPU 权威输出(f32 words + sha256 + f64 标量)。
 *   - Rust 段:无占位 —— native 镜像(sdf_gi_scene/sdf_gi_trace/sdf_gi_probe_update)
 *     从 inputs 段重算并与 TS 段位级对拍(deep-engine-native::sdf_gi_parity_tests)。
 * 重跑本脚本即可让 TS 权威行为变化显式落进 git diff。
 *
 * 运行:仓库根 `node_modules/.bin/tsx packages/deep-engine/scripts/generateSdfGiNativeParity.mts`
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bakeSdfSceneGrid, type SdfSceneBakeInstance } from "../src/gi/sdfSceneBake.js";
import { probeLatticeBounds } from "../src/gi/sdfGiBakePlan.js";
import { deriveSdfGiProbeLattice } from "../src/gi/sdfGiSceneAdapter.js";
import { resolveSdfSkyVisibilityTraceConfig, traceSdfSkyVisibilityWithHits }
  from "../src/gi/sdfSkyVisibility.js";
import { probeOcclusionDirection } from "../src/rayTracing/probeOcclusionRayExtension.js";
import { sdfGiProbeGeometryStats, planSdfGiProbeWindow, packInitialSdfGiRecords }
  from "../src/gi/sdfGiPacking.js";
import { updateProbeShWithSdfGi } from "../src/gi/probeShUpdate.js";
import { packIrradianceProbeRecord, type IrradianceProbeRecord }
  from "../src/lighting/probeClipmapSampling.js";

const sha256OfWords = (words: readonly number[]): string =>
  createHash("sha256").update(Buffer.from(Float32Array.from(words).buffer)).digest("hex");
const wordsOf = (values: ArrayLike<number>): number[] => Array.from(values, value => value);
const f64Json = (values: readonly number[]): number[] => [...values];

// ===== 黄金场景:单位盒(恒等)+ 斜切盒(scale 1.5 + 平移)+ 剪切盒(非对角 basis)
// + 动态排除副本。覆盖 transformPoint fround 链/逐实例域/min 合成/动态排除。=====
const unitBoxMesh = (): { positions: Float32Array; indices: Uint32Array } => {
  const corners: readonly [number, number, number][] = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const positions = new Float32Array(corners.flat());
  const indices = new Uint32Array([
    2, 1, 0, 3, 2, 0, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 6, 2, 3, 6, 3, 7,
    1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7,
  ]);
  return { positions, indices };
};

const box = unitBoxMesh();
const instances: SdfSceneBakeInstance[] = [
  { id: "box-a", mesh: box, transform: undefined },
  { id: "box-b", mesh: box,
    transform: {
      basis: [1.5, 0, 0, 0, 1.5, 0, 0, 0, 1.5],
      translation: [2.25, 0, 0.5],
    } },
  // 剪切 basis(x += 0.25·y):覆盖 transformPoint 的 4 项链 fround 落点。
  { id: "shear-c", mesh: box,
    transform: {
      basis: [1, 0.25, 0, 0, 1, 0, 0, 0, 1],
      translation: [0, 2, 0],
    } },
  { id: "dyn-d", mesh: box, dynamic: true },
];

const cellSize = 0.25;
const bake = bakeSdfSceneGrid(instances, { cellSize, instanceDomain: "aabb" });
const grid = bake.grid;
const latticeBounds = probeLatticeBounds(grid);
const lattice = deriveSdfGiProbeLattice(latticeBounds, Math.max(grid.cellSize * 4, 0.25), 4096);
const config = resolveSdfSkyVisibilityTraceConfig(grid, {});
const directionCount = 16;
const directions = Array.from({ length: directionCount },
  (_, ordinal) => probeOcclusionDirection(ordinal, directionCount));
const trace = traceSdfSkyVisibilityWithHits(grid, lattice.positions, directions, {});
const geometryStats = sdfGiProbeGeometryStats(trace.hitDistances, directionCount,
  config.maxDistance);

const skyRadianceRgb: readonly [number, number, number] = [0.9, 0.85, 0.8];
const directionSkyRadiance = directions.map(() => skyRadianceRgb);
const buried: IrradianceProbeRecord = {
  irradiance: [0.05, 0.04, 0.03], validity: 0, meanDistance: 0.4, distanceVariance: 0.09,
  occlusionFloor: 0.5, positionOffset: [0.01, 0.02, 0.03],
};
const firstPrevious: (IrradianceProbeRecord | undefined)[] = lattice.positions.map(
  (_, index) => index === 0 ? buried : undefined);
const first = updateProbeShWithSdfGi({
  previous: firstPrevious, positions: lattice.positions, directions,
  visibilities: trace.visibilities, directionSkyRadiance,
  bounceAlbedo: [0.5, 0.4, 0.3], geometryStats,
});
const temporal = updateProbeShWithSdfGi({
  previous: [...first.records], positions: lattice.positions, directions,
  visibilities: trace.visibilities, directionSkyRadiance, alpha: 0.35, geometryStats,
});
const window = planSdfGiProbeWindow(lattice.positions.length, 10, 2);
const initial = packInitialSdfGiRecords(lattice.positions.length, config.maxDistance);

const fixture = {
  fixtureSchema: "sdf-gi-native-parity-v1",
  generator: "packages/deep-engine/scripts/generateSdfGiNativeParity.mts",
  nativeTwin: "packages/deep-engine-native/src/sdf_gi_parity_tests.rs",
  tolerance: {
    // Rust 镜像按 f64 中间量 + fround 落点逐式同构 → CPU 对拍位级(无容差);
    // 以下仅用于 ①跨 libm 标量(trig/tan) sanity 与 ②真机 GPU WGSL 门。
    scalarRel: 1e-9,
    gpuVisibility: 0.01,
    gpuHitDistanceStepLengths: 1.0,
    gpuRecordWord: 0.002,
    gpuBakeCellMean: 0.01,
    gpuBakeCellMax: 0.15,
  },
  inputs: {
    cellSize,
    instanceDomain: "aabb",
    instances: instances.map(instance => ({
      id: instance.id,
      dynamic: instance.dynamic === true,
      positions: wordsOf(instance.mesh.positions),
      indices: wordsOf(instance.mesh.indices),
      basis: instance.transform?.basis ?? null,
      translation: instance.transform?.translation ?? null,
    })),
    directionCount,
    skyRadianceRgb: f64Json(skyRadianceRgb),
    alphaFirst: null,
    bounceAlbedo: [0.5, 0.4, 0.3],
    alphaTemporal: 0.35,
    windowBudget: 10,
    windowDispatched: 2,
  },
  bake: {
    report: {
      bakedCount: bake.report.bakedCount,
      cachedCount: bake.report.cachedCount,
      excludedDynamicCount: bake.report.excludedDynamicCount,
      skippedCount: bake.report.skippedCount,
      instanceStatuses: bake.report.instances.map(row =>
        ({ id: row.id, status: row.status, triangles: row.triangles,
          gridCells: row.gridCells ?? null, reason: row.reason ?? null })),
    },
    origin: f64Json(grid.origin),
    cellSize: grid.cellSize,
    dimensions: [...grid.dimensions],
    exteriorDistance: bake.report.exteriorDistance,
    distancesWords: wordsOf(grid.distances),
    distancesSha256: sha256OfWords(grid.distances),
    maxSamplingError: grid.maxSamplingError,
  },
  lattice: {
    boundsMin: f64Json(latticeBounds.min),
    boundsMax: f64Json(latticeBounds.max),
    dimensions: [...lattice.dimensions],
    spacing: lattice.spacing,
    positions: lattice.positions.map(f64Json),
  },
  trace: {
    steps: config.steps,
    coneTan: config.coneTan,
    maxDistance: config.maxDistance,
    directions: directions.map(f64Json),
    visibilitiesWords: wordsOf(trace.visibilities),
    visibilitiesSha256: sha256OfWords(trace.visibilities),
    hitDistancesWords: wordsOf(trace.hitDistances),
    hitDistancesSha256: sha256OfWords(trace.hitDistances),
    geometryStats: geometryStats.map(([mean, variance]) => [mean, variance]),
    probeWindow: { offset: window.offset, count: window.count },
    initialMeanDistance: config.maxDistance * 0.5,
    initialVariance: Math.max((config.maxDistance * 0.25) ** 2, 1e-4),
  },
  update: {
    first: {
      alpha: first.alpha,
      bounceSentinelTrips: first.bounceSentinelTrips,
      targetEnergy: first.targetEnergy,
      recordsWords: first.records.map(record => wordsOf(packIrradianceProbeRecord(record))),
      recordsSha256: sha256OfWords(first.records.flatMap(record =>
        Array.from(new Float32Array(packIrradianceProbeRecord(record))))),
      skyVisibilitySh: first.skyVisibilitySh.map(sh => (sh === undefined ? null : [...sh])),
      buriedPassthrough: {
        irradiance: [...buried.irradiance], validity: buried.validity,
        meanDistance: buried.meanDistance, distanceVariance: buried.distanceVariance,
        occlusionFloor: buried.occlusionFloor ?? null,
        positionOffset: buried.positionOffset ? [...buried.positionOffset] : null,
      },
    },
    temporal: {
      alpha: temporal.alpha,
      bounceSentinelTrips: temporal.bounceSentinelTrips,
      targetEnergy: temporal.targetEnergy,
      recordsWords: temporal.records.map(record => wordsOf(packIrradianceProbeRecord(record))),
      recordsSha256: sha256OfWords(temporal.records.flatMap(record =>
        Array.from(new Float32Array(packIrradianceProbeRecord(record))))),
      skyVisibilitySh: temporal.skyVisibilitySh.map(sh => (sh === undefined ? null : [...sh])),
    },
    initialRecordsWords: wordsOf(initial),
    initialRecordsSha256: sha256OfWords(initial),
  },
};

const outPath = resolve(import.meta.dirname!, "../fixtures/sdf-gi-native-parity-v1.json");
// JSON.stringify 丢 -0 符号(frame v8 同款教训):先以哨兵串占位再还原为 -0 字面量;
// JSON.parse("-0") === -0,Rust serde_json 同样保符号 —— 距离场/词流的 f32 符号位双端无损。
const serialized = JSON.stringify(fixture, (_key, value) => Object.is(value, -0) ? "__NEGZERO__" : value, 2)
  .replaceAll("\"__NEGZERO__\"", "-0");
writeFileSync(outPath, `${serialized}\n`);
console.log(`fixture written: ${outPath}`);
console.log(JSON.stringify({
  cells: grid.distances.length, probes: lattice.positions.length,
  exteriorDistance: bake.report.exteriorDistance,
  vis: trace.visibilities.length, firstTrips: first.bounceSentinelTrips,
  window, initialSha: fixture.update.initialRecordsSha256.slice(0, 12),
}, null, 2));
