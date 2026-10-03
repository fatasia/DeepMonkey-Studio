/// <reference types="@webgpu/types" />
/**
 * 方向光阴影光线 pass 执行器（compute BVH 光追骨架·Web 通道基座切片）。
 * 与 rayTraceTlasExecutor（每批重建全部缓冲）不同，本 pass 为**持久缓冲骨架**：
 * 场景缓冲（nodes/instances/vertices/indices/order，tlasLayout 拼接布局）构造期一次
 * 创建上传，批量 dispatch 只写射线流/mask/uniform——增量 TLAS（incrementalTlas）换
 * TLAS 段/实例记录时只重写对应缓冲区，BLAS 顶点/索引/节点段驻留不动。
 *
 * == 合同 ==
 * - f16=true 需 device.features "shader-f16"，缺失即构造抛错（fail-closed，不静默降级）；
 * - WGSL 编译错误、GPU validation 错误、栈溢出哨兵非零一律抛错，绝不静默降级；
 * - mask 输出 1=可见（miss）/0=遮挡（命中）；溢出射线写 0 且整批拒绝（同既有 RT 合同）；
 * - GPU 时间测量（<2ms 验收门）属探针职责（timestamp-query 类型缺失 @webgpu/types
 *   0.1.72，lab 探针以局部类型扩充实现），本 pass 不掺测量语义。
 * buffer usage 沿用规范数值常量（node/vitest stub 无 WebGPU 全局同样可导入）。
 */

import { RAY_BACKEND_LIMITS, type RayBatchQuery } from "./rayBackendTypes.js";
import { emitShadowRayMaskKernelWgsl, packShadowRayUniform, SHADOW_RAY_MASK_ENTRY_POINT } from "./shadowRayKernel.js";
import { packRayBatch, RAY_TRACE_WORKGROUP_SIZE, unpackStackOverflows } from "./rayTraceLayout.js";
import type { TlasPackedScene } from "./tlasLayout.js";
import { traceTlasClosest, type TlasBuildResult } from "./tlas.js";
import { readBack } from "./rayTraceExecutor.js";
import type { TraceQuery } from "./rayTrace.js";

export interface ShadowRayMaskResult {
  /** 逐射线可见性（1=可见/0=遮挡），与射线流同序。 */
  readonly mask: Uint32Array;
  readonly stackOverflows: number;
  /** GPU dispatch 时间（ms；timestamp query 实测。measureGpuTime 未开/feature 缺失为 undefined）。 */
  readonly gpuMs?: number;
}

export interface ShadowRayPassOptions {
  /** f16 压缩节点档（需 shader-f16 feature；默认 false）。 */
  readonly f16?: boolean;
  /** GPU 时间测量（timestamp-query；<2ms 验收门的数据源，默认 false）。 */
  readonly measureGpuTime?: boolean;
}

const USAGE_STORAGE = 0x80, USAGE_COPY_DST = 0x8, USAGE_COPY_SRC = 0x4, USAGE_MAP_READ = 0x1, USAGE_UNIFORM = 0x40;
const USAGE_QUERY_RESOLVE = 0x200;
const MAP_MODE_READ = 0x1;
const TIMESTAMP_BYTES = 16;
/**
 * @webgpu/types 0.1.72 尚无 GPUCommandEncoder.writeTimestamp（运行时 WebGPU 规范已有）；
 * 局部类型桥接（运行时缺失会由 validation error scope fail-closed 捕获，不会静默）。
 */
type TimestampEncoder = GPUCommandEncoder & { writeTimestamp(querySet: GPUQuerySet, queryIndex: number): void };

export class ShadowRayMaskPass {
  /** packed scene 当前视图（探针校验 placements/instanceCount 用；增量更新时整体替换）。 */
  packed: TlasPackedScene;
  private readonly pipeline: GPUComputePipeline;
  private readonly validated: Promise<void>;
  private readonly sceneBuffers: GPUBuffer[];
  private readonly querySet?: GPUQuerySet;
  private readonly queryBuffer?: GPUBuffer;
  private readonly queryReadback?: GPUBuffer;

