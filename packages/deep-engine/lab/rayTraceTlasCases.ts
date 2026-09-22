/// <reference types="@webgpu/types" />
/**
 * TLAS 两级真机案例与传输编码（与 rayTraceGpuProbe 同 esbuild bundle，Node 参考腿与
 * 浏览器腿单一来源，防口径分叉）。案例常量全部取 f32 精确值（0.5/±整数平移），保证
 * Node 侧 CPU 参考与浏览器腿的实例变换输入逐位一致。
 * 案例镜像 tlas.test.ts：近/远平移选择、mask 过滤、非均匀缩放（方向缩放 t 修正）。
 */

import { HIT_STATUS, HIT_RECORD_STRIDE_BYTES } from "../src/rayTracing/rayTraceLayout.js";
import type { RayBlasDescriptor, RayBatchQuery } from "../src/rayTracing/rayBackendTypes.js";
import { buildTlas, traceTlasClosest, type TlasInstanceDescriptor } from "../src/rayTracing/tlas.js";
import { RayTraceGpuTlasExecutor, type GpuTlasHit } from "../src/rayTracing/rayTraceTlasExecutor.js";
import type { TraceQuery } from "../src/rayTracing/rayTrace.js";

export { buildTlas, traceTlasClosest } from "../src/rayTracing/tlas.js";
export { RayTraceGpuTlasExecutor, compareTlasGpuAgainstCpu, planTlasDispatch } from "../src/rayTracing/rayTraceTlasExecutor.js";
export { packTlasScene } from "../src/rayTracing/tlasLayout.js";

export interface RayTraceTlasCaseSpec {
  readonly name: string;
  readonly note: string;
  readonly instances: readonly TlasInstanceDescriptor[];
  readonly rays: RayBatchQuery;
}

function quadBlas(id: string): RayBlasDescriptor {
  return { id, vertices: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
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
  dz: (index: number) => number, tMax: number, mask: number): RayBatchQuery {
  const originsOut = new Float32Array(count * 3), directions = new Float32Array(count * 3), tMaxOut = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    originsOut.set(origins[index % origins.length]!, index * 3);
    // 半步角偏移：整数 1/8 周角射线与网格单元对角共享边共线时，f64 CPU 与 f32 GPU 会把
    // 擦边命中判给相邻三角（t 一致、primitiveIndex 抖动）；半步旋转避开精确对角线。
    const angle = (index + 0.5) / count * Math.PI * 2;
    // xy 分量收窄 + dz 主导向下：保证扇内多数射线真实命中（对拍非空洞）；周期性 dz=0
    // 探针触发 TLAS/BLAS 两级 slab 平行轴分支（起点在盒外，平行分支正确剪枝）。
    directions.set([Math.cos(angle) * 0.4, Math.sin(angle) * 0.4, dz(index)], index * 3);
    tMaxOut[index] = tMax;
  }
  return { origins: originsOut, directions, tMax: tMaxOut, mask };
}

/** 行主序 3×4 仿射（与 TlasInstanceDescriptor.worldToLocal 同形）。 */
type Affine3x4 = readonly [number, number, number, number, number, number, number,
  number, number, number, number, number];

const IDENTITY: Affine3x4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const TRANSLATE_Z = (z: number): Affine3x4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, z];

/** 确定性两级案例集：近/远平移 + mask 过滤、双网格多实例、非均匀缩放 t 修正。 */
export function buildRayTraceTlasCases(): readonly RayTraceTlasCaseSpec[] {
  return [
    { name: "tlas-two-quad-near-far",
      instances: [
        { id: "near", blas: quadBlas("near"), worldToLocal: IDENTITY, mask: 0b01 },
        { id: "far", blas: quadBlas("far"), worldToLocal: TRANSLATE_Z(5), mask: 0b01 },
        // worldToLocal z-2 ⇒ 世界 z=+2：位于射线原点与近实例之间，若掩码失效会以 t=3 胜出
        // （近实例 t=5）——真机级验证 mask 过滤，而非仅 TLAS 遍历跳过。
        { id: "masked-away", blas: quadBlas("masked"), worldToLocal: TRANSLATE_Z(-2), mask: 0b10 },
      ],
      rays: fanRays(64, [[0, 0, 5], [0.5, 0.5, 4]], (index) => (index % 8 === 0 ? 0 : -4), 64, 0b01),
      note: "近/远平移实例最近选择 + mask=0b01 过滤更近的被掩码实例（t=3 被跳过，近实例 t=5 胜出）；64 射线扇含 dz=0 平行探针" },
    { name: "tlas-translated-grids",
      instances: [
        { id: "grid-near", blas: gridBlas("grid-near", 8), worldToLocal: IDENTITY, mask: 0b01 },
        { id: "grid-far", blas: gridBlas("grid-far", 8), worldToLocal: TRANSLATE_Z(7), mask: 0b10 },
      ],
      rays: fanRays(80, [[4, 4, 7], [1, 1, 4]], (index) => (index % 8 === 0 ? 0 : -0.6), 48, 0b11),
      note: "双 128 三角网格 BLAS 平移实例：TLAS/BLAS 两级 BVH 全深遍历，mask=0b11 双实例可见" },
    { name: "tlas-scale-translate",
      instances: [
        { id: "scaled", blas: quadBlas("scaled"), worldToLocal: [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0], mask: 1 },
        { id: "translated", blas: quadBlas("translated"), worldToLocal: TRANSLATE_Z(5), mask: 1 },
      ],
      rays: fanRays(48, [[0, 0, 10], [0, 0, 6]], (index) => (index % 8 === 0 ? 0 : -6), 64, 1),
      note: "非均匀缩放实例（世界=2×局部）：GPU 局部方向归一化 + tMax×scale + 命中 t÷scale 与 CPU 逐式对拍" },
  ];
}

