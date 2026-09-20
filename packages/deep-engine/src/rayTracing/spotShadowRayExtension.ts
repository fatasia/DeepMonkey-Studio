/**
 * 局部聚光软阴影射线精确化扩展（RayBackend 第二消费者切片）：把已真机验证的两级（TLAS→BLAS）
 * WGSL 执行器（RayTraceGpuTlasExecutor；单级 RayTraceGpuExecutor 结构兼容）接入局部聚光
 * PCSS 软阴影的半影区像素——向着光面采样点构造遮挡射线（occlusion query 语义：命中=遮挡、
 * miss=可见），批量查询场景遮挡，输出精确可见性因子。本合同层不修改 webgpu/localSpotShadow*.ts
 * （atlas 12-tap PCSS 闭环零变化，只作只读上游输入）。
 *
 * == 集成方案决策（与 SSR 扩展同模式：CPU/JS 异步补充 pass，而非纯 GPU 内核） ==
 * PCSS 在 PBR 主通道 group(3) WGSL 内联执行；把 BVH/TLAS storage 塞进该 bindgroup 需动
 * 参数块、WGSL 与三后端 parity 合同。执行器本身即"打包→dispatch→读回"异步 API，对半影
 * 像素集做补充 pass 天然契合：帧内失败 fail-closed 整体回退纯 PCSS，不打断帧。GPU 帧内
 * 自动接线（世界空间着色点读回与调度）留待后续切片，本层先固化数据合同与合成口径。
 *
 * == 可见性与合成口径（两档开关） ==
 * PCSS 12-tap = shadow map 2D 投影近似（受 atlas 分辨率与深度精度限制）；射线可见性 =
 * 世界空间遮挡射线逐样本二值判定，每像素 samplesPerPixel 个光面采样取可见（miss）占比
 * ∈[0,1]，无 shadow map 泄露/自遮挡偏差。off（默认）：纯 PCSS 现状逐位不变（f32 原值
 * 透传，执行器不接触）。on：射线可用像素（候选发射并正常返回）的可见性用射线结果**替代**
 * PCSS——校正项角色由候选判据承担：替代精确落在 PCSS 估计偏差最大的半影带内，替代前后
 * 每像素能量均有界 [0,1]，全影(v=penumbraMin)/全亮(v=penumbraMax)像素不参与，不产生带外
 * 跳变。候选集外、降采样剔除、预算截断、执行器失败（含 WGSL 校验、预算越界抛错）一律
 * 保持 PCSS（fail-closed 回退，不静默放大预算）。
 *
 * == 候选判据与闸门顺序 == penumbraMin < pcssVisibility < penumbraMax（默认 0 < v < 1，
 * 即 PCSS 半影带；端点像素射线不会改变结果，不耗预算）。逐点顺序：退化剔除（着色点贴光
 * 面致零方向，无射线可发）→ stride 降采样 → 每帧射线硬上限（8192 = 像素数×samplesPerPixel）
 * 三道闸门，逐级 fail-closed 截断。
 *
 * == 射线构造 == origin = 着色点 + normal×normalOffset（脱自相交）；光面采样点 = 光心 +
 * radius×Fibonacci 球面点（确定性均匀分布，无 RNG 状态；radius=0 退化为点光单方向）；
 * 方向 = 单位化(采样点−origin)；tMax = |采样点−origin|×(1−1e-4)（恰在光面上的遮挡体不计
 * 入）。query.mask = occluderMask 原样透传（消费者自定义 caster 通道位；两级 TLAS 严格
 * 按位过滤实例，单级执行器打包层不透传 mask）。
 */

import type { RayBatchQuery } from "./rayBackendTypes.js";

/** 每帧遮挡射线硬预算；调用方可经 maxRaysPerFrame 调小，不可超过。 */
export const SPOT_SHADOW_RAY_EXTENSION_MAX_RAYS_PER_FRAME = 8192;
/** 每像素光面采样数默认值（= 每像素遮挡射线数）。 */
export const SPOT_SHADOW_RAY_EXTENSION_SAMPLES_PER_PIXEL = 4;
const MAX_SAMPLES_PER_PIXEL = 8, MASK_MAX = 0xffff_ffff, T_MAX_SURFACE_SHRINK = 1e-4;
/** Fibonacci 球面黄金角（确定性光面采样，无 RNG 状态）。 */
const GOLDEN_SPHERE_ANGLE = Math.PI * (1 + Math.sqrt(5));

export interface SpotShadowRayExtensionLight {
  readonly x: number; readonly y: number; readonly z: number;
  /** 光源面半径（世界单位，≥0；0=点光退化为单方向采样）。 */
  readonly radius: number;
}

