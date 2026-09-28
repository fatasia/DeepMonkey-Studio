import type { ProbeVector3 } from "./probeClipmapPlan.js";
import { computeNormalizedFieldRmse } from "./probeInvalidationConvergence.js";

/**
 * T02 GPU 联测共享分析件（纯 CPU、确定性）：
 * - `PRODUCER_SHADING_PI_SCALE`：生产内核命中项含 Lambert /π，参考场景以未归一化
 *   光向量计算、无 /π；联测 uniform 使用 intensity×π×|光向量|，环境项保持原值，
 *   GPU 读回直接为参考尺度（不能对 miss 环境项也乘 π 或对读回除 π）。
 * - `packProbeRadianceUniformWithCapacity`：生产 packProbeRadianceUniform 的容量参数化镜像，
 *   fib32 联测证据路径的布局对拍件（生产容量自 G3-S1 前的生产接线切片起已为 32；
 *   capacity=16 时与生产打包逐位一致、capacity=32 时 576B 逐字节相等，均测试钉死）。
 * - `analyzeProbeFieldDeviation`：逐探针偏差分布（系统性偏差源定位）。
 * - `budgetRecoverySchedule`：与 simulateBudgetedRecovery 同序（脏类距相机升序、同距下标序）
 *   的逐帧刷新排程，供 GPU 逐帧联测驱动。
 */

/** 生产内核 Lambert 项的 1/π 与参考功能量的尺度补偿（见模块头注释）。 */
export const PRODUCER_SHADING_PI_SCALE = Math.PI;

export interface ProbeRadianceUniformLike {
  readonly updateCount: number;
  readonly directionCount: number;
  readonly rayMask: number;
  readonly tMax: number;
  readonly surfaceToLight: readonly [number, number, number];
  readonly lightColor: readonly [number, number, number];
  readonly lightIntensity: number;
  readonly ambient: readonly [number, number, number];
  readonly directions: readonly (readonly [number, number, number])[];
}

/** 容量参数化的方向表 uniform（布局 = probeRadianceKernel RadianceParams，逐字段镜像）。 */
export function packProbeRadianceUniformWithCapacity(input: ProbeRadianceUniformLike,
  capacity: number): ArrayBuffer {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError("Uniform capacity must be a positive safe integer.");
  }
  if (input.directions.length < input.directionCount || input.directionCount > capacity) {
    throw new RangeError("Probe radiance uniform requires one direction per sample within capacity.");
  }
  const data = new ArrayBuffer(4 * 4 + 4 * 4 * 3 + capacity * 4 * 4);
  new Uint32Array(data, 0, 3).set([input.updateCount, input.directionCount, input.rayMask]);
  new Float32Array(data, 12, 1)[0] = input.tMax;
  const floats = new Float32Array(data);
  floats.set([...input.surfaceToLight, input.lightIntensity], 4);
  floats.set([...input.lightColor, 0], 8);
  floats.set([...input.ambient, 0], 12);
  input.directions.slice(0, capacity).forEach((direction, ordinal) => {
    floats.set([direction[0], direction[1], direction[2], 0], 16 + ordinal * 4);
  });
  return data;
}

export interface ProbeFieldDeviation {
  /** 归一化 RMSE（include 探针集，参考尺度）。 */
  readonly normalizedRmse: number;
  readonly probeCount: number;
  /** 逐通道符号偏差均值（系统性偏差源：持续同号 = 方向集/立体角权重偏差）。 */
  readonly meanSignedDelta: readonly [number, number, number];
  readonly meanAbsDelta: number;
  readonly medianRelative: number;
  readonly p95Relative: number;
  readonly maxRelative: number;
  /** 相对误差最大的探针（index + ‖Δ‖/‖ref‖），降序。 */
  readonly worst: readonly { readonly index: number; readonly relative: number }[];
}

