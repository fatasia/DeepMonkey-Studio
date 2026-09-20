/**
 * SSR 屏外反射射线扩展（波次4 第一消费者切片）：把已真机验证的 RayBackend WGSL 执行器
 * （RayTraceGpuExecutor）接入 SSR 追踪未命中的像素——沿反射方向延长为二次射线，批量查询
 * 场景 BLAS 命中，命中则用命中点 irradiance 近似合成反射能量；未命中保持现有 fallback。
 *
 * == 集成方案决策（CPU/JS 侧异步补充 pass，而非纯 GPU 内核） ==
 * 纯 GPU 方案需把 BVH 四组 storage buffer 塞进 SSR trace bindgroup，连带改动参数块、
 * WGSL、CPU 镜像与三后端 parity 合同，侵入六层 radiance pyramid 管线；执行器本身即
 * "打包→dispatch→读回"异步 API，对降采样 miss 像素集做补充 pass 天然契合，帧内失败
 * fail-closed 回退 fallback 不打断帧。GPU 帧内自动化接线（TLAS 等）留待后续切片。
 *
 * == 能量口径（第一切片：命中点 albedo×环境项简化） ==
 * 命中点入射 radiance ≈ albedo × ambient（均匀 Lambert 环境近似：无遮挡、无镜面 lobe、
 * 忽略距离衰减）。它与 SSR 屏内路径的锥追踪预滤波 radiance 同为 radiance 量纲；合成时
 * 乘同一 Fresnel×edgeFade 掩码（cosθ 与 uv 口径逐公式同 trace 本体），经 composite 以
 * output = color×(1-mask) + trace 双线性并入。0 ≤ mask ≤ 1 且 albedo/ambient 非负有界，
 * 扩展只做替换不做增益，命中/未命中边界能量连续且有上界。
 *
 * == 候选判据 == SSR trace mask==0 且 centerDepth>0（有 origin 可延长）的半分辨率像素：
 * 覆盖背面失效（reflectedZ≥0）、march 出屏、步进耗尽未命中三类；centerDepth≤0 无 origin
 * 不可延长，保持 fallback。stride 采样 + 每帧预算硬上限（16384）双闸门，超额像素降级
 * 保持 fallback（fail-closed 截断，不静默放大预算）。
 */

import type { RayBatchQuery } from "./rayBackendTypes.js";
import type { GpuTraceHit, RayTraceBatchResult } from "./rayTraceExecutor.js";
import { compositeScreenSpaceReflectionCpu, projectToUv, reconstructPosition, reflectViewRay,
  sampleDepth, sampleNormal, screenSpaceReflectionEdgeFade, traceScreenSpaceReflectionCpu,
} from "../postprocess/screenSpaceReflectionCpu.js";
import type { ScreenSpaceReflectionCpuInput, ScreenSpaceReflectionCpuOptions,
} from "../postprocess/screenSpaceReflectionTypes.js";

/** 每帧二次射线硬预算；调用方可经 maxRaysPerFrame 调小，不可超过。 */
export const SSR_RAY_EXTENSION_MAX_RAYS_PER_FRAME = 16384;

export interface SsrRayExtensionOptions {
  /** 主开关，默认 false；与 SSR 本体开关 AND——本扩展只在 SSR 主流程内运行。 */
  readonly enabled?: boolean;
  /** 命中点 albedo（线性 rgb，[0,1]）；第一切片均匀近似（无 per-hit 材质读取）。 */
  readonly albedo: readonly [number, number, number];
  /** 环境 irradiance 项（线性 rgb，非负有限）。 */
  readonly ambient: readonly [number, number, number];
  /** 二次射线最大行程（view 空间单位，同 SSR maxDistance 语义），必须为正有限。 */
  readonly tMax: number;
  /** view→BLAS 行主序 3x4 仿射（BLAS 顶点与之同空间；第一切片单 BLAS，无 TLAS）。 */
  readonly viewToBlas: readonly [number, number, number, number,
    number, number, number, number, number, number, number, number];
  /** 每帧预算上限（≤16384）；超出部分降级保持 fallback。默认 16384。 */
  readonly maxRaysPerFrame?: number;
  /** 半分辨率候选采样步长（≥1 整数），预算第一道闸门。默认 1。 */
  readonly stride?: number;
}

/** 执行器最小结构合同：RayTraceGpuExecutor 与测试 stub 均满足。 */
export interface SsrRayExtensionExecutor {
  traceBatch(query: RayBatchQuery): Promise<RayTraceBatchResult>;
}

