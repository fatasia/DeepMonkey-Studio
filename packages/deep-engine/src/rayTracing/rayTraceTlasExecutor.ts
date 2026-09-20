/// <reference types="@webgpu/types" />
/**
 * RayBackend 两级（TLAS→BLAS）WGSL 软件执行器。旧单 BLAS 入口 rayTraceExecutor.ts
 * 零变化（方法/缓冲/布局不动）；本文件为纯新增入口：
 * - 打包：tlasLayout.packTlasScene（实例记录 128B + 多 BLAS 拼接单缓冲，偏移合同见其头注释）；
 * - kernel：emitTwoLevelRayTraceKernelWgsl（ray_trace_tlas_batch）；
 * - 对拍：compareTlasGpuAgainstCpu 以 tlas.traceTlasClosest 为仲裁基准——命中/缺席一致、
 *   instanceIndex 精确、primitiveIndex（经 placement 折算的全局三角下标）精确、t 相对 1e-5；
 * - fail-closed 与单级同合同：WGSL 编译错误、binding/usage 校验错误、栈溢出哨兵非零、
 *   未知 status、命中却带 SENTINEL instanceIndex 一律抛错，绝不静默降级。
 * buffer usage/map mode 沿用规范数值常量（node/vitest stub 无 WebGPU 全局同样可执行）。
 */

import { RAY_BACKEND_LIMITS, validateRayBlas, type RayBatchQuery } from "./rayBackendTypes.js";
import { emitTwoLevelRayTraceKernelWgsl, RAY_TRACE_TLAS_ENTRY_POINT } from "./rayTraceTlasKernel.js";
import { HIT_STATUS, packRayBatch, RAY_TRACE_STACK_CAPACITY, RAY_TRACE_WORKGROUP_SIZE,
  unpackStackOverflows } from "./rayTraceLayout.js";
import type { TraceQuery } from "./rayTrace.js";
import { readBack } from "./rayTraceExecutor.js";
import { packTlasScene, TLAS_INSTANCE_SENTINEL, unpackTlasHitRecords,
  type TlasBlasPlacement, type TlasPackedScene } from "./tlasLayout.js";
import { traceTlasClosest, type TlasBuildResult } from "./tlas.js";

/** 两级 GPU 命中：t 为世界方向长度单位；primitiveIndex 为拼接后全局三角下标（indices 下标）。 */
export interface GpuTlasHit {
  readonly t: number;
  readonly primitiveIndex: number;
  readonly instanceIndex: number;
}

export interface RayTraceTlasBatchResult {
  /** miss → undefined（与 traceTlasClosest 合同一致）。 */
  readonly hits: readonly (GpuTlasHit | undefined)[];
  readonly stackOverflows: number;
  /** 读回的原始 HitRecord（pad0 = instanceIndex，两级附加合同见 tlasLayout）。 */
  readonly rawRecords: ReturnType<typeof unpackTlasHitRecords>;
}

export interface RayTraceTlasDispatchPlan {
  readonly rayCount: number;
  readonly instanceCount: number;
  readonly tlasNodeCount: number;
  readonly blasNodeCount: number;
  readonly triangleCount: number;
  readonly dispatchX: number;
  readonly nodeBytes: number;
  readonly instanceBytes: number;
  readonly rayBytes: number;
  readonly hitBytes: number;
}

/** 纯计划函数（无 GPU 依赖，stub/真机共用）。 */
export function planTlasDispatch(packed: TlasPackedScene, rayCount: number): RayTraceTlasDispatchPlan {
  return {
    rayCount, instanceCount: packed.instanceCount,
    tlasNodeCount: packed.tlasNodeCount, blasNodeCount: packed.blasNodeCount,
    triangleCount: packed.triangleCount, dispatchX: Math.ceil(rayCount / RAY_TRACE_WORKGROUP_SIZE),
    nodeBytes: packed.nodeBytes.byteLength, instanceBytes: packed.recordBytes.byteLength,
    rayBytes: rayCount * 32, hitBytes: rayCount * 16,
  };
}

const USAGE_STORAGE = 0x80, USAGE_COPY_DST = 0x8, USAGE_COPY_SRC = 0x4, USAGE_MAP_READ = 0x1, USAGE_UNIFORM = 0x40;
const MAP_MODE_READ = 0x1;

export class RayTraceGpuTlasExecutor {
  readonly packed: TlasPackedScene;
  /** WGSL 编译验证（error scope）；traceBatch 先 await，编译失败 fail-closed 抛错。 */
  private readonly validated: Promise<void>;
  private readonly module: GPUShaderModule;
  private readonly pipeline: GPUComputePipeline;

