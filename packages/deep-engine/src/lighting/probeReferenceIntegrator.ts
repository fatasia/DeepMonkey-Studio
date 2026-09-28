import { probeOcclusionDirection } from "../rayTracing/probeOcclusionRayExtension.js";
import type { ProbeVector3 } from "./probeClipmapPlan.js";
import { createReferenceRng, intersectReferenceScene, referenceSceneDiagonal,
  sampleReferenceDirect, uniformSphereDirection, type ReferenceScene } from "./probeReferenceScene.js";

/**
 * T02 高采样 CPU 参考积分器（纯 CPU，确定性）：小场景探针辐照的验收分母。
 *
 * == 两个估计器，同一功能量 ==
 * - `evaluateProbeRadianceEngineParity`：复用 `probeOcclusionDirection` Fibonacci 确定性
 *   方向集（与 GPU producer 的 CPU 权威方向集同源，不重建方向集），方向数低（默认 8），
 *   即"引擎口径"探针值。
 * - `integrateProbeReference`：seed 固定的分层蒙特卡洛（样本数高，默认 4096），并对半分
 *   （偶/奇样本）做自一致性检验——偏差超阈值的探针判为不稳定（遮挡不连续附近），
 *   RMSE 分母只在稳定探针上取（对应验收"稳定区域"）。
 * 归一化 RMSE：sqrt(mean‖est−ref‖₂²) / mean‖ref‖₂（线性辐照度、稳定探针集）。
 *
 * == 诚实边界 ==
 * 这是 CPU 参考积分，不是 GPU 实机对照；引擎输出与 GPU producer 的数值对拍留联测。
 * 两者共用同一功能量（见 probeReferenceScene 头注释），本 RMSE 只隔离方向采样误差。
 */

/** 参考积分默认样本数（分母质量档；测试另用 1024 对照收敛性）。 */
export const REFERENCE_DEFAULT_SAMPLE_COUNT = 4096;
/** 半分自一致性 z 检验默认阈值：|m1−m2| 超出合成标准误 3 倍判不稳定。 */
export const REFERENCE_DEFAULT_STABILITY_Z = 3;
/** 引擎口径默认方向数（与 producer 默认一致）。 */
export const ENGINE_PARITY_DEFAULT_DIRECTIONS = 8;

/** 功能量口径：默认引擎口径（无阴影射线）；shadowed=true 为物理真值对照口径。 */
export interface ProbeRadianceOptions {
  readonly shadowed?: boolean;
}

export interface ProbeRadianceSample {
  /** 方向均值辐照度（线性 RGB，探针存储口径）。 */
  readonly irradiance: ProbeVector3;
  /** miss 方向占比 ∈[0,1]（与 probeOcclusionEstimate.missRatio 同义）。 */
  readonly missRatio: number;
  /** 命中距离均值；全 miss = tMax（与扩展合同一致）。 */
  readonly meanDistance: number;
  /** 命中距离总体方差；命中数 ≤1 时 0（与扩展合同一致）。 */
  readonly distanceVariance: number;
  readonly directionCount: number;
}
export interface ProbeReferenceSample extends ProbeRadianceSample {
  /** 半分自一致（噪声感知 z 检验 ≤ 阈值）：true = 可进入稳定区域 RMSE。 */
  readonly stable: boolean;
  /** 半分差异 z 分数（|m1−m2| / 合成标准误）；信息性输出。 */
  readonly halfSplitZ: number;
}

/** 引擎口径 Fibonacci 方向集探针值（复用 probeOcclusionDirection，无 RNG 状态）。 */
export function evaluateProbeRadianceEngineParity(scene: ReferenceScene, position: ProbeVector3,
  directionCount = ENGINE_PARITY_DEFAULT_DIRECTIONS,
  options: ProbeRadianceOptions = {}): ProbeRadianceSample {
  const directions = Array.from({ length: directionCount }, (_, ordinal) =>
    probeOcclusionDirection(ordinal, directionCount));
  return evaluateProbeRadianceWithDirections(scene, position, directions, options);
}

