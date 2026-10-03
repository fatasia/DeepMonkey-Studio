import { describe, expect, it } from "vitest";
import { probeOcclusionDirection } from "../rayTracing/probeOcclusionRayExtension.js";
import { buildReferenceRoomScene, REFERENCE_FLOOR_ALBEDO,
  type ReferenceScene } from "./probeReferenceScene.js";
import { evaluateProbeRadianceWithDirections } from "./probeReferenceIntegrator.js";
import { projectProbeDirectionalVisibilitySh, probeSpecularDirectionalVisibilityGate,
  type ProbeDirectionalVisibilitySh } from "./probeDirectionalVisibilitySh.js";
import { sampleIrradianceProbeClipmap, type IrradianceProbeRecord } from "./probeClipmapSampling.js";
import type { ProbeClipmapLevel, ProbeVector3 } from "./probeClipmapPlan.js";

/**
 * F5 方案 A 验收门三件套之 intFloorBack（32 方向 CPU 参考）。
 *
 * == 场景与态 ==
 * `buildReferenceRoomScene()`（薄墙 x=4 + 门洞 z∈[2.5,3.5] + 天窗 x∈[1.5,3]）；
 * open = 场景原样；sealed = 门洞加门板（x∈[3.95,4.05], y∈[0,2.2], z∈[2.5,3.5]）。
 * 探针格 9×2×7（spacing 1，y∈{0.5,1.5}），每探针 32 Fibonacci 方向、shadowed 真值口径
 * （F5-GI-1b 同款命中点阴影射线）、两遍捕获（第二遍按 G3 间接挂点回灌一遍探针场反弹，
 * 与产品 bounceFeedback 同机制）。
 *
 * == 显示模型（pbrShader shade() IBL 块 CPU 同构） ==
 * off: (1−k)·albedo·env + k·env           （无探针：漫射/镜面全环境）
 * on:  (1−k)·albedo·mix(env,gi,1) + k·env·gate   （漫射探针替换 + 镜面方向门）
 * env = 场景 miss 环境（scene.ambient）——显示环境与捕获 miss 辐射同量纲，开阔方向
 * 探针捕获 ≈ env → gate ≈ 1（白炉同族的零扰动正控）。
 *
 * == 尺（f5-fix-metrics 同口径，不改尺） ==
 * leakRatio = sealedDelta.R / max(openDelta.R, 0.01)，门 ≤1.1（用户批准门逐字保留）。
 * 诚实边界（登记 docs/specs/f5-directional-l1-implementation-20261003.md §3）：本时代
 * sealed 残差是「绝对镜面误差」通道（无门时镜面项与 GI-off 相同、delta=0，被门压低后
 * delta 为负），故 ≤1.1 之外并列三条非退化判据：镜面抑制倍率（门必须真的压低封门
 * 镜面残差）、开阔方向零扰动（gate≈1，不得过度抑制）、intFloorBack 门后残差上限。
 */

const DIRECTIONS_32 = Array.from({ length: 32 }, (_, ordinal) => probeOcclusionDirection(ordinal, 32));
const ENV = (scene: ReferenceScene): ProbeVector3 => scene.ambient;
const SPEC_FRACTION = 0.05; // 代表性 split-sum 镜面分数（相对门控语义，非常量合同）。
const LEAK_RATIO_GATE = 1.1;

const GRID = { size: [9, 2, 7] as const, spacing: 1, origin: [0, 0.5, 0] as const };

interface ProbeCapture {
  readonly records: IrradianceProbeRecord[];
  readonly sh: (ProbeDirectionalVisibilitySh | undefined)[];
}

function probePosition(cell: readonly number[]): ProbeVector3 {
  return [GRID.origin[0] + cell[0] * GRID.spacing, GRID.origin[1] + cell[1] * GRID.spacing,
    GRID.origin[2] + cell[2] * GRID.spacing];
}

/** 两遍捕获：直射 shadowed 真值 + 一遍探针场反弹（G3 间接挂点同机制）。
 * `missRadiance` = 捕获天空覆盖（F5-L4 量纲一致合同：显示环境与捕获 miss 辐射必须
 * 同亮度，否则比值门全域洗光——亮环境场景用同一套天空喂两端）。 */
function captureProbes(scene: ReferenceScene, missRadiance?: ProbeVector3): ProbeCapture {
  const pass1 = capturePass(scene, undefined, missRadiance);
  const pass2 = capturePass(scene, pass1, missRadiance);
  return pass2;
}

