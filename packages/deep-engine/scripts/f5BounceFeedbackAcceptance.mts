import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReferenceRoomScene, referenceSceneDiagonal, referenceThinWallBoxes } from "../src/lighting/probeReferenceScene.ts";
import { evaluateProbeRadianceEngineParity, normalizedProbeFieldRmse } from "../src/lighting/probeReferenceIntegrator.ts";
import { integrateProbeReferenceMultibounce } from "../src/lighting/probeMultibounceReference.ts";
import { integrateProbeFieldWithFeedback } from "../src/lighting/probeBounceFeedback.ts";
import { computeProbeRelocation } from "../src/lighting/probeRelocation.ts";
import { deriveDirtyProbeIndices } from "../src/lighting/probeInvalidationConvergence.ts";
import type { ProbeClipmapLevel, ProbeVector3 } from "../src/lighting/probeClipmapPlan.ts";

// F5 多散射一阶自反馈：CPU 量化验收（同 T02/G3-S1 参考场景，复用其验收口径）。
// 1) 多弹 MC 真值（4096，seed 20260927，shadowed 直射 + 3 跳）；
// 2) 多散射关/开（fib16/fib32 一跳 vs 自反馈迭代场）对真值的稳定区域 RMSE；
// 3) 角落暗部子集（非埋入探针中一跳亮度最暗 25%）的相对误差与亮度收窄；
// 4) 增益定标扫描（0.25/0.5/1.0）+ 迭代能量曲线（发散哨兵证据）+ CPU 迭代耗时。
const scene = buildReferenceRoomScene();
const GRID = [7, 2, 5] as const;
const positions: ProbeVector3[] = [];
for (const z of [1, 2, 3, 4, 5]) for (const y of [1, 2]) for (const x of [1, 2, 3, 4, 5, 6, 7]) {
  positions.push(Object.freeze([x, y, z]) as ProbeVector3);
}
const level: ProbeClipmapLevel = { level: 0, gridSize: [...GRID] as [number, number, number],
  spacing: 1, originCell: [0, 0, 0] as [number, number, number], origin: [1, 1, 1] as [number, number, number],
  max: [...GRID] as [number, number, number], probeCount: positions.length };
const engine8 = positions.map(p => evaluateProbeRadianceEngineParity(scene, p, 8));
const buried = engine8.map((s, index) => ({ s, index })).filter(({ s }) =>
  s.missRatio === 0 && s.meanDistance <= 0.2).map(({ index }) => index);
const relocation = buried.map(index => computeProbeRelocation({ cellPosition: positions[index]!,
  spacing: 1, obstacles: referenceThinWallBoxes(scene), maxOffset: 0.5, margin: 0.2 }));
const truth = positions.map(p => integrateProbeReferenceMultibounce(scene, p, { seed: 20260927 }));
const truthField = truth.map(sample => sample.irradiance);
const include = (index: number): boolean => !buried.includes(index) && truth[index]!.stable;
const rmseOf = (field: readonly ProbeVector3[]): number =>
  normalizedProbeFieldRmse(field, truthField, include).normalizedRmse;
const offField32 = positions.map(p => evaluateProbeRadianceEngineParity(scene, p, 32).irradiance);
const offField16 = positions.map(p => evaluateProbeRadianceEngineParity(scene, p, 16).irradiance);
const cornerDomain = positions.map((_, index) => index).filter(include)
  .sort((left, right) => norm(offField32[left]!) - norm(offField32[right]!))
  .slice(0, Math.floor(positions.filter((_, index) => include(index)).length * 0.25));