export interface SsrRayExtensionCandidate {
  readonly halfX: number;
  readonly halfY: number;
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  readonly reflectX: number;
  readonly reflectY: number;
  readonly reflectZ: number;
  /** normal·incident（trace 同源值；Fresnel cosθ = clamp(-该值, 0, 1)）。 */
  readonly cosTheta: number;
}

export interface SsrRayExtensionStats {
  readonly enabled: boolean;
  /** SSR mask==0 且有 origin 的半分辨率像素数。 */
  readonly missedPixels: number;
  /** stride 采样后进入候选集的数量。 */
  readonly candidates: number;
  /** 实际发射的二次射线数（≤ 预算）。 */
  readonly dispatchedRays: number;
  /** 二次射线命中并合成能量的数量。 */
  readonly hits: number;
  /** 预算截断降级是否触发。 */
  readonly budgetClamped: boolean;
  /** 执行器失败原因（已整体回退 fallback）；正常为 undefined。 */
  readonly degradedReason?: string;
}

export interface SsrRayExtensionCpuResult {
  readonly width: number;
  readonly height: number;
  readonly trace: Float32Array;
  readonly output: Float32Array;
  readonly extension: SsrRayExtensionStats;
}

export interface ResolvedSsrRayExtensionOptions {
  readonly albedo: readonly [number, number, number];
  readonly ambient: readonly [number, number, number];
  readonly tMax: number;
  readonly viewToBlas: readonly number[];
  readonly maxRaysPerFrame: number;
  readonly stride: number;
}

/** 选项解析与校验（fail-fast：契约错误显式抛错，与"执行失败回退 fallback"区分）。 */
export function resolveSsrRayExtensionOptions(extension: SsrRayExtensionOptions): ResolvedSsrRayExtensionOptions {
  const rgb = (value: readonly number[], name: string, max: number): readonly [number, number, number] => {
    if (value.length !== 3 || !value.every((component) => Number.isFinite(component) && component >= 0 && component <= max)) {
      throw new RangeError(`SSR ray extension ${name} must be three finite values in [0, ${max}].`);
    }
    return [value[0]!, value[1]!, value[2]!];
  };
  const albedo = rgb(extension.albedo, "albedo", 1);
  const ambient = rgb(extension.ambient, "ambient", Number.MAX_VALUE);
  if (!Number.isFinite(extension.tMax) || extension.tMax <= 0) {
    throw new RangeError("SSR ray extension tMax must be a positive finite number.");
  }
  if (extension.viewToBlas.length !== 12 || !extension.viewToBlas.every(Number.isFinite)) {
    throw new RangeError("SSR ray extension viewToBlas must be twelve finite numbers (row-major 3x4).");
  }
  const maxRays = extension.maxRaysPerFrame ?? SSR_RAY_EXTENSION_MAX_RAYS_PER_FRAME;
  if (!Number.isSafeInteger(maxRays) || maxRays < 0) {
    throw new RangeError("SSR ray extension maxRaysPerFrame must be a nonnegative safe integer.");
  }
  const stride = extension.stride ?? 1;
  if (!Number.isSafeInteger(stride) || stride < 1) {
    throw new RangeError("SSR ray extension stride must be an integer >= 1.");
  }
  return { albedo, ambient, tMax: extension.tMax, viewToBlas: [...extension.viewToBlas],
    maxRaysPerFrame: Math.min(maxRays, SSR_RAY_EXTENSION_MAX_RAYS_PER_FRAME), stride };
}

/** 展开半分辨率 trace 主循环（与 screenSpaceReflectionCpu 同一逐像素调用，单一数值来源）。 */
function traceFrame(input: ScreenSpaceReflectionCpuInput, options: ScreenSpaceReflectionCpuOptions): {
  trace: Float32Array; traceWidth: number; traceHeight: number;
} {
  const traceWidth = Math.ceil(input.width / 2), traceHeight = Math.ceil(input.height / 2);
  const trace = new Float32Array(traceWidth * traceHeight * 4);
  for (let halfY = 0; halfY < traceHeight; halfY++) {
    for (let halfX = 0; halfX < traceWidth; halfX++) {
      const [r, g, b, a] = traceScreenSpaceReflectionCpu(input, options, halfX, halfY);
      const base = (halfY * traceWidth + halfX) * 4;
      trace[base] = r; trace[base + 1] = g; trace[base + 2] = b; trace[base + 3] = a;
    }
  }
  return { trace, traceWidth, traceHeight };
}