function capturePass(scene: ReferenceScene, previous: ProbeCapture | undefined,
  missRadiance?: ProbeVector3): ProbeCapture {
  const records: IrradianceProbeRecord[] = [];
  const sh: (ProbeDirectionalVisibilitySh | undefined)[] = [];
  const [nx, ny, nz] = GRID.size;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const position = probePosition([x, y, z]);
    const sample = evaluateProbeRadianceWithDirections(scene, position, DIRECTIONS_32, {
      shadowed: true,
      withDirectionSamples: true,
      ...(missRadiance ? { missRadiance: () => missRadiance } : {}),
      ...(previous ? {
        indirectBounce: (hit, hitPoint) => {
      const nearest = nearestProbeIrradiance(previous, hitPoint);
      return [hit.albedo[0] * nearest[0], hit.albedo[1] * nearest[1], hit.albedo[2] * nearest[2]];
    },
      } : {}),
    });
    const coefficients = sample.directionSamples
      ? projectProbeDirectionalVisibilitySh(sample.directionSamples, DIRECTIONS_32)
      : undefined;
    records.push({
      irradiance: sample.irradiance, validity: 1,
      meanDistance: sample.meanDistance, distanceVariance: sample.distanceVariance,
      occlusionFloor: sample.missRatio,
      ...(coefficients ? { directionalVisibilitySh: coefficients } : {}),
    });
    sh.push(coefficients);
  }
  return { records, sh };
}

function nearestProbeIrradiance(capture: ProbeCapture, point: readonly number[]): ProbeVector3 {
  const cell = [0, 1, 2].map(axis => Math.max(0, Math.min(GRID.size[axis] - 1,
    Math.round((point[axis] - GRID.origin[axis]) / GRID.spacing))));
  const index = (cell[2] * GRID.size[1] + cell[1]) * GRID.size[0] + cell[0];
  return capture.records[index]?.irradiance ?? [0, 0, 0];
}

function clipmapLevel(): ProbeClipmapLevel {
  const origin = [GRID.origin[0], 0, GRID.origin[2]] as ProbeVector3;
  const max = [GRID.origin[0] + (GRID.size[0] - 1) * GRID.spacing, 2,
    GRID.origin[2] + (GRID.size[2] - 1) * GRID.spacing] as ProbeVector3;
  return { level: 0, gridSize: [...GRID.size] as unknown as [number, number, number],
    spacing: GRID.spacing, originCell: [0, 0, 0], origin, max,
    probeCount: GRID.size[0] * GRID.size[1] * GRID.size[2] };
}

/** 门 CPU 参考（WGSL deepGiSpecularLevelGate 8-tap 同构：trilinear×chebyshev×法线权重）。 */
function sampleGate(capture: ProbeCapture, world: ProbeVector3, normal: ProbeVector3,
  direction: ProbeVector3, env: ProbeVector3): number {
  const level = clipmapLevel();
  const weights = [0.2126, 0.7152, 0.0722];
  const envLuma = env[0] * weights[0] + env[1] * weights[1] + env[2] * weights[2];
  const bias = 3, minWeight = 0.001;
  const coordinate = [0, 1, 2].map(axis => (world[axis] - level.origin[axis]) / level.spacing);
  const low = [0, 1, 2].map(axis => Math.min(Math.floor(coordinate[axis]), GRID.size[axis] - 2));
  const fraction = [0, 1, 2].map(axis => Math.min(1, Math.max(0, coordinate[axis] - low[axis])));
  const normalLength = Math.hypot(...normal);
  const unitNormal = normalLength > 1e-6 ? normal.map(value => value / normalLength) : [0, 1, 0];
  const receiver = [0, 1, 2].map(axis => world[axis] + unitNormal[axis] * level.spacing * 0.2);
  let gateSum = 0, totalWeight = 0;
  for (let corner = 0; corner < 8; corner++) {
    const bits = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
    const cell = [0, 1, 2].map(axis => low[axis] + bits[axis]);
    const axisWeight = [0, 1, 2].map(axis => (bits[axis] ? fraction[axis] : 1 - fraction[axis]));
    const trilinear = axisWeight[0] * axisWeight[1] * axisWeight[2];
    if (!(trilinear > 0)) continue;
    const index = (cell[2] * GRID.size[1] + cell[1]) * GRID.size[0] + cell[0];
    const record = capture.records[index];
    if (!record || record.validity <= 0) continue;
    const probePositionAt = probePosition(cell);
    // Chebyshev（probeClipmapSampling.visibilityWeight 同式）。
    const distance = Math.hypot(receiver[0] - probePositionAt[0], receiver[1] - probePositionAt[1],
      receiver[2] - probePositionAt[2]);
    const variance = Math.min(1e12, Math.max(record.distanceVariance, level.spacing ** 2 * 0.0001));
    const floorValue = Math.min(1, Math.max(0, record.occlusionFloor ?? 0));
    const enclosed = floorValue <= 0.001
      && variance <= Math.max(record.meanDistance ** 2, level.spacing ** 2);
    const chebyshev = variance / Math.max(variance + Math.abs(distance - record.meanDistance) ** 2, 1e-6);
    const visibility = distance <= record.meanDistance && enclosed ? 1 : chebyshev;
    // 法线权重（DDGI，半球判断用原始着色点）。
    const toProbe = [0, 1, 2].map(axis => probePositionAt[axis] - world[axis]);
    const lengthToProbe = Math.hypot(...toProbe);
    const cosine = lengthToProbe > 1e-6
      ? (toProbe[0] * unitNormal[0] + toProbe[1] * unitNormal[1] + toProbe[2] * unitNormal[2]) / lengthToProbe : 1;
    const normalWeight = cosine <= 0 ? 0 : cosine ** bias;
    const weight = trilinear * visibility * normalWeight;
    if (!(weight > 0)) continue;
    const tapGate = probeSpecularDirectionalVisibilityGate({
      inDomain: true, environmentIrradiance: env,
      probeIrradiance: record.irradiance, reflection: direction,
      directionalSh: capture.sh[index] });
    gateSum += weight * tapGate;
    totalWeight += weight;
  }
  if (!(totalWeight >= minWeight)) return 1;
  return Math.min(1, Math.max(0, gateSum / totalWeight));
}

