/// <reference types="@webgpu/types" />
/**
 * Probe 遮挡射线扩展真机探针（RayBackend 第四消费者的 GPU 腿；由 scripts/probeOcclusionGpuTest.mjs
 * 驱动，headless Chrome + WebGPU）。模式沿用 rayTraceGpuProbe / softRasterizeGpuProbe：Node 侧与
 * 浏览器共用同一 esbuild bundle——固定场景、探针/方向批次构造、TLAS 构建、两级执行器、CPU 参考
 * 与聚合只此一份（防口径分叉）。浏览器腿走完整 API 路径：probeOcclusionEstimatesWithRayExtension
 * （enabled 全链：闸门序 → 批次构造 → 执行器 dispatch → 读回 → 聚合）+ 独立原始 traceBatch
 * （供逐射线仲裁）。数值仲裁（Node 侧）三层：
 *  1. 逐射线：GPU hits vs CPU traceTlasClosest（compareTlasGpuAgainstCpu：命中/缺席一致 +
 *     instanceIndex/primitiveIndex 精确 + t 相对 1e-5），再对解析闭式 t 同容差；
 *  2. 聚合统计：GPU 估计 vs CPU 估计 vs 解析预期——missRatio/visibilityFloor/buried 精确相等、
 *     meanDistance/nearestHitDistance 相对 1e-5、distanceVariance 相对 1e-4（f32 量化级；t 的
 *     f32/f64 差 ~1e-7，经均值/方差传播仍低于容差约两个量级，实测最大偏差随证据记录）；
 *  3. 解析预期：轴对齐盒几何的闭式遮挡率——封闭盒壳内探针全命中（遮挡率 1）、头顶大平板下方
 *     探针上=Fibonacci 半球 4/8 命中（遮挡率 0.5）、开阔探针（距所有遮挡体最近点 > maxDistance）
 *     全 miss（遮挡率 0，meanDistance = maxDistance 语义）、掩码案例中 tiny 壳被 occluderMask
 *     滤除后 buried 探针退化为半遮挡（0.5，mean ≤ 阈值的埋入判定翻转）。
 * 场景：盒壳 [-14,-10]×[-2,2]×[-2,2]（enclosed 探针）、平板 y∈[3,8] × [-40,40]²（overhead 探针，
 * 上行射线解析命中 t ∈ [3.43, 24] 与 tMax=32 分离 ≥25%——解析命中距离严禁压 tMax 边界，f32 归一化
 * 会在边界上翻转命中判定（真机实测 4/0.125=32 翻车）；开阔探针 (0,-40,0)（最近遮挡点 ≥ 41.7）、
 * tiny 壳 12±2^-9（buried 探针，解析 mean ≈ 0.0032 ≤ 默认 0.01 阈值）。数值纪律：全部顶点 f32
 * 精确——±2^-9 在 12 处恰为 2048 个 ULP（ULP=2^-20），±整数与 3/8/40 同样精确；f32 不精确的
 * 微幅偏移（如 0.002）会让顶点打包误差被短行程放大（实测 t 相对偏差 7.25e-5 > 1e-5 容差，真机
 * 实测翻车后改 dyadic）。两级 TLAS 盒 fround 量化与打包合同一致；三角形相交为双面语义（|det|
 * 拒绝仅限退化），外侧命中底面成立，解析不依赖绕向。
 */

import { buildProbeOcclusionRayExtensionBatch, collectProbeOcclusionRayExtensionCandidates,
  probeOcclusionDirection, probeOcclusionEstimatesWithRayExtension,
  resolveProbeOcclusionRayExtensionOptions,
  type ProbeOcclusionEstimate, type ProbeOcclusionRayExtensionExecutor,
  type ProbeOcclusionRayExtensionOptions, type ProbeOcclusionRayExtensionProbe,
  type ResolvedProbeOcclusionRayExtensionOptions } from "../src/rayTracing/probeOcclusionRayExtension.js";
import { RayTraceGpuTlasExecutor, compareTlasGpuAgainstCpu } from "../src/rayTracing/rayTraceTlasExecutor.js";
import { emitTwoLevelRayTraceKernelWgsl } from "../src/rayTracing/rayTraceTlasKernel.js";
import type { RayBlasDescriptor, RayBatchQuery } from "../src/rayTracing/rayBackendTypes.js";
import { buildTlas, traceTlasClosest, type TlasBuildResult, type TlasInstanceDescriptor } from "../src/rayTracing/tlas.js";
import { packTlasScene } from "../src/rayTracing/tlasLayout.js";
import type { TraceQuery } from "../src/rayTracing/rayTrace.js";
import { encodeGpuTlasHits } from "./rayTraceTlasCases.js";

