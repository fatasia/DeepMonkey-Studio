/// <reference types="@webgpu/types" />
/**
 * RayBackend 真机探针（波次4；由 scripts/rayTraceGpuTest.mjs 驱动，headless Chrome + WebGPU）。
 * 与 r2ShaderIrProbe 同构：Node 侧与浏览器共用同一 bundle——案例生成、BLAS/BVH、执行器、
 * CPU 参考实现只此一份（防口径分叉）。浏览器腿用 RayTraceGpuExecutor 走完整 API 路径
 * （打包 → dispatch → 读回），数值哈希与对拍在 Node 侧仲裁。
 */

import { compareGpuAgainstCpu, RayTraceGpuExecutor, type GpuTraceHit } from "../src/rayTracing/rayTraceExecutor.js";
import { emitRayTraceKernelWgsl } from "../src/rayTracing/rayTraceKernel.js";
import { HIT_STATUS, HIT_RECORD_STRIDE_BYTES } from "../src/rayTracing/rayTraceLayout.js";
import { buildTracedScene, traceClosest, type TraceQuery } from "../src/rayTracing/rayTrace.js";
import { buildSsrRayExtensionBatch, collectSsrRayExtensionCandidates,
  resolveSsrRayExtensionOptions } from "../src/rayTracing/ssrRayExtension.js";
import type { ScreenSpaceReflectionCpuInput, ScreenSpaceReflectionCpuOptions,
} from "../src/postprocess/screenSpaceReflectionTypes.js";
import type { RayBlasDescriptor, RayBatchQuery } from "../src/rayTracing/rayBackendTypes.js";

export { buildTracedScene, traceClosest } from "../src/rayTracing/rayTrace.js";
export { compareGpuAgainstCpu, planRayTraceDispatch } from "../src/rayTracing/rayTraceExecutor.js";
export { emitRayTraceKernelWgsl } from "../src/rayTracing/rayTraceKernel.js";

export interface RayTraceCaseSpec {
  readonly name: string;
  readonly blas: RayBlasDescriptor;
  readonly rays: RayBatchQuery;
  readonly note: string;
}

function gridBlas(id: string, cells: number): RayBlasDescriptor {
  const stride = cells + 1;
  const vertices = new Float32Array(stride * stride * 3);
  for (let y = 0; y < stride; y++) for (let x = 0; x < stride; x++) {
    vertices.set([x, y, Math.sin(x * 13.7 + y * 7.3)], (y * stride + x) * 3);
  }
  const indices: number[] = [];
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    const a = y * stride + x, b = a + 1, c = a + stride, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { id, vertices, indices: Uint32Array.from(indices) };
}

function fanRays(count: number, origins: ReadonlyArray<readonly [number, number, number]>,
  dz: number, tMax: number, tMaxOverride?: (index: number) => number): RayBatchQuery {
  const originsOut = new Float32Array(count * 3), directions = new Float32Array(count * 3), tMaxOut = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    originsOut.set(origins[index % origins.length]!, index * 3);
    const angle = index / count * Math.PI * 2;
    directions.set([Math.cos(angle), Math.sin(angle), dz], index * 3);
    tMaxOut[index] = tMaxOverride ? tMaxOverride(index) : tMax;
  }
  return { origins: originsOut, directions, tMax: tMaxOut, mask: 0xff };
}