/** 收集可延长的 SSR miss 像素（候选判据见头注释；origin/反射方向与 trace 本体同源函数）。 */
export function collectSsrRayExtensionCandidates(input: ScreenSpaceReflectionCpuInput,
  options: ScreenSpaceReflectionCpuOptions, resolved: ResolvedSsrRayExtensionOptions): {
    trace: Float32Array;
    traceWidth: number;
    traceHeight: number;
    candidates: SsrRayExtensionCandidate[];
    missedPixels: number;
  } {
  const { trace, traceWidth, traceHeight } = traceFrame(input, options);
  const tanHalfFov = Math.tan(options.verticalFovRadians * 0.5), aspect = input.width / input.height;
  const candidates: SsrRayExtensionCandidate[] = [];
  let missedPixels = 0;
  for (let halfY = 0; halfY < traceHeight; halfY++) {
    for (let halfX = 0; halfX < traceWidth; halfX++) {
      if (trace[(halfY * traceWidth + halfX) * 4 + 3]! > 0) continue;
      const x = Math.min(halfX * 2 + 1, input.width - 1), y = Math.min(halfY * 2 + 1, input.height - 1);
      const depth = sampleDepth(input, x, y);
      if (!(depth > 0)) continue; // 深度缺失：无 origin 可延长，保持 fallback。
      missedPixels++;
      if (halfX % resolved.stride !== 0 || halfY % resolved.stride !== 0) continue;
      const origin = reconstructPosition(input, x, y, depth, tanHalfFov, aspect);
      const [nx, ny, nz] = sampleNormal(input, x, y);
      const [, , , reflectX, reflectY, reflectZ, cosTheta] = reflectViewRay(origin, depth, nx, ny, nz);
      candidates.push({ halfX, halfY, originX: origin[0], originY: origin[1], originZ: origin[2],
        reflectX, reflectY, reflectZ, cosTheta });
    }
  }
  return { trace, traceWidth, traceHeight, candidates, missedPixels };
}

/** 候选 → 执行器批次：view→BLAS 仿射（p'=M·[p,1]，d'=M·[d,0]，方向不归一化，t 以方向长度计）；预算截断 fail-closed。 */
export function buildSsrRayExtensionBatch(candidates: readonly SsrRayExtensionCandidate[],
  resolved: ResolvedSsrRayExtensionOptions): {
    query: RayBatchQuery;
    dispatched: readonly SsrRayExtensionCandidate[];
    clamped: boolean;
  } {
  const dispatched = candidates.slice(0, resolved.maxRaysPerFrame);
  const origins = new Float32Array(dispatched.length * 3);
  const directions = new Float32Array(dispatched.length * 3);
  const tMax = new Float32Array(dispatched.length);
  const m = resolved.viewToBlas;
  dispatched.forEach((candidate, index) => {
    const [ox, oy, oz] = [candidate.originX, candidate.originY, candidate.originZ];
    origins.set([m[0]! * ox + m[1]! * oy + m[2]! * oz + m[3]!,
      m[4]! * ox + m[5]! * oy + m[6]! * oz + m[7]!, m[8]! * ox + m[9]! * oy + m[10]! * oz + m[11]!], index * 3);
    const [rx, ry, rz] = [candidate.reflectX, candidate.reflectY, candidate.reflectZ];
    directions.set([m[0]! * rx + m[1]! * ry + m[2]! * rz, m[4]! * rx + m[5]! * ry + m[6]! * rz,
      m[8]! * rx + m[9]! * ry + m[10]! * rz], index * 3);
    tMax[index] = resolved.tMax;
  });
  return { query: { origins, directions, tMax, mask: 0xff }, dispatched,
    clamped: candidates.length > dispatched.length };
}

/**
 * 命中能量合成：hit_view = origin_view + t·reflect_view（对任意仿射 viewToBlas 恒等价于
 * BLAS 命中点变换回 view，因为 hit_blas = M·(origin_view + t·reflect_view)），能量口径见
 * 头注释；写入 trace 与 SSR trace 同语义 rgba，由 composite 双线性并入。
 */