export interface SpotShadowRayExtensionPoint {
  readonly worldX: number; readonly worldY: number; readonly worldZ: number;
  readonly normalX: number; readonly normalY: number; readonly normalZ: number;
  /** PCSS 12-tap 输出可见性（[0,1]；半影带判据输入）。 */
  readonly pcssVisibility: number;
}

export interface SpotShadowRayExtensionOptions {
  /** 主开关，默认 false：纯 PCSS 逐位不变，执行器不接触。 */
  readonly enabled?: boolean;
  readonly light: SpotShadowRayExtensionLight;
  /** 每像素光面采样数（=每像素遮挡射线数），1..8 整数。默认 4。 */
  readonly samplesPerPixel?: number;
  /** 着色点沿法线的脱自相交偏移（世界单位，≥0）。默认 1e-3。 */
  readonly normalOffset?: number;
  /** 遮挡体实例通道位（query.mask 原样透传；两级 TLAS 按位与过滤）。默认全 1。 */
  readonly occluderMask?: number;
  /** 半影带下界/上界（候选判据 penumbraMin < v < penumbraMax，均 ∈[0,1]）。默认 0/1。 */
  readonly penumbraMin?: number;
  readonly penumbraMax?: number;
  /** 每帧射线预算上限（≤8192）；超出部分降级保持 PCSS。默认 8192。 */
  readonly maxRaysPerFrame?: number;
  /** 半影像素降采样步长（候选序号取模，≥1 整数），预算第一道闸门。默认 1。 */
  readonly stride?: number;
}

export interface SpotShadowRayExtensionHit { readonly t: number }
export interface SpotShadowRayExtensionBatchResult {
  readonly hits: readonly (SpotShadowRayExtensionHit | undefined)[];
}
/** 执行器最小结构合同：RayTraceGpuExecutor / RayTraceGpuTlasExecutor 与测试 stub 均满足。 */
export interface SpotShadowRayExtensionExecutor {
  traceBatch(query: RayBatchQuery): Promise<SpotShadowRayExtensionBatchResult>;
}

export interface SpotShadowRayExtensionSample {
  readonly dirX: number; readonly dirY: number; readonly dirZ: number;
  /** |采样点−origin|（tMax = dist×(1−1e-4)）。 */
  readonly dist: number;
}

export interface SpotShadowRayExtensionCandidate {
  /** 输入点下标（输出可见性数组同下标合成）。 */
  readonly index: number;
  readonly originX: number; readonly originY: number; readonly originZ: number;
  readonly samples: readonly SpotShadowRayExtensionSample[];
}

export interface SpotShadowRayExtensionStats {
  readonly enabled: boolean;
  /** 半影带判据命中的像素数（退化剔除前）。 */
  readonly penumbraPixels: number;
  /** 退化剔除 + stride 采样后进入候选集的数量。 */
  readonly candidates: number;
  /** 实际发射的遮挡射线数（=候选数×samplesPerPixel，≤预算）。 */
  readonly dispatchedRays: number;
  readonly samplesPerPixel: number;
  /** 可见性被射线结果替代的像素数。 */
  readonly replacedPixels: number;
  readonly budgetClamped: boolean;
  /** 执行器失败原因（已整体回退纯 PCSS）；正常为 undefined。 */
  readonly degradedReason?: string;
}

export interface SpotShadowRayExtensionResult {
  /** 与 points 同长；off/降级 = PCSS 原值逐位，on = 射线可用像素为射线可见性。 */
  readonly visibility: Float32Array;
  readonly extension: SpotShadowRayExtensionStats;
}

export interface ResolvedSpotShadowRayExtensionOptions {
  readonly light: SpotShadowRayExtensionLight;
  readonly samplesPerPixel: number;
  readonly normalOffset: number;
  readonly occluderMask: number;
  readonly penumbraMin: number;
  readonly penumbraMax: number;
  readonly maxRaysPerFrame: number;
  readonly stride: number;
}