export { buildTlas, traceTlasClosest } from "../src/rayTracing/tlas.js";
export { packTlasScene } from "../src/rayTracing/tlasLayout.js";
export { RayTraceGpuTlasExecutor, compareTlasGpuAgainstCpu } from "../src/rayTracing/rayTraceTlasExecutor.js";
export { emitTwoLevelRayTraceKernelWgsl } from "../src/rayTracing/rayTraceTlasKernel.js";
export { buildProbeOcclusionRayExtensionBatch, collectProbeOcclusionRayExtensionCandidates,
  composeProbeOcclusionEstimates, probeOcclusionDirection, probeOcclusionEstimatesWithRayExtension,
  resolveProbeOcclusionRayExtensionOptions } from "../src/rayTracing/probeOcclusionRayExtension.js";
export { encodeGpuTlasHits, decodeGpuTlasHits } from "./rayTraceTlasCases.js";

/** 解析预期（逐射线 + 聚合）；analyticHits 长度 = directionCount，undefined = 解析 miss。 */
export interface ProbeOcclusionAnalyticExpectation {
  readonly label: string;
  readonly analyticHits: readonly (number | undefined)[];
  readonly expectedMissRatio: number;
  readonly expectedMeanDistance: number;
  readonly expectedDistanceVariance: number;
  readonly expectedNearestHitDistance?: number;
  readonly expectedBuried: boolean;
}

export interface ProbeOcclusionCaseSpec {
  readonly name: string;
  readonly note: string;
  readonly probes: readonly ProbeOcclusionRayExtensionProbe[];
  readonly options: ProbeOcclusionRayExtensionOptions;
  readonly instances: readonly TlasInstanceDescriptor[];
  /** 仅覆盖预期产出估计的探针前缀；其余探针（预算钳制截断）双侧估计必须 undefined。 */
  readonly analytic: readonly ProbeOcclusionAnalyticExpectation[];
}

/** 盒网格：8 角 12 三角（角序 z·y·x，与 probeOcclusionRayExtension.test closed-cube 同表）。 */
const BOX_INDICES = Uint32Array.from([0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1,
  2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3]);

function boxBlas(id: string, cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number): RayBlasDescriptor {
  const vertices = new Float32Array(24);
  let corner = 0;
  for (const z of [cz - hz, cz + hz]) for (const y of [cy - hy, cy + hy])
    for (const x of [cx - hx, cx + hx]) vertices.set([x, y, z], corner++ * 3);
  return { id, vertices, indices: Uint32Array.from(BOX_INDICES) };
}

/** 中心轴对齐盒内出发的解析出口距离：t = 半幅 / max|d|（主导分量面交点）。 */
function analyticBoxExit(direction: readonly [number, number, number], halfExtent: number): number {
  return halfExtent / Math.max(Math.abs(direction[0]), Math.abs(direction[1]), Math.abs(direction[2]));
}

/** 解析预期构造：analyticT 返回每方向闭式命中距离或 undefined（miss）；超 maxDistance 按 miss。 */
function buildAnalyticExpectation(label: string, directionCount: number, maxDistance: number,
  buriedMeanDistance: number,
  analyticT: (direction: readonly [number, number, number]) => number | undefined):
  ProbeOcclusionAnalyticExpectation {
  const analyticHits = Array.from({ length: directionCount }, (_, ordinal) => {
    const t = analyticT(probeOcclusionDirection(ordinal, directionCount));
    return t !== undefined && t <= maxDistance ? t : undefined;
  });
  const distances = analyticHits.filter((t): t is number => t !== undefined);
  const missRatio = 1 - distances.length / directionCount;
  let meanDistance = maxDistance, variance = 0;
  if (distances.length > 0) {
    meanDistance = distances.reduce((sum, value) => sum + value, 0) / distances.length;
    if (distances.length > 1) {
      variance = distances.reduce((sum, value) => sum + (value - meanDistance) ** 2, 0) / distances.length;
    }
  }
  return { label, analyticHits, expectedMissRatio: missRatio, expectedMeanDistance: meanDistance,
    expectedDistanceVariance: variance,
    ...(distances.length > 0 ? { expectedNearestHitDistance: Math.min(...distances) } : {}),
    expectedBuried: distances.length === directionCount && meanDistance <= buriedMeanDistance };
}