  constructor(private readonly device: GPUDevice, tlas: TlasBuildResult) {
    if (tlas.instances.length > RAY_BACKEND_LIMITS.maxInstances) {
      throw new Error(`Cannot create RayTraceGpuTlasExecutor: exceeds maxInstances (${RAY_BACKEND_LIMITS.maxInstances}).`);
    }
    for (const instance of tlas.instances) {
      const invalid = validateRayBlas(instance.blas);
      if (invalid !== undefined) throw new Error(`Cannot create RayTraceGpuTlasExecutor: instance ${instance.id}: ${invalid}`);
    }
    this.packed = packTlasScene(tlas);
    device.pushErrorScope("validation");
    this.module = device.createShaderModule({ label: "ray-trace-tlas-batch", code: emitTwoLevelRayTraceKernelWgsl() });
    this.pipeline = device.createComputePipeline({ label: "ray-trace-tlas-batch", layout: "auto",
      compute: { module: this.module, entryPoint: RAY_TRACE_TLAS_ENTRY_POINT } });
    this.validated = device.popErrorScope().then((error) => {
      if (error) throw new Error(`Two-level ray trace WGSL validation failed: ${error.message}`);
    });
  }

  /** 两级批量最近命中；零射线/零实例不触 GPU（与 CPU traceTlasClosest 空 TLAS 全 miss 一致）。 */
  async traceBatch(query: RayBatchQuery): Promise<RayTraceTlasBatchResult> {
    await this.validated;
    const rayCount = query.tMax.length;
    if (rayCount > RAY_BACKEND_LIMITS.maxBatchRays) {
      throw new Error(`Ray batch exceeds maxBatchRays budget (${RAY_BACKEND_LIMITS.maxBatchRays}).`);
    }
    if (rayCount === 0 || this.packed.instanceCount === 0) {
      return { hits: new Array<GpuTlasHit | undefined>(rayCount).fill(undefined), stackOverflows: 0, rawRecords: [] };
    }
    const plan = planTlasDispatch(this.packed, rayCount);
    const packedRays = packRayBatch(query);
    const make = (label: string, size: number, usage: number): GPUBuffer =>
      this.device.createBuffer({ label, size, usage });
    const storage = USAGE_STORAGE | USAGE_COPY_DST;
    const buffers = {
      nodes: make("rt-tlas-nodes", plan.nodeBytes, storage),
      instances: make("rt-tlas-instances", plan.instanceBytes, storage),
      vertices: make("rt-tlas-vertices", this.packed.vertices.byteLength, storage),
      indices: make("rt-tlas-indices", this.packed.indices.byteLength, storage),
      order: make("rt-tlas-order", this.packed.order.byteLength, storage),
      rays: make("rt-tlas-rays", plan.rayBytes, storage),
      hits: make("rt-tlas-hits", plan.hitBytes, storage | USAGE_COPY_SRC),
      overflows: make("rt-tlas-overflows", 4, storage | USAGE_COPY_SRC),
      uniform: make("rt-tlas-uniform", 16, USAGE_UNIFORM | USAGE_COPY_DST),
      hitReadback: make("rt-tlas-hit-readback", plan.hitBytes, USAGE_COPY_DST | USAGE_MAP_READ),
      overflowReadback: make("rt-tlas-overflow-readback", 4, USAGE_COPY_DST | USAGE_MAP_READ),
    };
    try {
      const q = this.device.queue;
      this.device.pushErrorScope("validation");
      // ArrayBuffer 形态 writeBuffer：offset/size 恒为字节（与单级执行器同口径）。
      q.writeBuffer(buffers.nodes, 0, this.packed.nodeBytes);
      q.writeBuffer(buffers.instances, 0, this.packed.recordBytes);
      q.writeBuffer(buffers.vertices, 0, this.packed.vertices.buffer, this.packed.vertices.byteOffset, this.packed.vertices.byteLength);
      q.writeBuffer(buffers.indices, 0, this.packed.indices.buffer, this.packed.indices.byteOffset, this.packed.indices.byteLength);
      q.writeBuffer(buffers.order, 0, this.packed.order.buffer, this.packed.order.byteOffset, this.packed.order.byteLength);
      q.writeBuffer(buffers.rays, 0, packedRays.buffer, packedRays.byteOffset, packedRays.byteLength);
      q.writeBuffer(buffers.overflows, 0, new Uint32Array([0]));
      q.writeBuffer(buffers.uniform, 0, new Uint32Array([rayCount, query.mask >>> 0, 0, 0]));
      const bound = [buffers.nodes, buffers.instances, buffers.vertices, buffers.indices, buffers.order,
        buffers.rays, buffers.hits, buffers.overflows, buffers.uniform];
      const bindGroup = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0),
        entries: bound.map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const encoder = this.device.createCommandEncoder({ label: "ray-trace-tlas-batch" });
      const pass = encoder.beginComputePass({ label: "ray-trace-tlas-batch" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(plan.dispatchX, 1, 1);
      pass.end();
      encoder.copyBufferToBuffer(buffers.hits, 0, buffers.hitReadback, 0, plan.hitBytes);
      encoder.copyBufferToBuffer(buffers.overflows, 0, buffers.overflowReadback, 0, 4);
      this.device.queue.submit([encoder.finish()]);
      const validationError = await this.device.popErrorScope();
      if (validationError) throw new Error(`Two-level ray trace GPU validation failed: ${validationError.message}`);
      const [hitBytes, overflowBytes] = await Promise.all([readBack(buffers.hitReadback), readBack(buffers.overflowReadback)]);
      const rawRecords = unpackTlasHitRecords(hitBytes);
      const stackOverflows = unpackStackOverflows(overflowBytes);
      if (stackOverflows !== 0) {
        throw new Error(`Two-level ray trace stack overflow (capacity ${RAY_TRACE_STACK_CAPACITY}) on ${stackOverflows} ray(s); batch rejected (fail-closed).`);
      }
      const hits: (GpuTlasHit | undefined)[] = new Array(rayCount).fill(undefined);
      for (const record of rawRecords) {
        if (record.index >= rayCount) throw new Error(`Hit record index ${record.index} out of batch range.`);
        if (record.status === HIT_STATUS.hit) {
          if (record.instanceIndex === TLAS_INSTANCE_SENTINEL) {
            throw new Error(`Hit at ray ${record.index} carries sentinel instanceIndex (fail-closed).`);
          }
          hits[record.index] = { t: record.t, primitiveIndex: record.primitiveIndex, instanceIndex: record.instanceIndex };
        } else if (record.status !== HIT_STATUS.miss) {
          throw new Error(`Unknown hit status ${record.status} at ray ${record.index} (fail-closed).`);
        }
      }
      return { hits, stackOverflows, rawRecords };
    } finally {
      for (const buffer of Object.values(buffers)) buffer.destroy();
    }
  }
}

export interface TlasGpuCpuComparison {
  readonly rayCount: number;
  readonly passed: boolean;
  readonly mismatchCount: number;
  readonly maxRelativeTDelta: number;
  readonly firstMismatches: readonly string[];
}

/** 两级 API 级对拍：GPU 批量输出 vs tlas.traceTlasClosest 逐射线比对。mask 必须与批次一致；
 * placements 来自 executor.packed（GPU primitiveIndex 为全局三角下标，经 triangleBase 折算）。 */
export function compareTlasGpuAgainstCpu(tlas: TlasBuildResult, queries: readonly TraceQuery[],
  gpuHits: readonly (GpuTlasHit | undefined)[], placements: readonly TlasBlasPlacement[],
  mask = 0xFFFF_FFFF, relativeTolerance = 1e-5): TlasGpuCpuComparison {
  if (queries.length !== gpuHits.length) throw new Error("GPU/CPU comparison requires equal ray counts.");
  const instanceIndexById = new Map(tlas.instances.map((instance, index) => [instance.id, index]));
  const placementByInstance = new Map(placements.map((placement) => [placement.instanceIndex, placement]));
  const mismatches: string[] = [];
  let mismatchCount = 0;
  let maxRelativeTDelta = 0;
  for (let index = 0; index < queries.length; index++) {
    const cpu = traceTlasClosest(tlas, queries[index]!, mask);
    const gpu = gpuHits[index]!;
    if ((cpu === undefined) !== (gpu === undefined)) {
      mismatchCount++;
      pushTlasMismatch(mismatches, `ray ${index}: hit agreement broken (cpu=${cpu ? cpu.instanceId : "miss"} gpu=${gpu ? gpu.instanceIndex : "miss"})`);
      continue;
    }
    if (cpu === undefined || gpu === undefined) continue;
    const cpuInstanceIndex = instanceIndexById.get(cpu.instanceId);
    const placement = cpuInstanceIndex === undefined ? undefined : placementByInstance.get(cpuInstanceIndex);
    if (placement === undefined || cpuInstanceIndex !== gpu.instanceIndex) {
      mismatchCount++;
      pushTlasMismatch(mismatches, `ray ${index}: instanceIndex cpu=${String(cpuInstanceIndex)} gpu=${gpu.instanceIndex}`);
      continue;
    }
    const cpuGlobalPrim = placement.triangleBase + cpu.primitiveIndex;
    if (cpuGlobalPrim !== gpu.primitiveIndex) {
      mismatchCount++;
      pushTlasMismatch(mismatches, `ray ${index}: primitiveIndex cpu=${cpuGlobalPrim} gpu=${gpu.primitiveIndex}`);
      continue;
    }
    const relative = Math.abs(cpu.t - gpu.t) / Math.max(1, Math.abs(cpu.t), Math.abs(gpu.t));
    maxRelativeTDelta = Math.max(maxRelativeTDelta, relative);
    if (!(relative <= relativeTolerance)) {
      mismatchCount++;
      pushTlasMismatch(mismatches, `ray ${index}: t cpu=${cpu.t} gpu=${gpu.t} relative=${relative}`);
    }
  }
  return { rayCount: queries.length, passed: mismatchCount === 0, mismatchCount, maxRelativeTDelta,
    firstMismatches: mismatches };
}

function pushTlasMismatch(sink: string[], message: string): void {
  if (sink.length < 8) sink.push(message);
}