  constructor(private readonly device: GPUDevice, packed: TlasPackedScene, options: ShadowRayPassOptions = {}) {
    this.packed = packed;
    if (options.f16 === true && !device.features.has("shader-f16")) {
      throw new Error("ShadowRayMaskPass f16 variant requires the shader-f16 adapter feature.");
    }
    const wantTiming = options.measureGpuTime === true && device.features.has("timestamp-query");
    if (options.measureGpuTime === true && !wantTiming) {
      throw new Error("ShadowRayMaskPass measureGpuTime requires the timestamp-query adapter feature.");
    }
    if (packed.instanceCount > RAY_BACKEND_LIMITS.maxInstances) {
      throw new Error(`ShadowRayMaskPass: exceeds maxInstances (${RAY_BACKEND_LIMITS.maxInstances}).`);
    }
    device.pushErrorScope("validation");
    this.pipeline = device.createComputePipeline({ label: "shadow-ray-mask-batch", layout: "auto",
      compute: { module: device.createShaderModule({ label: "shadow-ray-mask-batch",
        code: emitShadowRayMaskKernelWgsl({ f16: options.f16 === true }) }), entryPoint: SHADOW_RAY_MASK_ENTRY_POINT } });
    this.validated = device.popErrorScope().then((error) => {
      if (error) throw new Error(`Shadow ray mask WGSL validation failed: ${error.message}`);
    });
    const storage = USAGE_STORAGE | USAGE_COPY_DST;
    const make = (label: string, size: number): GPUBuffer => device.createBuffer({ label, size, usage: storage });
    // 场景缓冲持久驻留（基座合同）：构造期一次上传，dispatch 不重写。
    const nodes = make("shadow-rays-nodes", Math.max(4, packed.nodeBytes.byteLength));
    const instances = make("shadow-rays-instances", Math.max(128, packed.recordBytes.byteLength));
    const vertices = make("shadow-rays-vertices", Math.max(4, packed.vertices.byteLength));
    const indices = make("shadow-rays-indices", Math.max(4, packed.indices.byteLength));
    const order = make("shadow-rays-order", Math.max(4, packed.order.byteLength));
    device.queue.writeBuffer(nodes, 0, packed.nodeBytes);
    device.queue.writeBuffer(instances, 0, packed.recordBytes);
    device.queue.writeBuffer(vertices, 0, packed.vertices.buffer, packed.vertices.byteOffset, packed.vertices.byteLength);
    device.queue.writeBuffer(indices, 0, packed.indices.buffer, packed.indices.byteOffset, packed.indices.byteLength);
    device.queue.writeBuffer(order, 0, packed.order.buffer, packed.order.byteOffset, packed.order.byteLength);
    this.sceneBuffers = [nodes, instances, vertices, indices, order];
    if (wantTiming) {
      this.querySet = device.createQuerySet({ label: "shadow-rays-timestamps", type: "timestamp", count: 2 });
      this.queryBuffer = device.createBuffer({ label: "shadow-rays-timestamp-resolve", size: TIMESTAMP_BYTES,
        usage: USAGE_QUERY_RESOLVE | USAGE_COPY_SRC });
      this.queryReadback = device.createBuffer({ label: "shadow-rays-timestamp-readback", size: TIMESTAMP_BYTES,
        usage: USAGE_COPY_DST | USAGE_MAP_READ });
    }
  }

  /** 增量 TLAS 接线：实例记录/TLAS 节点段重写（BLAS 段与顶点/索引驻留不动）。 */
  updateTlasRegion(packed: TlasPackedScene): void {
    if (packed.blasNodeCount !== this.packed.blasNodeCount || packed.triangleCount !== this.packed.triangleCount) {
      throw new Error("updateTlasRegion requires unchanged BLAS segments (build a new pass instead).");
    }
    this.packed = packed;
    const [nodes, instances] = this.sceneBuffers;
    this.device.queue.writeBuffer(nodes!, 0, packed.nodeBytes);
    this.device.queue.writeBuffer(instances!, 0, packed.recordBytes);
  }

