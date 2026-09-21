/**
 * GI probe 遮挡射线精确化扩展（RayBackend 第三消费者切片）：把已真机验证的两级（TLAS→BLAS）
 * WGSL 执行器接入 GI probe clipmap 的待更新探针——对每个探针沿固定确定性方向集（Fibonacci
 * 球面 ≤16 方向，无 RNG 状态）构造遮挡射线（命中=该方向被遮挡、miss=该方向直达环境），
 * 统计 miss 比例与逐方向最近命中距离，输出该探针的 (visibilityFloor, meanDistance,
 * distanceVariance) 估计，直接喂给既有 record 合同字段（IrradianceProbeRecord 的
 * meanDistance/distanceVariance/occlusionFloor 通道，packIrradianceProbeRecord 已有编码位）。
 * 本合同层不修改 webgpu/probeClipmapRuntime.ts、lighting/probeClipmap*.ts 与 relocation
 * 求解器（三者只读，仅作数据对接）。
 *
 * == 集成方案决策（与 SSR/spotShadow 同模式：CPU/JS 异步补充 pass，而非纯 GPU 内核） ==
 * probe 更新在 webgpu/probeClipmapRuntime.ts 的捕获调度内闭环；把 BVH/TLAS storage 塞进
 * 捕获 bindgroup 需动参数块、WGSL 与三后端 parity 合同。执行器本身即"打包→dispatch→读回"
 * 异步 API，对待更新探针集做补充 pass 天然契合：帧内失败 fail-closed 整体回退（不产估计、
 * record 保持既有值），不打断帧。GPU 帧内自动接线（捕获调度侧消费估计）留待批次 F。
 *
 * == 估计口径（本节为对拍与消费方共同遵守的契约） ==
 * 每探针 directionCount 条单位方向射线，origin = 探针位置（探针是开放 cell 的体采样点而非
 * 表面着色点，无法线偏移），tMax = maxDistance。visibilityFloor = miss 比例 ∈[0,1]（至少
 * 这些方向不被遮挡收敛为零）；meanDistance = 命中射线距离的算术平均，全 miss 时 =
 * maxDistance（开放空间语义）；distanceVariance = 命中距离的总体方差，命中数 ≤1 时 = 0；
 * nearestHitDistance = 命中距离最小值（全 miss 无此字段）。三值均落在
 * packIrradianceProbeRecord 的编码域内（meanDistance ≤1e6、variance ≤1e12、floor ∈[0,1]），
 * f32 打包舍入只发生在 pack 侧。
 *
 * == 探针埋入判定（供 relocation 参考，不重复实现求解器） ==
 * miss=0 且 meanDistance ≤ buriedMeanDistance → buried=true：探针四周全被近距几何包裹
 * （埋入）。判定只作为 ProbeOcclusionEstimate.buried 数据输出；relocation 求解器
 * （lighting/probeRelocationResolver.ts）仍是唯一权威，本层不写偏移、不改调度。
 *
 * == 闸门顺序 == 主开关（默认关：off 时执行器不接触、估计全 undefined，零变化）→ 探针逐项
 * 有限性 fail-fast → 每帧射线硬预算（探针数×方向数，4096 上限；超额探针按输入序前缀截断
 * fail-closed，不静默放大预算）。执行器失败（含 WGSL 校验、预算越界抛错）整体回退。
 */

import type { ProbeUpdate } from "../lighting/probeClipmapPlan.js";
import type { RayBatchQuery } from "./rayBackendTypes.js";

/** 每帧遮挡射线硬预算（探针数×方向数）；调用方可经 maxRaysPerFrame 调小，不可超过。 */
export const PROBE_OCCLUSION_RAY_EXTENSION_MAX_RAYS_PER_FRAME = 4096;
export const PROBE_OCCLUSION_RAY_EXTENSION_MAX_DIRECTIONS = 16;
export const PROBE_OCCLUSION_RAY_EXTENSION_DEFAULT_DIRECTIONS = 8;
/** record 合同上限：meanDistance 编码域 [0, 1e6]（packIrradianceProbeRecord 同域）。 */
export const PROBE_OCCLUSION_RAY_EXTENSION_MAX_DISTANCE = 1_000_000;
const MASK_MAX = 0xffff_ffff;
/** Fibonacci 球面黄金角（确定性方向集，无 RNG 状态）。 */
const GOLDEN_SPHERE_ANGLE = Math.PI * (1 + Math.sqrt(5));

export interface ProbeOcclusionRayExtensionProbe {
  /** 输入探针下标（输出估计数组同下标对齐）。 */
  readonly index: number;
  readonly x: number; readonly y: number; readonly z: number;
}