/** 两级命中 ↔ 16B HitRecord 传输编码（slot4 = instanceIndex，两级附加合同）。 */
export function encodeGpuTlasHits(hits: readonly (GpuTlasHit | undefined)[]): ArrayBuffer {
  const buffer = new ArrayBuffer(hits.length * HIT_RECORD_STRIDE_BYTES);
  const floats = new Float32Array(buffer), words = new Uint32Array(buffer);
  hits.forEach((hit, index) => {
    floats[index * 4] = hit ? hit.t : -1;
    words[index * 4 + 1] = hit ? hit.primitiveIndex : 0xffff_ffff;
    words[index * 4 + 2] = hit ? HIT_STATUS.hit : HIT_STATUS.miss;
    words[index * 4 + 3] = hit ? hit.instanceIndex : 0xffff_ffff;
  });
  return buffer;
}

export function decodeGpuTlasHits(buffer: ArrayBuffer): readonly (GpuTlasHit | undefined)[] {
  const floats = new Float32Array(buffer), words = new Uint32Array(buffer);
  const hits: (GpuTlasHit | undefined)[] = [];
  for (let index = 0; index < words.length / 4; index++) {
    const status = words[index * 4 + 2]!;
    if (status === HIT_STATUS.hit) {
      hits.push({ t: floats[index * 4]!, primitiveIndex: words[index * 4 + 1]!, instanceIndex: words[index * 4 + 3]! });
    } else if (status === HIT_STATUS.miss) hits.push(undefined);
    else throw new Error(`decodeGpuTlasHits: unknown status ${status} at ray ${index}.`);
  }
  return hits;
}

export interface RayTraceTlasCaseRequest {
  readonly name: string;
  readonly instances: readonly {
    readonly id: string;
    readonly verticesBase64: string;
    readonly indicesBase64: string;
    readonly worldToLocal: Affine3x4;
    readonly mask: number;
  }[];
  readonly originsBase64: string;
  readonly directionsBase64: string;
  readonly tMaxBase64: string;
  readonly mask: number;
}

export interface RayTraceTlasBackendCaseResult {
  readonly hitsBase64: string;
  readonly stackOverflows: number;
  readonly rayCount: number;
  readonly instanceCount: number;
  /** 诊断：GPU 读回前 4 条原始 HitRecord (t, primitiveIndex, status, instanceIndex)。 */
  readonly firstRawRecords: readonly (readonly number[])[];
  /** 诊断：浏览器侧同 bundle CPU 参考前 4 条 (t, primitiveIndex|NaN, instanceId)。 */
  readonly cpuSanity: readonly (readonly (number | string)[])[];
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

export const base64ToBytes = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

/** 浏览器腿：单案例完整 API 路径（buildTlas → 执行器打包 → dispatch → 读回）。 */
export async function runTlasCase(device: GPUDevice, request: RayTraceTlasCaseRequest): Promise<RayTraceTlasBackendCaseResult> {
  const instances: TlasInstanceDescriptor[] = request.instances.map((entry) => ({
    id: entry.id,
    blas: { id: entry.id, vertices: new Float32Array(base64ToBytes(entry.verticesBase64).buffer.slice(0)),
      indices: new Uint32Array(base64ToBytes(entry.indicesBase64).buffer.slice(0)) },
    worldToLocal: entry.worldToLocal,
    mask: entry.mask,
  }));
  const tlas = buildTlas(instances);
  const executor = new RayTraceGpuTlasExecutor(device, tlas);
  const rays: RayBatchQuery = {
    origins: new Float32Array(base64ToBytes(request.originsBase64).buffer.slice(0)),
    directions: new Float32Array(base64ToBytes(request.directionsBase64).buffer.slice(0)),
    tMax: new Float32Array(base64ToBytes(request.tMaxBase64).buffer.slice(0)),
    mask: request.mask,
  };
  const result = await executor.traceBatch(rays);
  const queries: TraceQuery[] = [];
  for (let index = 0; index < rays.tMax.length; index++) {
    queries.push({ ox: rays.origins[index * 3]!, oy: rays.origins[index * 3 + 1]!, oz: rays.origins[index * 3 + 2]!,
      dx: rays.directions[index * 3]!, dy: rays.directions[index * 3 + 1]!, dz: rays.directions[index * 3 + 2]!, tMax: rays.tMax[index]! });
  }
  return {
    hitsBase64: bytesToBase64(new Uint8Array(encodeGpuTlasHits(result.hits))),
    stackOverflows: result.stackOverflows,
    rayCount: rays.tMax.length,
    instanceCount: executor.packed.instanceCount,
    firstRawRecords: result.rawRecords.slice(0, 4)
      .map((record) => [record.t, record.primitiveIndex, record.status, record.instanceIndex]),
    cpuSanity: queries.slice(0, 4).map((query) => {
      const hit = traceTlasClosest(tlas, query, rays.mask);
      return hit ? [hit.t, hit.primitiveIndex, hit.instanceId] as const : [Number.NaN, Number.NaN, "miss"] as const;
    }),
  };
}