/** 任意方向集的探针值（功能量唯一实现点；引擎口径与参考积分共用）。 */
export function evaluateProbeRadianceWithDirections(scene: ReferenceScene, position: ProbeVector3,
  directions: readonly ProbeVector3[], options: ProbeRadianceOptions = {}): ProbeRadianceSample {
  const shadowed = options.shadowed === true;
  const tMax = referenceSceneDiagonal(scene);
  const sum: [number, number, number] = [0, 0, 0];
  const distances: number[] = [];
  for (const direction of directions) {
    const hit = intersectReferenceScene(scene, position, direction, tMax);
    if (hit === undefined) {
      sum[0] += scene.ambient[0]; sum[1] += scene.ambient[1]; sum[2] += scene.ambient[2];
      continue;
    }
    const hitPoint: ProbeVector3 = [position[0]! + direction[0]! * hit.t,
      position[1]! + direction[1]! * hit.t, position[2]! + direction[2]! * hit.t];
    const radiance = sampleReferenceDirect(scene, hitPoint, hit.normal, hit.albedo, shadowed);
    sum[0] += radiance[0]; sum[1] += radiance[1]; sum[2] += radiance[2];
    distances.push(hit.t);
  }
  const count = directions.length;
  const meanDistance = distances.length > 0
    ? distances.reduce((sum, value) => sum + value, 0) / distances.length : tMax;
  const variance = distances.length > 1
    ? distances.reduce((sum, value) => sum + (value - meanDistance) ** 2, 0) / distances.length : 0;
  const irradiance: ProbeVector3 = [sum[0] / count, sum[1] / count, sum[2] / count];
  return Object.freeze({ irradiance: Object.freeze(irradiance),
    missRatio: 1 - distances.length / count,
    meanDistance, distanceVariance: variance,
    directionCount: count });
}

export interface ProbeReferenceOptions {
  /** 蒙特卡洛样本数（≥16 的完全平方数时分层最规则；默认 4096）。 */
  readonly sampleCount?: number;
  /** 固定 seed；同 seed 逐位同输出。 */
  readonly seed?: number;
  /** 半分 z 检验阈值（默认 3，参考 REFERENCE_DEFAULT_STABILITY_Z）。 */
  readonly stabilityZ?: number;
  /** 物理真值口径（命中点阴影射线）；默认 false = 引擎口径。 */
  readonly shadowed?: boolean;
}

/**
 * 高采样分层蒙特卡洛参考值 + 半分稳定性（噪声感知）：分层 = √N×√N 网格抖动，偶/奇样本
 * 交织成两个统计独立的半集。半集差异除以合成标准误得 z 分数——超过阈值（默认 3σ）说明
 * 该探针方向的辐射存在 MC 噪声解释不了的分歧（遮挡不连续附近），判不稳定并从验收
 * 稳定区域剔除。逐样本标量 X = 通道均值（RGB 平均）。
 */