export interface ProbeOcclusionRayExtensionOptions {
  /** 主开关，默认 false：估计全 undefined，执行器不接触。 */
  readonly enabled?: boolean;
  /** 每探针确定性方向数，1..16 整数。默认 8。 */
  readonly directionCount?: number;
  /** 遮挡查询最大行程（世界单位，(0, 1e6]；全 miss 时 meanDistance 语义）。默认 32。 */
  readonly maxDistance?: number;
  /** 遮挡体实例通道位（query.mask 原样透传；两级 TLAS 按位与过滤）。默认全 1。 */
  readonly occluderMask?: number;
  /** 埋入判据阈值：miss=0 且 meanDistance ≤ 该值 → buried（世界单位，≥0）。默认 0.01。 */
  readonly buriedMeanDistance?: number;
  /** 每帧射线预算上限（≤4096）；超额探针降级不估。默认 4096。 */
  readonly maxRaysPerFrame?: number;
}

export interface ProbeOcclusionRayExtensionHit { readonly t: number }
export interface ProbeOcclusionRayExtensionBatchResult {
  readonly hits: readonly (ProbeOcclusionRayExtensionHit | undefined)[];
}
/** 执行器最小结构合同：RayTraceGpuExecutor / RayTraceGpuTlasExecutor 与测试 stub 均满足。 */
export interface ProbeOcclusionRayExtensionExecutor {
  traceBatch(query: RayBatchQuery): Promise<ProbeOcclusionRayExtensionBatchResult>;
}

export interface ProbeOcclusionEstimate {
  readonly index: number;
  /** miss 射线占比 ∈[0,1]；同时即 visibilityFloor。 */
  readonly missRatio: number;
  readonly visibilityFloor: number;
  /** 命中距离均值；全 miss = maxDistance。 */
  readonly meanDistance: number;
  /** 命中距离总体方差；命中数 ≤1 时 0。 */
  readonly distanceVariance: number;
  /** 命中距离最小值；全 miss 无此字段。 */
  readonly nearestHitDistance?: number;
  /** 埋入判定（miss=0 且 meanDistance ≤ buriedMeanDistance）；数据仅供 relocation 参考。 */
  readonly buried: boolean;
  readonly directionCount: number;
}

/** 既有 record 合同的估计通道（直接展开进 IrradianceProbeRecord / packIrradianceProbeRecord）。 */
export interface ProbeOcclusionRecordPatch {
  readonly meanDistance: number;
  readonly distanceVariance: number;
  readonly occlusionFloor: number;
}

export interface ProbeOcclusionRayExtensionStats {
  readonly enabled: boolean;
  /** 输入探针数。 */
  readonly probes: number;
  readonly dispatchedProbes: number;
  /** 实际发射的遮挡射线数（=dispatchedProbes×directionCount，≤预算）。 */
  readonly dispatchedRays: number;
  readonly directionCount: number;
  readonly estimatedProbes: number;
  readonly buriedProbes: number;
  readonly budgetClamped: boolean;
  /** 执行器失败原因（已整体回退、不产估计）；正常为 undefined。 */
  readonly degradedReason?: string;
}

export interface ProbeOcclusionRayExtensionResult {
  /** 与输入探针同长同序；off/预算截断/降级的探针 = undefined（无数据写入）。 */
  readonly estimates: readonly (ProbeOcclusionEstimate | undefined)[];
  readonly extension: ProbeOcclusionRayExtensionStats;
}

export interface ResolvedProbeOcclusionRayExtensionOptions {
  readonly directionCount: number;
  readonly maxDistance: number;
  readonly occluderMask: number;
  readonly buriedMeanDistance: number;
  readonly maxRaysPerFrame: number;
}