/** 封闭盒壳内探针：全方向命中壳内表面。 */
function enclosedExpectation(halfExtent: number, directionCount: number, maxDistance: number,
  buriedMeanDistance: number): ProbeOcclusionAnalyticExpectation {
  return buildAnalyticExpectation("enclosed-in-shell", directionCount, maxDistance, buriedMeanDistance,
    (direction) => analyticBoxExit(direction, halfExtent));
}

/** 头顶平板（底面高度 height、footprint 半幅 spanX/spanZ）下方探针：dy>0 且落点在 footprint 内命中。 */
function slabExpectation(label: string, height: number, spanX: number, spanZ: number,
  directionCount: number, maxDistance: number, buriedMeanDistance: number):
  ProbeOcclusionAnalyticExpectation {
  return buildAnalyticExpectation(label, directionCount, maxDistance, buriedMeanDistance,
    ([dx, dy, dz]) => {
      if (dy <= 0) return undefined;
      const t = height / dy;
      return Math.abs(t * dx) <= spanX && Math.abs(t * dz) <= spanZ ? t : undefined;
    });
}

/** 开阔探针：最近遮挡点距离 > maxDistance → 全 miss（meanDistance = maxDistance 开放语义）。 */
function openExpectation(directionCount: number, maxDistance: number): ProbeOcclusionAnalyticExpectation {
  return buildAnalyticExpectation("open-space", directionCount, maxDistance, 0, () => undefined);
}

/**
 * 确定性固定场景三案例：全链默认选项（scene-known-occluders）、每帧预算钳制
 * （scene-budget-clamp：6 探针 × 4 方向、预算 16 → 前缀 4 探针派发，尾部双侧无估计）、
 * occluderMask 端到端过滤（scene-occluder-mask：tiny 壳实例位 0b10 vs 查询位 0b01）。
 */
export function buildProbeOcclusionCases(): readonly ProbeOcclusionCaseSpec[] {
  const shell = boxBlas("shell", -12, 0, 0, 2, 2, 2);
  const overhead = boxBlas("overhead", 0, 5.5, 0, 40, 2.5, 40); // 底面 y=3：最大解析命中 t=24，远离 tMax=32。
  const tinyHalfExtent = 2 ** -9; // 12±2^-9 = 2048 ULP（ULP=2^-20）：顶点 f32 精确，解析与实际逐位同源。
  const tiny = boxBlas("tiny", 12, 0, 0, tinyHalfExtent, tinyHalfExtent, tinyHalfExtent);
  const identity: TlasInstanceDescriptor["worldToLocal"] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  const probeAt = (index: number, x: number, y: number, z: number): ProbeOcclusionRayExtensionProbe =>
    ({ index, x, y, z });
  const probes4 = [probeAt(0, -12, 0, 0), probeAt(1, 0, 0, 0), probeAt(2, 0, -40, 0), probeAt(3, 12, 0, 0)];
  const instanceRow = (tinyMask: number): readonly TlasInstanceDescriptor[] => [
    { id: "shell", blas: shell, worldToLocal: identity, mask: 0b01 },
    { id: "overhead", blas: overhead, worldToLocal: identity, mask: 0b01 },
    { id: "tiny", blas: tiny, worldToLocal: identity, mask: tinyMask },
  ];
  const maxDistance = 32;
  const baseOptions = { enabled: true as const, directionCount: 8, maxDistance };
  const analytic8 = [
    enclosedExpectation(2, 8, maxDistance, 0.01),
    slabExpectation("under-overhead-slab", 3, 40, 40, 8, maxDistance, 0.01),
    openExpectation(8, maxDistance),
    enclosedExpectation(tinyHalfExtent, 8, maxDistance, 0.01),
  ];
  const tinyMaskedNote = "掩码案例中 tiny 壳被滤除，buried 探针解析预期同 overhead 探针（上 4 命中平板）。";
  const analytic8TinyMasked = [...analytic8.slice(0, 3),
    slabExpectation("tiny-shell-masked-away", 3, 40, 40, 8, maxDistance, 0.01)];
  return [
    { name: "scene-known-occluders",
      note: "四探针固定场景（封闭壳/平板下/开阔/tiny 壳）× 8 方向默认选项：全链派发 + 三层对拍。",
      probes: probes4, options: baseOptions, instances: instanceRow(0b01), analytic: analytic8 },
    { name: "scene-budget-clamp",
      note: "6 探针 × 4 方向、maxRaysPerFrame=16 → 前缀 4 探针派发（clamped=true）；尾部 2 探针双侧估计必须 undefined。",
      probes: [...probes4, probeAt(4, 0, -40, 4), probeAt(5, -12, 2, 0)],
      options: { ...baseOptions, directionCount: 4, maxRaysPerFrame: 16 },
      instances: instanceRow(0b01),
      analytic: [enclosedExpectation(2, 4, maxDistance, 0.01),
        slabExpectation("under-overhead-slab", 3, 40, 40, 4, maxDistance, 0.01),
        openExpectation(4, maxDistance), enclosedExpectation(tinyHalfExtent, 4, maxDistance, 0.01)] },
    { name: "scene-occluder-mask",
      note: `occluderMask=0b01 端到端：tiny 壳实例位 0b10 被两级过滤；${tinyMaskedNote}`,
      probes: probes4, options: { ...baseOptions, occluderMask: 0b01 },
      instances: instanceRow(0b10), analytic: analytic8TinyMasked },
  ];
}