export function integrateProbeReference(scene: ReferenceScene, position: ProbeVector3,
  options: ProbeReferenceOptions = {}): ProbeReferenceSample {
  const sampleCount = options.sampleCount ?? REFERENCE_DEFAULT_SAMPLE_COUNT;
  const stabilityZ = options.stabilityZ ?? REFERENCE_DEFAULT_STABILITY_Z;
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 4 || sampleCount % 2 !== 0) {
    throw new RangeError("Probe reference sampleCount must be an even safe integer ≥ 4.");
  }
  if (!Number.isFinite(stabilityZ) || stabilityZ <= 0) {
    throw new RangeError("Probe reference stabilityZ must be finite and positive.");
  }
  const rng = createReferenceRng(options.seed ?? 0);
  const side = Math.ceil(Math.sqrt(sampleCount));
  const tMax = referenceSceneDiagonal(scene);
  const shadowed = options.shadowed === true;
  const halfA: [number, number, number] = [0, 0, 0];
  const halfB: [number, number, number] = [0, 0, 0];
  let hitsA = 0, hitsB = 0, distA = 0, distB = 0, distA2 = 0, distB2 = 0;
  let scalarA = 0, scalarA2 = 0, scalarB = 0, scalarB2 = 0;
  for (let index = 0; index < sampleCount; index++) {
    const ix = index % side, iy = Math.floor(index / side);
    const u = (ix + rng()) / side, v = (iy + rng()) / side;
    const direction = uniformSphereDirection(u, v);
    const hit = intersectReferenceScene(scene, position, direction, tMax);
    const target = index % 2 === 0 ? halfA : halfB;
    let scalar: number;
    if (hit === undefined) {
      scalar = (scene.ambient[0] + scene.ambient[1] + scene.ambient[2]) / 3;
    } else {
      const hitPoint: ProbeVector3 = [position[0]! + direction[0]! * hit.t,
        position[1]! + direction[1]! * hit.t, position[2]! + direction[2]! * hit.t];
      const radiance = sampleReferenceDirect(scene, hitPoint, hit.normal, hit.albedo, shadowed);
      target[0] += radiance[0]; target[1] += radiance[1]; target[2] += radiance[2];
      scalar = (radiance[0] + radiance[1] + radiance[2]) / 3;
    }
    if (index % 2 === 0) {
      hitsA += 1; distA += hit?.t ?? 0; distA2 += hit ? hit.t * hit.t : 0;
      scalarA += scalar; scalarA2 += scalar * scalar;
    } else {
      hitsB += 1; distB += hit?.t ?? 0; distB2 += hit ? hit.t * hit.t : 0;
      scalarB += scalar; scalarB2 += scalar * scalar;
    }
  }
  const half = sampleCount / 2;
  const meanA = scalarA / half, meanB = scalarB / half;
  const pooledVariance = (scalarA2 - half * meanA * meanA + scalarB2 - half * meanB * meanB)
    / Math.max(sampleCount - 2, 1);
  const standardError = Math.sqrt(Math.max(0, pooledVariance) * (1 / half + 1 / half));
  const halfSplitZ = Math.abs(meanA - meanB) < 1e-12 || standardError < 1e-12
    ? 0 : Math.abs(meanA - meanB) / standardError;
  const hits = hitsA + hitsB;
  const meanDistance = hits > 0 ? (distA + distB) / hits : tMax;
  const variance = hits > 1 ? (distA2 + distB2 - hits * meanDistance * meanDistance) / hits : 0;
  const irradiance: ProbeVector3 = [(halfA[0] + halfB[0]) / sampleCount,
    (halfA[1] + halfB[1]) / sampleCount, (halfA[2] + halfB[2]) / sampleCount];
  return Object.freeze({ irradiance: Object.freeze(irradiance), missRatio: 1 - hits / sampleCount,
    meanDistance, distanceVariance: Math.max(0, variance),
    directionCount: sampleCount, stable: halfSplitZ <= stabilityZ, halfSplitZ });
}

export interface ProbeFieldRmseReport {
  /** 参与统计的探针数。 */
  readonly probeCount: number;
  /** 未归一化 RMSE（线性 RGB 欧氏）。 */
  readonly rmse: number;
  /** 归一化 RMSE = rmse / mean‖ref‖₂（分母 ≤ 0 时 = Infinity）。 */
  readonly normalizedRmse: number;
}

/**
 * 稳定区域归一化 RMSE。include(index) 选择进入统计的探针（稳定、非埋入等）；
 * 两数组必须等长、逐条有限。
 */
export function normalizedProbeFieldRmse(estimates: readonly ProbeVector3[],
  references: readonly ProbeVector3[], include: (index: number) => boolean): ProbeFieldRmseReport {
  if (estimates.length !== references.length) {
    throw new RangeError("Probe field RMSE requires equal-length estimate/reference arrays.");
  }
  let squareSum = 0, referenceSum = 0, count = 0;
  for (let index = 0; index < estimates.length; index++) {
    if (!include(index)) continue;
    const estimate = estimates[index]!, reference = references[index]!;
    [estimate, reference].forEach(vector => {
      if (vector.length !== 3 || vector.some(value => !Number.isFinite(value))) {
        throw new RangeError(`Probe field RMSE vector ${index} is invalid.`);
      }
    });
    squareSum += estimate.reduce((sum, value, axis) => sum + (value - reference[axis]!) ** 2, 0);
    referenceSum += Math.hypot(reference[0], reference[1], reference[2]);
    count += 1;
  }
  if (count === 0) return Object.freeze({ probeCount: 0, rmse: 0, normalizedRmse: Infinity });
  const meanSquare = squareSum / count;
  const denominator = referenceSum / count;
  return Object.freeze({ probeCount: count, rmse: Math.sqrt(meanSquare),
    normalizedRmse: denominator > 0 ? Math.sqrt(meanSquare) / denominator : Infinity });
}