/** 选项解析与校验（fail-fast：契约错误显式抛错，与"执行失败回退"区分）。 */
export function resolveProbeOcclusionRayExtensionOptions(
  extension: ProbeOcclusionRayExtensionOptions): ResolvedProbeOcclusionRayExtensionOptions {
  const directions = extension.directionCount ?? PROBE_OCCLUSION_RAY_EXTENSION_DEFAULT_DIRECTIONS;
  if (!Number.isSafeInteger(directions) || directions < 1
    || directions > PROBE_OCCLUSION_RAY_EXTENSION_MAX_DIRECTIONS) {
    throw new RangeError(`Probe occlusion ray extension directionCount must be an integer in [1, ${PROBE_OCCLUSION_RAY_EXTENSION_MAX_DIRECTIONS}].`);
  }
  const maxDistance = extension.maxDistance ?? 32;
  if (!Number.isFinite(maxDistance) || maxDistance <= 0
    || maxDistance > PROBE_OCCLUSION_RAY_EXTENSION_MAX_DISTANCE) {
    throw new RangeError("Probe occlusion ray extension maxDistance must be in (0, 1000000].");
  }
  const mask = extension.occluderMask ?? MASK_MAX;
  if (!Number.isSafeInteger(mask) || mask < 0 || mask > MASK_MAX) {
    throw new RangeError("Probe occlusion ray extension occluderMask must be an integer in [0, 0xffffffff].");
  }
  const buried = extension.buriedMeanDistance ?? 0.01;
  if (!Number.isFinite(buried) || buried < 0) {
    throw new RangeError("Probe occlusion ray extension buriedMeanDistance must be a nonnegative finite number.");
  }
  const maxRays = extension.maxRaysPerFrame ?? PROBE_OCCLUSION_RAY_EXTENSION_MAX_RAYS_PER_FRAME;
  if (!Number.isSafeInteger(maxRays) || maxRays < 0) {
    throw new RangeError("Probe occlusion ray extension maxRaysPerFrame must be a nonnegative safe integer.");
  }
  return { directionCount: directions, maxDistance, occluderMask: mask, buriedMeanDistance: buried,
    maxRaysPerFrame: Math.min(maxRays, PROBE_OCCLUSION_RAY_EXTENSION_MAX_RAYS_PER_FRAME) };
}

/** Fibonacci 球面方向：确定性均匀分布，k∈(0,1) 开区间避免极点重复；单位向量。 */
export function probeOcclusionDirection(ordinal: number, count: number): readonly [number, number, number] {
  const k = (ordinal + 0.5) / count;
  const phi = Math.acos(1 - 2 * k), theta = GOLDEN_SPHERE_ANGLE * (ordinal + 0.5);
  const sin = Math.sin(phi);
  return [sin * Math.cos(theta), Math.cos(phi), sin * Math.sin(theta)];
}

/** 校验探针并收集候选（本扩展无逐探针剔除闸门：全部合法探针进入候选序）。 */
export function collectProbeOcclusionRayExtensionCandidates(
  probes: readonly ProbeOcclusionRayExtensionProbe[]): ProbeOcclusionRayExtensionProbe[] {
  probes.forEach((probe, position) => {
    if (![probe.index, probe.x, probe.y, probe.z].every(Number.isFinite)) {
      throw new RangeError(`Probe occlusion ray extension probe ${position} has non-finite terms.`);
    }
    if (!Number.isSafeInteger(probe.index) || probe.index < 0 || probe.index >= probes.length) {
      // 下标越界会让估计数组变稀疏/错位，record 通道按同下标写入，必须 fail-fast。
      throw new RangeError(`Probe occlusion ray extension probe ${position} index must be an integer in [0, ${probes.length}).`);
    }
  });
  return [...probes];
}

/** 候选 → 执行器批次：探针主序 × 方向集展平；预算按探针前缀截断 fail-closed。 */
export function buildProbeOcclusionRayExtensionBatch(candidates: readonly ProbeOcclusionRayExtensionProbe[],
  resolved: ResolvedProbeOcclusionRayExtensionOptions): {
    query: RayBatchQuery;
    dispatched: readonly ProbeOcclusionRayExtensionProbe[];
    clamped: boolean;
  } {
  const directions = resolved.directionCount;
  const dispatched = candidates.slice(0, Math.floor(resolved.maxRaysPerFrame / directions));
  const origins = new Float32Array(dispatched.length * directions * 3);
  const rayDirections = new Float32Array(dispatched.length * directions * 3);
  const tMax = new Float32Array(dispatched.length * directions);
  dispatched.forEach((probe, probeIndex) => {
    for (let ordinal = 0; ordinal < directions; ordinal++) {
      const ray = probeIndex * directions + ordinal;
      origins.set([probe.x, probe.y, probe.z], ray * 3);
      rayDirections.set(probeOcclusionDirection(ordinal, directions), ray * 3);
      tMax[ray] = resolved.maxDistance;
    }
  });
  return { query: { origins, directions: rayDirections, tMax, mask: resolved.occluderMask }, dispatched,
    clamped: candidates.length > dispatched.length };
}

/**
 * 聚合：命中=遮挡、miss=可见（执行器合同）；口径见头注释"估计口径"节。未派发探针无估计
 * （undefined），由消费方保持既有 record 值。
 */