  /** 批量阴影可见性；零射线/零实例不触 GPU（全 1 可见，与 CPU 空 TLAS 全 miss 一致）。 */
  async dispatchMask(query: RayBatchQuery): Promise<ShadowRayMaskResult> {
    await this.validated;
    const rayCount = query.tMax.length;
    if (rayCount > RAY_BACKEND_LIMITS.maxBatchRays) {
      throw new Error(`Shadow ray batch exceeds maxBatchRays budget (${RAY_BACKEND_LIMITS.maxBatchRays}).`);
    }
    const visibleAll = new Uint32Array(rayCount).fill(1);
    if (rayCount === 0 || this.packed.instanceCount === 0) return { mask: visibleAll, stackOverflows: 0 };
    const packedRays = packRayBatch(query);
    const dispatchX = Math.ceil(rayCount / RAY_TRACE_WORKGROUP_SIZE);
    const maskBytes = rayCount * 4;
    const d = this.device;
    const make = (label: string, size: number, usage: number): GPUBuffer => d.createBuffer({ label, size, usage });
    const rays = make("shadow-rays-stream", packedRays.byteLength, USAGE_STORAGE | USAGE_COPY_DST);
    const masks = make("shadow-rays-masks", maskBytes, USAGE_STORAGE | USAGE_COPY_SRC);
    const overflows = make("shadow-rays-overflows", 4, USAGE_STORAGE | USAGE_COPY_DST | USAGE_COPY_SRC);
    const uniform = make("shadow-rays-uniform", 16, USAGE_UNIFORM | USAGE_COPY_DST);
    const maskReadback = make("shadow-rays-mask-readback", maskBytes, USAGE_COPY_DST | USAGE_MAP_READ);
    const overflowReadback = make("shadow-rays-overflow-readback", 4, USAGE_COPY_DST | USAGE_MAP_READ);
    try {
      d.pushErrorScope("validation");
      d.queue.writeBuffer(rays, 0, packedRays.buffer, packedRays.byteOffset, packedRays.byteLength);
      d.queue.writeBuffer(overflows, 0, new Uint32Array([0]));
      d.queue.writeBuffer(uniform, 0, packShadowRayUniform(rayCount, query.mask));
      const bindGroup = d.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0),
        entries: [...this.sceneBuffers, rays, masks, overflows, uniform]
          .map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const encoder = d.createCommandEncoder({ label: "shadow-ray-mask-batch" });
      if (this.querySet !== undefined) (encoder as TimestampEncoder).writeTimestamp(this.querySet, 0);
      const pass = encoder.beginComputePass({ label: "shadow-ray-mask-batch" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(dispatchX, 1, 1);
      pass.end();
      if (this.querySet !== undefined) (encoder as TimestampEncoder).writeTimestamp(this.querySet, 1);
      encoder.copyBufferToBuffer(masks, 0, maskReadback, 0, maskBytes);
      encoder.copyBufferToBuffer(overflows, 0, overflowReadback, 0, 4);
      if (this.querySet !== undefined && this.queryBuffer !== undefined && this.queryReadback !== undefined) {
        encoder.resolveQuerySet(this.querySet, 0, 2, this.queryBuffer, 0);
        encoder.copyBufferToBuffer(this.queryBuffer, 0, this.queryReadback, 0, TIMESTAMP_BYTES);
      }
      d.queue.submit([encoder.finish()]);
      const validationError = await d.popErrorScope();
      if (validationError) throw new Error(`Shadow ray mask GPU validation failed: ${validationError.message}`);
      const [maskBytesRead, overflowBytesRead] = await Promise.all([
        readBack(maskReadback), readBack(overflowReadback)]);
      const stackOverflows = unpackStackOverflows(overflowBytesRead);
      if (stackOverflows !== 0) {
        throw new Error(`Shadow ray mask stack overflow on ${stackOverflows} ray(s); batch rejected (fail-closed).`);
      }
      let gpuMs: number | undefined;
      if (this.queryReadback !== undefined) {
        await this.queryReadback.mapAsync(MAP_MODE_READ, 0, TIMESTAMP_BYTES);
        const stamps = new BigUint64Array(this.queryReadback.getMappedRange(0, TIMESTAMP_BYTES));
        gpuMs = Number(stamps[1]! - stamps[0]!) * 1e-6; // GPU 时间戳纳秒 → 毫秒。
        this.queryReadback.unmap();
      }
      return { mask: new Uint32Array(maskBytesRead), stackOverflows, ...(gpuMs !== undefined ? { gpuMs } : {}) };
    } finally {
      for (const buffer of [rays, masks, overflows, uniform, maskReadback, overflowReadback]) buffer.destroy();
    }
  }

  destroy(): void {
    for (const buffer of this.sceneBuffers) buffer.destroy();
    this.querySet?.destroy();
    this.queryBuffer?.destroy();
    this.queryReadback?.destroy();
  }
}

/** 方向光阴影批次：受光点集 + 单位化"指向光"方向 → 平行遮挡射线（RT 阴影语义）。 */
export function packDirectionalShadowRays(receivers: Float32Array, toLightX: number, toLightY: number,
  toLightZ: number, tMax: number, occluderMask = 0xFFFF_FFFF): RayBatchQuery {
  if (receivers.length % 3 !== 0) throw new Error("Shadow ray receivers must be 3 floats per point.");
  if (![toLightX, toLightY, toLightZ, tMax].every(Number.isFinite) || Math.hypot(toLightX, toLightY, toLightZ) === 0) {
    throw new Error("Shadow ray to-light direction and tMax must be finite (direction nonzero).");
  }
  if (!(tMax > 0)) throw new Error("Shadow ray tMax must be positive.");
  const length = Math.hypot(toLightX, toLightY, toLightZ);
  const directions = new Float32Array(receivers.length);
  for (let i = 0; i < receivers.length / 3; i++) {
    directions[i * 3] = toLightX / length; directions[i * 3 + 1] = toLightY / length; directions[i * 3 + 2] = toLightZ / length;
  }
  const tMaxs = new Float32Array(receivers.length / 3).fill(tMax);
  return { origins: receivers.slice(), directions, tMax: tMaxs, mask: occluderMask >>> 0 };
}

/** CPU 仲裁镜像：遮挡查询语义同 GPU（traceTlasClosest 命中 ⇒ 0 遮挡，miss ⇒ 1 可见）。 */
export function shadowMaskFromTlas(tlas: TlasBuildResult, queries: readonly TraceQuery[], mask = 0xFFFF_FFFF): Uint32Array {
  const result = new Uint32Array(queries.length);
  queries.forEach((query, index) => {
    result[index] = traceTlasClosest(tlas, query, mask) === undefined ? 1 : 0;
  });
  return result;
}