export interface ProbeOcclusionCaseRequest {
  readonly name: string;
  readonly probes: readonly { readonly index: number; readonly x: number; readonly y: number;
    readonly z: number }[];
  readonly options: ProbeOcclusionRayExtensionOptions;
  readonly instances: readonly { readonly id: string; readonly verticesBase64: string;
    readonly indicesBase64: string; readonly worldToLocal: readonly number[]; readonly mask: number }[];
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

/** 案例规格 → 传输载荷（几何 base64；探针/选项 JSON 原生）。批次在浏览器内由同一合同函数构造。 */
export function encodeProbeOcclusionCaseRequest(spec: ProbeOcclusionCaseSpec): ProbeOcclusionCaseRequest {
  return { name: spec.name,
    probes: spec.probes.map(({ index, x, y, z }) => ({ index, x, y, z })),
    options: spec.options,
    instances: spec.instances.map((instance) => ({ id: instance.id, mask: instance.mask,
      worldToLocal: [...instance.worldToLocal],
      verticesBase64: toBase64(new Uint8Array(instance.blas.vertices.buffer,
        instance.blas.vertices.byteOffset, instance.blas.vertices.byteLength)),
      indicesBase64: toBase64(new Uint8Array(instance.blas.indices.buffer,
        instance.blas.indices.byteOffset, instance.blas.indices.byteLength)) })) };
}

/** RayBatchQuery → 逐射线 TraceQuery（Node 参考腿与浏览器诊断共用）。 */
export function batchQueryToTlasQueries(query: RayBatchQuery): TraceQuery[] {
  const list: TraceQuery[] = [];
  for (let index = 0; index < query.tMax.length; index++) {
    list.push({ ox: query.origins[index * 3]!, oy: query.origins[index * 3 + 1]!, oz: query.origins[index * 3 + 2]!,
      dx: query.directions[index * 3]!, dy: query.directions[index * 3 + 1]!, dz: query.directions[index * 3 + 2]!,
      tMax: query.tMax[index]! });
  }
  return list;
}

/** CPU 参考执行器（满足扩展执行器最小结构合同；mask 按查询透传给 traceTlasClosest）。 */
export function createCpuReferenceExecutor(tlas: TlasBuildResult): ProbeOcclusionRayExtensionExecutor {
  return { traceBatch: async (query: RayBatchQuery) => ({ hits: batchQueryToTlasQueries(query)
      .map((ray) => traceTlasClosest(tlas, ray, query.mask))
      .map((hit) => (hit === undefined ? undefined : { t: hit.t })) }) };
}

export interface ProbeOcclusionBackendCaseResult {
  readonly name: string;
  readonly rayCount: number;
  readonly dispatchedProbes: number;
  readonly clamped: boolean;
  readonly directionCount: number;
  readonly maxDistance: number;
  readonly occluderMask: number;
  /** 独立原始 dispatch 的两级命中（encodeGpuTlasHits 16B/射线，供逐射线仲裁）。 */
  readonly rawHitsBase64: string;
  readonly stackOverflows: number;
  /** 全链估计（probeOcclusionEstimatesWithRayExtension 输出；未派发/降级 = null）。 */
  readonly estimates: readonly (ProbeOcclusionEstimate | null)[];
  /** 全链降级原因（合同 fail-closed 回退；正常 undefined → 序列化为 null）。 */
  readonly degradedReason: string | null;
  readonly firstRawRecords: readonly (readonly number[])[];
  readonly cpuSanity: readonly (readonly (number | string)[])[];
}

export interface ProbeOcclusionProbeResult {
  readonly adapter: Readonly<Record<string, string | number>>;
  readonly features: readonly string[];
  readonly cases: Readonly<Record<string, ProbeOcclusionBackendCaseResult>>;
  /** 非法/警告级编译诊断（门禁对象）。 */
  readonly validationMessages: readonly string[];
  /** 全量编译诊断（含 info 级，排障用）。 */
  readonly compilationMessages: readonly string[];
  readonly errors: readonly string[];
}

const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

/** 浏览器腿：真实 WebGPU 设备上按完整 API 路径执行每案例（两级 TLAS 执行器真实 dispatch）。 */
export async function runProbeOcclusionGpuProbe(requests: readonly ProbeOcclusionCaseRequest[]):
  Promise<ProbeOcclusionProbeResult> {
  const errors: string[] = [];
  const cases: Record<string, ProbeOcclusionBackendCaseResult> = {};
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("requestAdapter returned null.");
  const device = await adapter.requestDevice({ label: "probe-occlusion-gpu-probe" });
  device.addEventListener?.("uncapturederror", (event) => {
    errors.push(`uncaptured: ${(event as GPUUncapturedErrorEvent).error.message}`);
  });
  const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  const compilationMessages: string[] = [];
  // kernel 编译诊断（error scope 之外独立模块采集；与执行器内建的 fail-closed 校验互补）。
  const diagnostic = device.createShaderModule({ label: "ray-trace-tlas-kernel-diagnostic",
    code: emitTwoLevelRayTraceKernelWgsl() });
  compilationMessages.push(...(await diagnostic.getCompilationInfo()).messages
    .map((message) => `${message.type}:${message.lineNum}:${message.message}`));
  const validationMessages = compilationMessages.filter((message) => !message.startsWith("info:"));
  try {
    for (const request of requests) {
      const instances: TlasInstanceDescriptor[] = request.instances.map((entry) => ({
        id: entry.id,
        blas: { id: entry.id,
          vertices: new Float32Array(base64ToBytes(entry.verticesBase64).buffer.slice(0)),
          indices: new Uint32Array(base64ToBytes(entry.indicesBase64).buffer.slice(0)) },
        worldToLocal: entry.worldToLocal as TlasInstanceDescriptor["worldToLocal"], mask: entry.mask }));
      const tlas = buildTlas(instances);
      const executor = new RayTraceGpuTlasExecutor(device, tlas); // WGSL 校验 fail-closed 在构造内。
      const resolved: ResolvedProbeOcclusionRayExtensionOptions =
        resolveProbeOcclusionRayExtensionOptions(request.options);
      const candidates = collectProbeOcclusionRayExtensionCandidates(request.probes);
      const batch = buildProbeOcclusionRayExtensionBatch(candidates, resolved);
      // 独立原始 dispatch（与全链各一次真实 dispatch；供逐射线仲裁 + 栈溢出哨兵受检）。
      const raw = await executor.traceBatch(batch.query);
      // 全链：闸门序 → 批次 → 执行器（RayTraceGpuTlasExecutor 结构性满足扩展执行器合同）→ 聚合。
      const full = await probeOcclusionEstimatesWithRayExtension(request.probes, request.options, executor);
      const queries = batchQueryToTlasQueries(batch.query);
      cases[request.name] = {
        name: request.name, rayCount: batch.query.tMax.length,
        dispatchedProbes: batch.dispatched.length, clamped: batch.clamped,
        directionCount: resolved.directionCount, maxDistance: resolved.maxDistance,
        occluderMask: batch.query.mask,
        rawHitsBase64: toBase64(new Uint8Array(encodeGpuTlasHits(raw.hits))),
        stackOverflows: raw.stackOverflows,
        estimates: full.estimates.map((estimate) => (estimate === undefined ? null : { ...estimate })),
        degradedReason: full.extension.degradedReason ?? null,
        firstRawRecords: raw.rawRecords.slice(0, 4)
          .map((record) => [record.t, record.primitiveIndex, record.status, record.instanceIndex]),
        cpuSanity: queries.slice(0, 4).map((ray) => {
          const hit = traceTlasClosest(tlas, ray, batch.query.mask);
          return hit ? [hit.t, hit.primitiveIndex, hit.instanceId] as const
            : [Number.NaN, Number.NaN, "miss"] as const;
        }),
      };
    }
  } finally {
    device.destroy();
  }
  return {
    adapter: { vendor: info?.vendor ?? "", architecture: info?.architecture ?? "", device: info?.device ?? "",
      description: info?.description ?? "" },
    features: [...adapter.features].sort(),
    cases, validationMessages, compilationMessages, errors,
  };
}