/** 选项解析与校验（fail-fast：契约错误显式抛错，与"执行失败回退 PCSS"区分）。 */
export function resolveSpotShadowRayExtensionOptions(
  extension: SpotShadowRayExtensionOptions): ResolvedSpotShadowRayExtensionOptions {
  const light = extension.light;
  if (light === undefined || ![light.x, light.y, light.z].every(Number.isFinite)) {
    throw new RangeError("Spot shadow ray extension light position must be finite.");
  }
  if (!Number.isFinite(light.radius) || light.radius < 0) {
    throw new RangeError("Spot shadow ray extension light radius must be a nonnegative finite number.");
  }
  const samples = extension.samplesPerPixel ?? SPOT_SHADOW_RAY_EXTENSION_SAMPLES_PER_PIXEL;
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > MAX_SAMPLES_PER_PIXEL) {
    throw new RangeError(`Spot shadow ray extension samplesPerPixel must be an integer in [1, ${MAX_SAMPLES_PER_PIXEL}].`);
  }
  const normalOffset = extension.normalOffset ?? 1e-3;
  if (!Number.isFinite(normalOffset) || normalOffset < 0) {
    throw new RangeError("Spot shadow ray extension normalOffset must be a nonnegative finite number.");
  }
  const mask = extension.occluderMask ?? MASK_MAX;
  if (!Number.isSafeInteger(mask) || mask < 0 || mask > MASK_MAX) {
    throw new RangeError("Spot shadow ray extension occluderMask must be an integer in [0, 0xffffffff].");
  }
  const min = extension.penumbraMin ?? 0, max = extension.penumbraMax ?? 1;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 1 || !(min < max)) {
    throw new RangeError("Spot shadow ray extension penumbra bounds must satisfy 0 <= min < max <= 1.");
  }
  const maxRays = extension.maxRaysPerFrame ?? SPOT_SHADOW_RAY_EXTENSION_MAX_RAYS_PER_FRAME;
  if (!Number.isSafeInteger(maxRays) || maxRays < 0) {
    throw new RangeError("Spot shadow ray extension maxRaysPerFrame must be a nonnegative safe integer.");
  }
  const stride = extension.stride ?? 1;
  if (!Number.isSafeInteger(stride) || stride < 1) {
    throw new RangeError("Spot shadow ray extension stride must be an integer >= 1.");
  }
  return { light: { ...light }, samplesPerPixel: samples, normalOffset, occluderMask: mask,
    penumbraMin: min, penumbraMax: max,
    maxRaysPerFrame: Math.min(maxRays, SPOT_SHADOW_RAY_EXTENSION_MAX_RAYS_PER_FRAME), stride };
}

/** Fibonacci 球面采样偏移：确定性均匀分布，k∈(0,1) 开区间避免极点重复。 */
function lightSampleOffset(ordinal: number, count: number, radius: number): readonly [number, number, number] {
  const k = (ordinal + 0.5) / count;
  const phi = Math.acos(1 - 2 * k), theta = GOLDEN_SPHERE_ANGLE * (ordinal + 0.5);
  const sin = Math.sin(phi);
  return [radius * sin * Math.cos(theta), radius * Math.cos(phi), radius * sin * Math.sin(theta)];
}

/** 收集半影带候选（判据与闸门顺序见头注释；origin 已含法线偏移，方向已单位化）。 */
export function collectSpotShadowRayExtensionCandidates(points: readonly SpotShadowRayExtensionPoint[],
  resolved: ResolvedSpotShadowRayExtensionOptions): { candidates: SpotShadowRayExtensionCandidate[]; penumbraPixels: number } {
  const { light, samplesPerPixel, normalOffset, penumbraMin, penumbraMax, stride } = resolved;
  const candidates: SpotShadowRayExtensionCandidate[] = [];
  let penumbraPixels = 0, penumbraOrdinal = 0;
  points.forEach((point, index) => {
    const terms = [point.worldX, point.worldY, point.worldZ, point.normalX, point.normalY,
      point.normalZ, point.pcssVisibility];
    if (!terms.every(Number.isFinite)) {
      throw new RangeError(`Spot shadow ray extension point ${index} has non-finite terms.`);
    }
    if (!(point.pcssVisibility > penumbraMin && point.pcssVisibility < penumbraMax)) return;
    penumbraPixels++;
    const originX = point.worldX + point.normalX * normalOffset;
    const originY = point.worldY + point.normalY * normalOffset;
    const originZ = point.worldZ + point.normalZ * normalOffset;
    const samples: SpotShadowRayExtensionSample[] = [];
    let degenerate = false;
    for (let ordinal = 0; ordinal < samplesPerPixel; ordinal++) {
      const [ox, oy, oz] = lightSampleOffset(ordinal, samplesPerPixel, light.radius);
      const dx = light.x + ox - originX, dy = light.y + oy - originY, dz = light.z + oz - originZ;
      const dist = Math.hypot(dx, dy, dz);
      if (!(dist > 0)) { degenerate = true; break; } // 着色点贴光面：零方向无射线可发。
      samples.push({ dirX: dx / dist, dirY: dy / dist, dirZ: dz / dist, dist });
    }
    if (degenerate) return;
    if (penumbraOrdinal % stride !== 0) { penumbraOrdinal++; return; }
    penumbraOrdinal++;
    candidates.push({ index, originX, originY, originZ, samples });
  });
  return { candidates, penumbraPixels };
}