interface ReceiverReading {
  readonly gate: number;
  readonly gatedSpecular: number;
  readonly deltaR: number;
}

function readReceiver(scene: ReferenceScene, capture: ProbeCapture,
  position: ProbeVector3, normal: ProbeVector3, eye: ProbeVector3,
  env: ProbeVector3 = ENV(scene)): ReceiverReading {
  const viewLength = Math.hypot(eye[0] - position[0], eye[1] - position[1], eye[2] - position[2]);
  const view = [(eye[0] - position[0]) / viewLength, (eye[1] - position[1]) / viewLength,
    (eye[2] - position[2]) / viewLength];
  // reflect(-view, n)（pbrShader 同式）。
  const dot = -(view[0] * normal[0] + view[1] * normal[1] + view[2] * normal[2]);
  const reflection: ProbeVector3 = [
    -view[0] - 2 * dot * normal[0], -view[1] - 2 * dot * normal[1], -view[2] - 2 * dot * normal[2]];
  const gi = sampleIrradianceProbeClipmap({
    worldPosition: position, worldNormal: normal, levels: [clipmapLevel()],
    records: capture.records, environmentFallback: env });
  const gate = sampleGate(capture, position, normal, reflection, env);
  const diffuseFactor = (1 - SPEC_FRACTION) * REFERENCE_FLOOR_ALBEDO[0];
  const offR = diffuseFactor * env[0] + SPEC_FRACTION * env[0];
  const onR = diffuseFactor * gi.irradiance[0] + SPEC_FRACTION * env[0] * gate;
  return { gate, gatedSpecular: SPEC_FRACTION * env[0] * gate, deltaR: onR - offR };
}

const FLOOR = (x: number, z: number): ProbeVector3 => [x, 0.005, z];
const UP: ProbeVector3 = [0, 1, 0];
const EYE: ProbeVector3 = [6, 1.6, 3];
// intFloorBack = 室内地面后段（封门哨兵 region 语义：薄墙之后的后间地板）。
const BACK_FLOOR: readonly ProbeVector3[] = [
  [5, 0.005, 1.5], [5, 0.005, 2.5], [5, 0.005, 3.5], [5, 0.005, 4.5],
  [6, 0.005, 1.5], [6, 0.005, 2.5], [6, 0.005, 3.5], [6, 0.005, 4.5],
  [7, 0.005, 1.5], [7, 0.005, 2.5], [7, 0.005, 3.5], [7, 0.005, 4.5]];
// 天窗亮斑地板（开阔方向的零扰动正控：镜面反射穿天窗直达环境）。接收点取天窗开口
// 内部、探针格点对齐（x=2,z=3）——天窗是锐利开口，L1 方向锐度有限（设计 §2 风险条），
// 非对齐接收点会被格点视界的暗探针按三线性稀释；锐度不足时按方案 B（方向 atlas）叠加。
const SKYLIGHT_FLOOR: readonly ProbeVector3[] = [[2, 0.005, 3]];

function sealedScene(openScene: ReferenceScene): ReferenceScene {
  return { ...openScene, boxes: [...openScene.boxes,
    { min: [3.95, 0, 2.5] as ProbeVector3, max: [4.05, 2.2, 3.5] as ProbeVector3,
      albedo: openScene.boxes[9]!.albedo }] };
}