export function composeProbeOcclusionEstimates(candidates: readonly ProbeOcclusionRayExtensionProbe[],
  dispatched: readonly ProbeOcclusionRayExtensionProbe[], resolved: ResolvedProbeOcclusionRayExtensionOptions,
  hits: readonly (ProbeOcclusionRayExtensionHit | undefined)[]): {
    estimates: (ProbeOcclusionEstimate | undefined)[]; estimatedProbes: number; buriedProbes: number;
  } {
  const estimates: (ProbeOcclusionEstimate | undefined)[] = new Array(candidates.length).fill(undefined);
  let estimatedProbes = 0, buriedProbes = 0;
  dispatched.forEach((probe, probeIndex) => {
    const distances: number[] = [];
    for (let ordinal = 0; ordinal < resolved.directionCount; ordinal++) {
      const hit = hits[probeIndex * resolved.directionCount + ordinal];
      if (hit !== undefined && hit.t >= 0) distances.push(hit.t); // 负 t（畸形执行器输出）按 miss 处理，不进统计。
    }
    const missRatio = 1 - distances.length / resolved.directionCount;
    let meanDistance = resolved.maxDistance, variance = 0, nearest: number | undefined;
    if (distances.length > 0) {
      meanDistance = distances.reduce((sum, value) => sum + value, 0) / distances.length;
      nearest = Math.min(...distances);
      if (distances.length > 1) {
        variance = distances.reduce((sum, value) => sum + (value - meanDistance) ** 2, 0) / distances.length;
      }
    }
    const buried = missRatio === 0 && meanDistance <= resolved.buriedMeanDistance;
    estimates[probe.index] = { index: probe.index, missRatio, visibilityFloor: missRatio, meanDistance,
      distanceVariance: variance, ...(nearest === undefined ? {} : { nearestHitDistance: nearest }),
      buried, directionCount: resolved.directionCount };
    estimatedProbes++;
    if (buried) buriedProbes++;
  });
  return { estimates, estimatedProbes, buriedProbes };
}

/** 估计 → 既有 record 合同字段（直接展开进 IrradianceProbeRecord，packIrradianceProbeRecord 编码）。 */
export function toIrradianceProbeRecordPatch(estimate: ProbeOcclusionEstimate): ProbeOcclusionRecordPatch {
  return { meanDistance: estimate.meanDistance, distanceVariance: estimate.distanceVariance,
    occlusionFloor: estimate.visibilityFloor };
}

/** plan.updates（ProbeUpdate.position，世界空间）→ 探针输入；下标即 updates 序（0 基对齐）。 */
export function probeOcclusionProbesFromUpdates(
  updates: readonly ProbeUpdate[]): ProbeOcclusionRayExtensionProbe[] {
  return updates.map((update, index) => ({ index, x: update.position[0], y: update.position[1],
    z: update.position[2] }));
}

/**
 * 主入口：待更新探针的遮挡射线精确化。开关关闭（默认）时估计全 undefined、执行器不接触
 * （零变化）；执行器失败（含 WGSL 校验、预算越界抛错）整体回退（不产估计），不打断帧。
 */
export async function probeOcclusionEstimatesWithRayExtension(
  probes: readonly ProbeOcclusionRayExtensionProbe[], extension: ProbeOcclusionRayExtensionOptions,
  executor?: ProbeOcclusionRayExtensionExecutor): Promise<ProbeOcclusionRayExtensionResult> {
  const offStats = Object.freeze({ enabled: false, probes: probes.length, dispatchedProbes: 0,
    dispatchedRays: 0, directionCount: 0, estimatedProbes: 0, buriedProbes: 0, budgetClamped: false });
  if (!(extension.enabled ?? false)) {
    return { estimates: new Array(probes.length).fill(undefined), extension: offStats };
  }
  const resolved = resolveProbeOcclusionRayExtensionOptions(extension);
  const candidates = collectProbeOcclusionRayExtensionCandidates(probes);
  let dispatchedProbes = 0, dispatchedRays = 0, estimatedProbes = 0, buriedProbes = 0;
  let budgetClamped = false, degradedReason: string | undefined;
  const estimates: (ProbeOcclusionEstimate | undefined)[] = new Array(candidates.length).fill(undefined);
  try {
    if (executor === undefined) throw new Error("Probe occlusion ray extension requires an executor.");
    const batch = buildProbeOcclusionRayExtensionBatch(candidates, resolved);
    dispatchedProbes = batch.dispatched.length;
    dispatchedRays = batch.query.tMax.length;
    budgetClamped = batch.clamped;
    const result = await executor.traceBatch(batch.query);
    const composed = composeProbeOcclusionEstimates(candidates, batch.dispatched, resolved, result.hits);
    estimates.splice(0, estimates.length, ...composed.estimates);
    estimatedProbes = composed.estimatedProbes;
    buriedProbes = composed.buriedProbes;
  } catch (error) {
    degradedReason = error instanceof Error ? error.message : String(error);
  }
  return { estimates, extension: Object.freeze({ enabled: true, probes: candidates.length,
    dispatchedProbes, dispatchedRays, directionCount: resolved.directionCount, estimatedProbes,
    buriedProbes, budgetClamped,
    ...(degradedReason !== undefined ? { degradedReason } : {}) }) };
}