/** 视空间地板 BLAS（y=-3 平面网格）：SSR 二次射线案例的命中场景，与 vitest 端到端同构。 */
function ssrFloorBlas(): RayBlasDescriptor {
  const vertices: number[] = [], indices: number[] = [];
  for (let z = 0; z < 13; z++) for (let x = 0; x < 13; x++) {
    vertices.push(-36 + x * 6, -3, -6 - z * 3);
  }
  const stride = 13;
  for (let z = 0; z < 12; z++) for (let x = 0; x < 12; x++) {
    const a = z * stride + x;
    indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
  }
  return { id: "ssr-extension-floor", vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
}

/**
 * SSR 屏外二次射线案例（波次4 第一消费者切片）：16x16 视空间地板帧（法线朝上）经
 * collectSsrRayExtensionCandidates 收集 SSR miss∩有 origin 的像素，沿反射方向延长为
 * 二次射线（identity viewToBlas，BLAS=视空间），预算合同与 vitest 端到端一致。
 * SSR 候选生成与执行器共用同一 bundle，防口径分叉。
 */
function ssrSecondaryRayCase(): RayTraceCaseSpec {
  const width = 16, height = 16;
  const input: ScreenSpaceReflectionCpuInput = { width, height,
    depth: new Array<number>(width * height).fill(5),
    normals: new Array<number>(width * height * 3).fill(0)
      .map((_, index) => ([0, 1, 0][index % 3]! + 1) / 2),
    color: new Array<number>(width * height * 3).fill(0.1) };
  const options: ScreenSpaceReflectionCpuOptions = { verticalFovRadians: Math.PI / 3, maxDistance: 20,
    thickness: 0.5, steps: 32, refines: 4, edgeFade: 0.08, fresnelF0: 0.05 };
  const resolved = resolveSsrRayExtensionOptions({ enabled: true, albedo: [0.8, 0.6, 0.4],
    ambient: [1, 1, 1], tMax: 64, viewToBlas: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] });
  const collected = collectSsrRayExtensionCandidates(input, options, resolved);
  const batch = buildSsrRayExtensionBatch(collected.candidates, resolved);
  return { name: "ssr-secondary-rays", blas: ssrFloorBlas(), rays: batch.query,
    note: `SSR 屏外二次射线：${collected.missedPixels} 个 miss 像素中 ${batch.query.tMax.length} 个可延长，沿反射方向命中视空间地板（预算 ≤16384 合同）` };
}

/** 确定性案例集：网格高度场 + 单三角 + 平行轴 slab 探针 + tMax 截断探针 + SSR 二次射线。 */
export function buildRayTraceCases(): readonly RayTraceCaseSpec[] {
  const terrain = gridBlas("terrain-16", 16);
  const small = gridBlas("terrain-8", 8);
  return [
    { name: "grid-8x8-fan80", blas: small, rays: fanRays(80, [[3, 3, 6], [0.5, 0.5, 3]], -1, 64),
      note: "中位分裂 BVH 全深遍历；两圈射线扇（对应 rayTrace.test 的 80 射线 fan 模式）" },
    { name: "grid-16x16-fan64", blas: terrain, rays: fanRays(64, [[8, 8, 9], [4, 4, 5]], -0.6, 48),
      note: "512 三角形；更深的树 + 叶内多三角形扫描" },
    { name: "single-triangle-probe", blas: { id: "tri", vertices: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
      indices: new Uint32Array([0, 1, 2]) },
      rays: { origins: new Float32Array([2, 2, 4, 0.01, 0.01, 4, 11, 11, 4, 2, 2, 4]),
        directions: new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 1, 1, 0]),
        tMax: new Float32Array([16, 16, 16, 16]), mask: 1 },
      note: "命中/擦边/缺席/与三角平面平行的射线（det≈0 拒绝路径）" },
    { name: "axis-parallel-slab", blas: small, rays: fanRays(24, [[4, 4, 6]], 0, 32,
      (index) => (index % 3 === 0 ? 0.0001 : 32)),
      note: "dz=0（含 0.0001 近平行对照）触发 slab 平行轴分支（起点在 slab 内判定）" },
    { name: "tmax-cutoff", blas: small, rays: fanRays(48, [[4, 4, 6]], -1, 64, () => 0.01),
      note: "tMax 截断在命中之前：CPU/GPU 双侧全 miss" },
    ssrSecondaryRayCase(),
  ];
}

/** CPU 参考核查（Node 与浏览器同 bundle 一致语义）：批次 → TraceQuery 列表。 */
export function batchQueryToQueries(query: RayBatchQuery): TraceQuery[] {
  const list: TraceQuery[] = [];
  for (let index = 0; index < query.tMax.length; index++) {
    list.push({ ox: query.origins[index * 3]!, oy: query.origins[index * 3 + 1]!, oz: query.origins[index * 3 + 2]!,
      dx: query.directions[index * 3]!, dy: query.directions[index * 3 + 1]!, dz: query.directions[index * 3 + 2]!,
      tMax: query.tMax[index]! });
  }
  return list;
}

/** 命中数组 ↔ HitRecord 16B 布局的传输编码（status 合同见 rayTraceLayout）。 */
export function encodeGpuHits(hits: readonly (GpuTraceHit | undefined)[]): ArrayBuffer {
  const buffer = new ArrayBuffer(hits.length * HIT_RECORD_STRIDE_BYTES);
  const floats = new Float32Array(buffer), words = new Uint32Array(buffer);
  hits.forEach((hit, index) => {
    floats[index * 4] = hit ? hit.t : -1;
    words[index * 4 + 1] = hit ? hit.primitiveIndex : 0xffff_ffff;
    words[index * 4 + 2] = hit ? HIT_STATUS.hit : HIT_STATUS.miss;
  });
  return buffer;
}