export function synthesizeSsrRayExtensionHits(trace: Float32Array, traceWidth: number,
  input: ScreenSpaceReflectionCpuInput, options: ScreenSpaceReflectionCpuOptions,
  resolved: ResolvedSsrRayExtensionOptions, dispatched: readonly SsrRayExtensionCandidate[],
  hits: readonly (GpuTraceHit | undefined)[]): number {
  const tanHalfFov = Math.tan(options.verticalFovRadians * 0.5), aspect = input.width / input.height;
  const f0 = options.fresnelF0;
  let hitCount = 0;
  dispatched.forEach((candidate, index) => {
    const t = hits[index]?.t;
    if (t === undefined || !(t >= 0)) return;
    const hit = [candidate.originX + candidate.reflectX * t,
      candidate.originY + candidate.reflectY * t, candidate.originZ + candidate.reflectZ * t];
    const [uvX, uvY] = projectToUv([hit[0]!, hit[1]!, hit[2]!], tanHalfFov, aspect);
    if (uvX < 0 || uvX > 1 || uvY < 0 || uvY > 1) return;
    const cosTheta = Math.min(1, Math.max(-candidate.cosTheta, 0));
    const fresnel = f0 + (1 - f0) * Math.pow(1 - cosTheta, 5);
    const fade = screenSpaceReflectionEdgeFade(uvX, uvY, Math.max(options.edgeFade, 1e-4));
    const mask = fresnel * fade;
    if (!(mask > 0)) return;
    const base = (candidate.halfY * traceWidth + candidate.halfX) * 4;
    trace[base] = resolved.albedo[0] * resolved.ambient[0] * mask;
    trace[base + 1] = resolved.albedo[1] * resolved.ambient[1] * mask;
    trace[base + 2] = resolved.albedo[2] * resolved.ambient[2] * mask;
    trace[base + 3] = mask;
    hitCount++;
  });
  return hitCount;
}

/**
 * 主入口：SSR CPU 镜像 + 屏外二次射线扩展。开关关闭（默认）时输出与
 * screenSpaceReflectionCpu 逐位一致；执行器失败（含 WGSL 校验、预算越界抛错）整体回退
 * fallback，不打断帧。
 */
export async function screenSpaceReflectionCpuWithRayExtension(input: ScreenSpaceReflectionCpuInput,
  options: ScreenSpaceReflectionCpuOptions, extension: SsrRayExtensionOptions,
  executor?: SsrRayExtensionExecutor): Promise<SsrRayExtensionCpuResult> {
  if (!(extension.enabled ?? false)) {
    const { trace, traceWidth, traceHeight } = traceFrame(input, options);
    return { width: input.width, height: input.height, trace,
      output: compositeFull(input, trace, traceWidth, traceHeight),
      extension: Object.freeze({ enabled: false, missedPixels: 0, candidates: 0,
        dispatchedRays: 0, hits: 0, budgetClamped: false }) };
  }
  const resolved = resolveSsrRayExtensionOptions(extension);
  const { trace, traceWidth, traceHeight, candidates, missedPixels } =
    collectSsrRayExtensionCandidates(input, options, resolved);
  let dispatchedRays = 0, hitCount = 0, budgetClamped = false, degradedReason: string | undefined;
  try {
    if (executor === undefined) throw new Error("SSR ray extension requires an executor.");
    const batch = buildSsrRayExtensionBatch(candidates, resolved);
    dispatchedRays = batch.query.tMax.length;
    budgetClamped = batch.clamped;
    const result = await executor.traceBatch(batch.query);
    hitCount = synthesizeSsrRayExtensionHits(trace, traceWidth, input, options, resolved,
      batch.dispatched, result.hits);
  } catch (error) {
    degradedReason = error instanceof Error ? error.message : String(error);
  }
  return { width: input.width, height: input.height, trace,
    output: compositeFull(input, trace, traceWidth, traceHeight),
    extension: Object.freeze({ enabled: true, missedPixels, candidates: candidates.length,
      dispatchedRays, hits: hitCount, budgetClamped,
      ...(degradedReason !== undefined ? { degradedReason } : {}) }) };
}

function compositeFull(input: ScreenSpaceReflectionCpuInput, trace: Float32Array,
  traceWidth: number, traceHeight: number): Float32Array {
  const output = new Float32Array(input.width * input.height * 3);
  for (let y = 0; y < input.height; y++) {
    for (let x = 0; x < input.width; x++) {
      const [r, g, b] = compositeScreenSpaceReflectionCpu(input, trace, traceWidth, traceHeight, x, y);
      const base = (y * input.width + x) * 3;
      output[base] = r; output[base + 1] = g; output[base + 2] = b;
    }
  }
  return output;
}