/**
 * 逐探针偏差分布：include(index) 选择统计域（稳定、非埋入）；relative = ‖est−ref‖₂/‖ref‖₂。
 * estimates/references 必须等长且逐条三维有限。
 */
export function analyzeProbeFieldDeviation(estimates: readonly ProbeVector3[],
  references: readonly ProbeVector3[], include: (index: number) => boolean,
  worstCount = 8): ProbeFieldDeviation {
  if (estimates.length !== references.length) {
    throw new RangeError("Probe field deviation requires equal-length estimate/reference arrays.");
  }
  const rows: { index: number; signed: number[]; relative: number }[] = [];
  let meanSigned: number[] = [0, 0, 0], meanAbs = 0;
  for (let index = 0; index < estimates.length; index++) {
    if (!include(index)) continue;
    const estimate = estimates[index]!, reference = references[index]!;
    [estimate, reference].forEach(vector => {
      if (vector.length !== 3 || vector.some(value => !Number.isFinite(value))) {
        throw new RangeError(`Probe field deviation vector ${index} is invalid.`);
      }
    });
    const signed = estimate.map((value, axis) => value - reference[axis]!);
    const norm = Math.hypot(reference[0], reference[1], reference[2]);
    const absolute = Math.hypot(signed[0]!, signed[1]!, signed[2]!);
    rows.push({ index, signed: [...signed], relative: norm > 0 ? absolute / norm : 0 });
    meanSigned = meanSigned.map((sum, axis) => sum + signed[axis]!);
    meanAbs += absolute;
  }
  const count = rows.length;
  if (count > 0) {
    meanSigned = meanSigned.map(sum => sum / count);
    meanAbs /= count;
  }
  const sorted = rows.map(row => row.relative).sort((left, right) => left - right);
  const pick = (quantile: number): number => sorted.length === 0 ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor(quantile * (sorted.length - 1)))]!;
  const worst = [...rows].sort((left, right) => right.relative - left.relative).slice(0, worstCount)
    .map(row => ({ index: row.index, relative: row.relative }));
  return Object.freeze({
    normalizedRmse: computeNormalizedFieldRmse(estimates, references,
      estimates.map((_, index) => index).filter(include)),
    probeCount: rows.length,
    meanSignedDelta: Object.freeze(meanSigned) as readonly [number, number, number],
    meanAbsDelta: meanAbs,
    medianRelative: pick(0.5), p95Relative: pick(0.95), maxRelative: sorted.at(-1) ?? 0,
    worst: Object.freeze(worst),
  });
}

/**
 * 逐帧刷新排程（与 simulateBudgetedRecovery 同序：距相机平方距离升序、同距下标升序；
 * 每帧至多 budget 个）。输出帧 → 探针下标数组，供 GPU 联测逐帧驱动。
 */
export function budgetRecoverySchedule(positions: readonly ProbeVector3[],
  dirtyIndices: readonly number[], camera: ProbeVector3, budget: number): readonly (readonly number[])[] {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new RangeError("Recovery budget must be a positive integer.");
  if (camera.length !== 3 || camera.some(value => !Number.isFinite(value))) {
    throw new RangeError("Recovery camera must be finite XYZ.");
  }
  for (const [index, position] of positions.entries()) {
    if (position.length !== 3 || position.some(value => !Number.isFinite(value))) {
      throw new RangeError(`Recovery probe position ${index} must be finite XYZ.`);
    }
  }
  if (dirtyIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= positions.length)) {
    throw new RangeError("Recovery dirty indices must reference existing probes.");
  }
  const squared = (index: number): number => positions[index]!.reduce(
    (sum, value, axis) => sum + (value - camera[axis]!) ** 2, 0);
  const order = [...new Set(dirtyIndices)].sort((left, right) =>
    squared(left) - squared(right) || left - right);
  const frames: number[][] = [];
  for (let cursor = 0; cursor < order.length; cursor += budget) {
    frames.push(order.slice(cursor, cursor + budget));
  }
  return frames;
}