export function decodeGpuHits(buffer: ArrayBuffer): readonly (GpuTraceHit | undefined)[] {
  const floats = new Float32Array(buffer), words = new Uint32Array(buffer);
  const hits: (GpuTraceHit | undefined)[] = [];
  for (let index = 0; index < words.length / 4; index++) {
    const status = words[index * 4 + 2]!;
    if (status === HIT_STATUS.hit) hits.push({ t: floats[index * 4]!, primitiveIndex: words[index * 4 + 1]! });
    else if (status === HIT_STATUS.miss) hits.push(undefined);
    else throw new Error(`decodeGpuHits: unknown status ${status} at ray ${index}.`);
  }
  return hits;
}

export interface RayTraceCaseRequest {
  readonly name: string;
  readonly verticesBase64: string;
  readonly indicesBase64: string;
  readonly originsBase64: string;
  readonly directionsBase64: string;
  readonly tMaxBase64: string;
}

export interface RayTraceBackendCaseResult {
  readonly hitsBase64: string;
  readonly stackOverflows: number;
  readonly rayCount: number;
  readonly validationMessages: readonly string[];
  /** 诊断：GPU 读回前 4 条原始 HitRecord (t, primitiveIndex, status)。 */
  readonly firstRawRecords: readonly (readonly [number, number, number])[];
  /** 诊断：浏览器侧同 bundle CPU 参考的前 4 条 (t, primitiveIndex|NaN)。 */
  readonly cpuSanity: readonly (readonly [number, number])[];
}

export interface RayTraceProbeResult {
  readonly adapter: Readonly<Record<string, string | number>>;
  readonly features: readonly string[];
  readonly cases: Readonly<Record<string, RayTraceBackendCaseResult>>;
  readonly errors: readonly string[];
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

/** 浏览器腿：真实 WebGPU 设备上按完整 API 路径执行每案例。 */
export async function runRayTraceGpuProbe(requests: readonly RayTraceCaseRequest[]): Promise<RayTraceProbeResult> {
  const errors: string[] = [];
  const cases: Record<string, RayTraceBackendCaseResult> = {};
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("requestAdapter returned null.");
  const device = await adapter.requestDevice({ label: "ray-trace-gpu-probe" });
  device.addEventListener?.("uncapturederror", (event) => {
    errors.push(`uncaptured: ${(event as GPUUncapturedErrorEvent).error.message}`);
  });
  const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  const diagnostic = device.createShaderModule({ label: "ray-trace-kernel-diagnostic", code: emitRayTraceKernelWgsl() });
  const validationMessages = (await diagnostic.getCompilationInfo()).messages
    .filter((message) => message.type !== "info")
    .map((message) => `${message.type}:${message.lineNum}:${message.message}`);
  try {
    for (const request of requests) {
      const blas: RayBlasDescriptor = {
        id: request.name,
        vertices: new Float32Array(base64ToBytes(request.verticesBase64).buffer.slice(0)),
        indices: new Uint32Array(base64ToBytes(request.indicesBase64).buffer.slice(0)),
      };
      const executor = new RayTraceGpuExecutor(device, blas);
      const rays: RayBatchQuery = {
        origins: new Float32Array(base64ToBytes(request.originsBase64).buffer.slice(0)),
        directions: new Float32Array(base64ToBytes(request.directionsBase64).buffer.slice(0)),
        tMax: new Float32Array(base64ToBytes(request.tMaxBase64).buffer.slice(0)),
        mask: 0xff,
      };
      const result = await executor.traceBatch(rays);
      const queries = batchQueryToQueries(rays);
      const scene = buildTracedScene(blas);
      cases[request.name] = {
        hitsBase64: bytesToBase64(new Uint8Array(encodeGpuHits(result.hits))),
        stackOverflows: result.stackOverflows,
        rayCount: rays.tMax.length,
        validationMessages,
        firstRawRecords: result.rawRecords.slice(0, 4)
          .map((record) => [record.t, record.primitiveIndex, record.status] as const),
        cpuSanity: queries.slice(0, 4).map((query) => {
          const hit = traceClosest(scene, query);
          return [hit ? hit.t : Number.NaN, hit ? hit.primitiveIndex : Number.NaN] as const;
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
    cases,
    errors,
  };
}