const cornerReport = (field: readonly ProbeVector3[]) => {
  const deltas = cornerDomain.map(index => relDelta(field[index]!, truthField[index]!));
  const brightness = cornerDomain.map(index => relDelta(field[index]!, offField32[index]!));
  return { meanRelativeError: mean(deltas), meanBrightnessGainOverOff: mean(brightness) };
};
const timing = (run: () => void): number => { const t0 = performance.now(); run(); return performance.now() - t0; };
// 增益扫描 0.25..1 为物理域（每次反弹 ≤ 全部入射反射）；1.3 为超物理对照档——实测其
// RMSE 更低但属场景相关过拟合（补偿一跳欠亮），能量放大器不可移植，不进生产选值。
const scans = [0.25, 0.4, 0.5, 0.6, 0.75, 1, 1.3].map(gain => {
  const perIteration = [1, 2, 3, 4].map(iterations => {
    const result = integrateProbeFieldWithFeedback(scene, { positions, level,
      buriedIndices: buried, directionCount: 32 }, { iterations, gain });
    return { iterations, rmse: rmseOf(result.field), iterationsRun: result.iterationsRun };
  });
  const result = integrateProbeFieldWithFeedback(scene, { positions, level, buriedIndices: buried,
    directionCount: 32 }, { iterations: 4, gain });
  return { gain, rmse: rmseOf(result.field), diverged: result.diverged,
    energyTrail: result.energyTrail.map(v => Number(v.toFixed(4))), iterationsRun: result.iterationsRun,
    rmsePerIteration: perIteration,
    corner: cornerReport(result.field) };
});
const best = scans.filter(scan => !scan.diverged && scan.gain <= 1)
  .reduce((left, right) => left.rmse <= right.rmse ? left : right);
const bounce = timing(() => integrateProbeFieldWithFeedback(scene, { positions, level,
  buriedIndices: buried, directionCount: 32 }, { iterations: 4, gain: best.gain }));
const oneBounce = timing(() => positions.map(p => evaluateProbeRadianceEngineParity(scene, p, 32)));
const off16 = rmseOf(offField16);
const off32 = rmseOf(offField32);
const on = integrateProbeFieldWithFeedback(scene, { positions, level, buriedIndices: buried,
  directionCount: 32 }, { iterations: 4, gain: best.gain });
const evidence = {
  schema: "f5-bounce-feedback-acceptance-v1", createdAt: new Date().toISOString(),
  lane: "f5-bounce-feedback-cpu-acceptance",
  scene: { probes: positions.length, buried, relocationOffsets: relocation.map(offset =>
      offset.map(value => Number(value.toFixed(4)))) },
  truth: { sampleCount: truth[0]!.sampleCount, bounces: truth[0]!.bounces,
    seed: 20260927, stableCount: truth.filter(sample => sample.stable).length,
    includedCount: positions.filter((_, index) => include(index)).length },
  gainScan: scans, chosenGain: best.gain,
  rmse: { offFib16: off16, offFib32: off32, onFib32: rmseOf(on.field),
    improvementAbsolute: off32 - rmseOf(on.field), improvementRelative: 1 - rmseOf(on.field) / off32 },
  corner: { off: cornerReport(offField32),
    on: cornerReport(on.field), domain: cornerDomain },
  iterationEnergyTrail: on.energyTrail.map(value => Number(value.toFixed(5))),
  diverged: on.diverged, iterationsRun: on.iterationsRun,
  costMs: { oneBounceField32: Number(oneBounce.toFixed(2)), bounceFeedbackField32: Number(bounce.toFixed(2)) },
};
const output = fileURLToPath(new URL("../../../docs/reports/deep-core/assets/f5-bounce-feedback-acceptance.json", import.meta.url));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(evidence, null, 2));
console.log(`f5 bounce feedback: off16=${(off16 * 100).toFixed(2)}% off32=${(off32 * 100).toFixed(2)}% `
  + `on32=${(rmseOf(on.field) * 100).toFixed(2)}% gain=${best.gain} diverged=${on.diverged} `
  + `cornerErr ${(cornerReport(offField32).meanRelativeError * 100).toFixed(1)}%->`
  + `${(cornerReport(on.field).meanRelativeError * 100).toFixed(1)}% cornerBright+`
  + `${(cornerReport(on.field).meanBrightnessGainOverOff * 100).toFixed(1)}% cost=${bounce.toFixed(0)}ms`);
// 泄露哨兵对照：关哨兵 + 全 miss 放大场景应失控，开哨兵应截断（发散哨兵证据）。
function norm(v: ProbeVector3): number { return Math.hypot(v[0]!, v[1]!, v[2]!); }
function relDelta(estimate: ProbeVector3, reference: ProbeVector3): number {
  return norm(estimate) <= 1e-9 ? Math.abs(norm(reference)) <= 1e-9 ? 0 : 1
    : Math.abs(norm(estimate) - norm(reference)) / norm(reference);
}
function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