/** 候选 → 执行器批次（世界空间直发 TLAS；样本按候选展平；预算截断 fail-closed）。 */
export function buildSpotShadowRayExtensionBatch(candidates: readonly SpotShadowRayExtensionCandidate[],
  resolved: ResolvedSpotShadowRayExtensionOptions): {
    query: RayBatchQuery; dispatched: readonly SpotShadowRayExtensionCandidate[]; clamped: boolean;
  } {
  const samples = resolved.samplesPerPixel;
  const dispatched = candidates.slice(0, Math.floor(resolved.maxRaysPerFrame / samples));
  const rayCount = dispatched.length * samples;
  const origins = new Float32Array(rayCount * 3);
  const directions = new Float32Array(rayCount * 3);
  const tMax = new Float32Array(rayCount);
  dispatched.forEach((candidate, candidateIndex) => {
    candidate.samples.forEach((sample, sampleIndex) => {
      const ray = candidateIndex * samples + sampleIndex;
      origins.set([candidate.originX, candidate.originY, candidate.originZ], ray * 3);
      directions.set([sample.dirX, sample.dirY, sample.dirZ], ray * 3);
      tMax[ray] = sample.dist * (1 - T_MAX_SURFACE_SHRINK);
    });
  });
  return { query: { origins, directions, tMax, mask: resolved.occluderMask }, dispatched,
    clamped: candidates.length > dispatched.length };
}

/** 纯 PCSS 基线（f32 原值透传；off/降级路径共用，保证逐位一致）。 */
export function baselineSpotShadowVisibility(points: readonly SpotShadowRayExtensionPoint[]): Float32Array {
  const visibility = new Float32Array(points.length);
  points.forEach((point, index) => { visibility[index] = point.pcssVisibility; });
  return visibility;
}

/**
 * 合成：命中=遮挡、miss=可见（执行器合同）；每像素可见性 = 可见样本数/样本数，覆盖写入
 * 基线（口径见头注释）；未派发像素保持 PCSS。
 */
export function composeSpotShadowRayVisibility(points: readonly SpotShadowRayExtensionPoint[],
  dispatched: readonly SpotShadowRayExtensionCandidate[], samplesPerPixel: number,
  hits: readonly (SpotShadowRayExtensionHit | undefined)[]): { visibility: Float32Array; replacedPixels: number } {
  const visibility = baselineSpotShadowVisibility(points);
  let replacedPixels = 0;
  dispatched.forEach((candidate, candidateIndex) => {
    let occluded = 0;
    for (let sampleIndex = 0; sampleIndex < samplesPerPixel; sampleIndex++) {
      if (hits[candidateIndex * samplesPerPixel + sampleIndex] !== undefined) occluded++;
    }
    visibility[candidate.index] = 1 - occluded / samplesPerPixel;
    replacedPixels++;
  });
  return { visibility, replacedPixels };
}

/**
 * 主入口：PCSS 半影带像素的遮挡射线精确化。开关关闭（默认）时输出与纯 PCSS 基线逐位一致
 * （执行器不接触）；执行器失败（含 WGSL 校验、预算越界抛错）整体回退纯 PCSS，不打断帧。
 */
export async function spotShadowVisibilityWithRayExtension(points: readonly SpotShadowRayExtensionPoint[],
  extension: SpotShadowRayExtensionOptions, executor?: SpotShadowRayExtensionExecutor):
  Promise<SpotShadowRayExtensionResult> {
  if (!(extension.enabled ?? false)) {
    return { visibility: baselineSpotShadowVisibility(points),
      extension: Object.freeze({ enabled: false, penumbraPixels: 0, candidates: 0, dispatchedRays: 0,
        samplesPerPixel: 0, replacedPixels: 0, budgetClamped: false }) };
  }
  const resolved = resolveSpotShadowRayExtensionOptions(extension);
  const { candidates, penumbraPixels } = collectSpotShadowRayExtensionCandidates(points, resolved);
  let dispatchedRays = 0, replacedPixels = 0, budgetClamped = false, degradedReason: string | undefined;
  let visibility = baselineSpotShadowVisibility(points);
  try {
    if (executor === undefined) throw new Error("Spot shadow ray extension requires an executor.");
    const batch = buildSpotShadowRayExtensionBatch(candidates, resolved);
    dispatchedRays = batch.query.tMax.length;
    budgetClamped = batch.clamped;
    const result = await executor.traceBatch(batch.query);
    const composed = composeSpotShadowRayVisibility(points, batch.dispatched, resolved.samplesPerPixel,
      result.hits);
    visibility = composed.visibility;
    replacedPixels = composed.replacedPixels;
  } catch (error) {
    degradedReason = error instanceof Error ? error.message : String(error);
  }
  return { visibility, extension: Object.freeze({ enabled: true, penumbraPixels,
    candidates: candidates.length, dispatchedRays, samplesPerPixel: resolved.samplesPerPixel,
    replacedPixels, budgetClamped,
    ...(degradedReason !== undefined ? { degradedReason } : {}) }) };
}