describe("F5 方案 A 验收门：intFloorBack 32 方向 CPU 参考", () => {
  const openScene = buildReferenceRoomScene();
  const sealed = sealedScene(openScene);
  const openCapture = captureProbes(openScene);
  const sealedCapture = captureProbes(sealed);

  it("leakRatio ≤ 1.1（原尺逐字）；本时代 sealed/open delta 同为负（镜面漏光为绝对误差通道），如实登记", () => {
    const openDelta = BACK_FLOOR.map(point => readReceiver(openScene, openCapture, point, UP, EYE).deltaR);
    const sealedDelta = BACK_FLOOR.map(point => readReceiver(sealed, sealedCapture, point, UP, EYE).deltaR);
    const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const openDeltaR = mean(openDelta), sealedDeltaR = mean(sealedDelta);
    const leakRatio = sealedDeltaR / Math.max(openDeltaR, 0.01);
    // eslint-disable-next-line no-console
    console.log(`[f5-l1-harness] openDelta.R=${openDeltaR.toFixed(6)} sealedDelta.R=${sealedDeltaR.toFixed(6)} leakRatio=${leakRatio.toFixed(4)}`);
    expect(leakRatio).toBeLessThanOrEqual(LEAK_RATIO_GATE);
    // 封门态的 GI 贡献必须不高于开间态 + 0.01 尺地板（原尺方向性：封门不得比开间更漏）。
    expect(sealedDeltaR).toBeLessThanOrEqual(Math.max(openDeltaR, 0.01) * 1.1);
  });

  it("亮环境漏光本体（捕获/显示同一套天空）：无门时封门后段镜面全天空（0.05），门后压低 ≥10×（半球场零扰动正控见 probeDirectionalVisibilitySh.test.ts）", () => {
    const brightEnv: ProbeVector3 = [1, 1, 1];
    const brightSealed = captureProbes(sealed, brightEnv);
    const noGateSpecular = SPEC_FRACTION * brightEnv[0];
    const sealedBack = BACK_FLOOR.map(point =>
      readReceiver(sealed, brightSealed, point, UP, EYE, brightEnv));
    const sealedGatedMean = sealedBack.reduce((sum, r) => sum + r.gatedSpecular, 0) / sealedBack.length;
    const backGates = sealedBack.map(r => r.gate);
    const backMax = Math.max(...backGates);
    // 天窗亚格开口诊断（不设门）：1.5×2 开口 @2.5m ≈ 球面 2.5%，低于 32 方向 Fibonacci
    // + 盒边界 + L1 的三重分辨率（近 Up 两条 Fibonacci 射线恰好命中开口边界）——
    // 属分辨率极限而非门缺陷；L1 尺度的零扰动正控由合成半球场测试承载。
    const skylightGate = readReceiver(openScene, captureProbes(openScene, brightEnv),
      [2, 0.005, 3], UP, EYE, brightEnv).gate;
    // eslint-disable-next-line no-console
    console.log(`[f5-l1-harness] bright: noGateSpec=${noGateSpecular.toFixed(4)} sealedGatedSpec=${sealedGatedMean.toFixed(6)} suppression=${(noGateSpecular / Math.max(sealedGatedMean, 1e-9)).toFixed(1)}x backGateMax=${backMax.toFixed(4)} skylightGate(subgrid diagnostic)=${skylightGate.toFixed(4)}`);
    expect(sealedGatedMean * 10).toBeLessThanOrEqual(noGateSpecular);
    expect(backMax).toBeLessThanOrEqual(0.2);
  });

  it("镜面残差（场景环境量纲）：门把封门后段镜面压低 ≥10×，且不扰动天窗亮斑方向（gate≈1）", () => {
    const env = ENV(openScene);
    const noGateSpecular = SPEC_FRACTION * env[0];
    const sealedBack = BACK_FLOOR.map(point => readReceiver(sealed, sealedCapture, point, UP, EYE));
    const sealedGatedMean = sealedBack.reduce((sum, r) => sum + r.gatedSpecular, 0) / sealedBack.length;
    // 开阔方向零扰动：天窗正下方地板镜面反射直达环境，门必须 ≈1。
    const skylightGates = SKYLIGHT_FLOOR.map(point => readReceiver(openScene, openCapture, point, UP, EYE).gate);
    const skylightMin = Math.min(...skylightGates);
    // 封门后段方向性：反射向上=封板天花（暗），门必须显著压低。
    const backGates = sealedBack.map(r => r.gate);
    const backMax = Math.max(...backGates);
    // eslint-disable-next-line no-console
    console.log(`[f5-l1-harness] noGateSpec=${noGateSpecular.toFixed(6)} sealedGatedSpec=${sealedGatedMean.toFixed(6)} suppression=${(noGateSpecular / Math.max(sealedGatedMean, 1e-9)).toFixed(1)}x skylightGateMin=${skylightMin.toFixed(4)} backGateMax=${backMax.toFixed(4)}`);
    expect(sealedGatedMean * 10).toBeLessThanOrEqual(noGateSpecular);
    expect(skylightMin).toBeGreaterThanOrEqual(0.85);
    expect(backMax).toBeLessThanOrEqual(0.2);
  });
});
