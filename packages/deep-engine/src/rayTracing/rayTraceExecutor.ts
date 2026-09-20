/// <reference types="@webgpu/types" />
/**
 * RayBackend WGSL 软件执行器（波次4 核心）：上传 BLAS+rays → dispatch → 读回命中。
 * 本切片先支持单 BLAS（TLAS 实例层由 wave 5 接线）；预算与校验沿用 rayBackendTypes 合同
 * （maxBatchRays / maxBlasTriangles 等）。对拍纪律：API 级 compareGpuAgainstCpu 以
 * rayTrace.traceClosest 输出为仲裁基准——命中/缺席逐射线一致，primitiveIndex 精确相等，
 * t 相对容差 1e-5（f32 与 JS f64 舍入差的合同化吸收）。fail-closed：WGSL 编译错误、
 * 栈溢出哨兵非零、未知 status 一律抛错，绝不静默降级。
 * 注：buffer usage/map mode 用数值常量（WebGPU 规范值），保证 node/vitest stub 无
 * WebGPU 全局时同样可执行；GPUDevice 仅为类型依赖。
 */

import { buildTracedScene, traceClosest, type TraceQuery, type TracedScene } from "./rayTrace.js";
import { RAY_BACKEND_LIMITS, validateRayBlas, type RayBlasDescriptor, type RayBatchQuery } from "./rayBackendTypes.js";
import { emitRayTraceKernelWgsl, RAY_TRACE_ENTRY_POINT } from "./rayTraceKernel.js";
import { HIT_STATUS, packRayBatch, RAY_TRACE_STACK_CAPACITY, RAY_TRACE_WORKGROUP_SIZE, serializeBvhNodes, unpackHitRecords, unpackStackOverflows } from "./rayTraceLayout.js";

export interface RayTraceDispatchPlan {
  readonly rayCount: number;
  readonly nodeCount: number;
  readonly dispatchX: number;
  readonly nodeBytes: number;
  readonly rayBytes: number;
  readonly hitBytes: number;
}

/** 纯计划函数（无 GPU 依赖，stub/真机共用）：dispatch 尺寸与全部缓冲字节数。 */
export function planRayTraceDispatch(scene: TracedScene, rayCount: number): RayTraceDispatchPlan {
  return {
    rayCount,
    nodeCount: scene.built.nodes.length,
    dispatchX: Math.ceil(rayCount / RAY_TRACE_WORKGROUP_SIZE),
    nodeBytes: scene.built.nodes.length * 48,
    rayBytes: rayCount * 32,
    hitBytes: rayCount * 16,
  };
}

/** GPU 命中（与 CPU TraceHit 同语义；重心坐标合同恒 0，见 rayTraceLayout 头注释）。 */
export interface GpuTraceHit {
  readonly t: number;
  readonly primitiveIndex: number;
}

export interface RayTraceBatchResult {
  /** miss → undefined（与 traceClosest 合同一致）。 */
  readonly hits: readonly (GpuTraceHit | undefined)[];
  readonly stackOverflows: number;
  /** 读回的原始 HitRecord（诊断/对拍证据用；status 语义见 rayTraceLayout）。 */
  readonly rawRecords: ReturnType<typeof unpackHitRecords>;
}

const USAGE_STORAGE = 0x80, USAGE_COPY_DST = 0x8, USAGE_COPY_SRC = 0x4, USAGE_MAP_READ = 0x1, USAGE_UNIFORM = 0x40;
const MAP_MODE_READ = 0x1;

export class RayTraceGpuExecutor {
  readonly scene: TracedScene;
  /** WGSL 编译验证（error scope）；traceBatch 先 await，编译失败 fail-closed 抛错。 */
  private readonly validated: Promise<void>;
  private readonly module: GPUShaderModule;
  private readonly pipeline: GPUComputePipeline;

  constructor(private readonly device: GPUDevice, blas: RayBlasDescriptor) {
    const invalid = validateRayBlas(blas);
    if (invalid !== undefined) throw new Error(`Cannot create RayTraceGpuExecutor: ${invalid}`);
    this.scene = buildTracedScene(blas);
    device.pushErrorScope("validation");
    this.module = device.createShaderModule({ label: "ray-trace-batch", code: emitRayTraceKernelWgsl() });
    this.pipeline = device.createComputePipeline({ label: "ray-trace-batch", layout: "auto",
      compute: { module: this.module, entryPoint: RAY_TRACE_ENTRY_POINT } });
    this.validated = device.popErrorScope().then((error) => {
      if (error) throw new Error(`Ray trace WGSL validation failed: ${error.message}`);
    });
  }

  /** 批量最近命中；空 BVH/零射线不触 GPU（与 CPU traceClosest 空 BVH 全 miss 一致）。 */
  async traceBatch(query: RayBatchQuery): Promise<RayTraceBatchResult> {
    await this.validated;
    const rayCount = query.tMax.length;
    if (rayCount > RAY_BACKEND_LIMITS.maxBatchRays) {
      throw new Error(`Ray batch exceeds maxBatchRays budget (${RAY_BACKEND_LIMITS.maxBatchRays}).`);
    }
    if (rayCount === 0 || this.scene.built.nodes.length === 0) {
      return { hits: new Array<GpuTraceHit | undefined>(rayCount).fill(undefined), stackOverflows: 0, rawRecords: [] };
    }
    const plan = planRayTraceDispatch(this.scene, rayCount);
    const packedRays = packRayBatch(query);
    const nodeBytes = serializeBvhNodes(this.scene.built);
    const vertices = this.scene.blas.vertices;
    const indices = this.scene.blas.indices;
    const order = Uint32Array.from(this.scene.built.order);
    const make = (label: string, size: number, usage: number): GPUBuffer =>
      this.device.createBuffer({ label, size, usage });
    const storage = USAGE_STORAGE | USAGE_COPY_DST;
    const buffers = {
      nodes: make("rt-nodes", plan.nodeBytes, storage),
      vertices: make("rt-vertices", vertices.byteLength, storage),
      indices: make("rt-indices", indices.byteLength, storage),
      order: make("rt-order", order.byteLength, storage),
      rays: make("rt-rays", plan.rayBytes, storage),
      hits: make("rt-hits", plan.hitBytes, storage | USAGE_COPY_SRC),
      overflows: make("rt-overflows", 4, storage | USAGE_COPY_SRC),
      uniform: make("rt-uniform", 16, USAGE_UNIFORM | USAGE_COPY_DST),
      hitReadback: make("rt-hit-readback", plan.hitBytes, USAGE_COPY_DST | USAGE_MAP_READ),
      overflowReadback: make("rt-overflow-readback", 4, USAGE_COPY_DST | USAGE_MAP_READ),
    };
    try {
      const q = this.device.queue;
      // 同步设备操作段整体包 validation error scope：真机 binding/usage 错误显式抛错，
      // 绝不让失效命令缓冲读回全零被误读成“全 miss”（真机 Dawn 实测过的失败模式）。
      this.device.pushErrorScope("validation");
      // ArrayBuffer 形态 writeBuffer：offset/size 恒为字节（TypedArray 形态按元素计，避免口径歧义）。
      q.writeBuffer(buffers.nodes, 0, nodeBytes);
      q.writeBuffer(buffers.vertices, 0, vertices.buffer, vertices.byteOffset, vertices.byteLength);
      q.writeBuffer(buffers.indices, 0, indices.buffer, indices.byteOffset, indices.byteLength);
      q.writeBuffer(buffers.order, 0, order.buffer, order.byteOffset, order.byteLength);
      q.writeBuffer(buffers.rays, 0, packedRays.buffer, packedRays.byteOffset, packedRays.byteLength);
      q.writeBuffer(buffers.overflows, 0, new Uint32Array([0]));
      q.writeBuffer(buffers.uniform, 0, new Uint32Array([rayCount, order.length / 3, 0, 0]));
      const bound = [buffers.nodes, buffers.vertices, buffers.indices, buffers.order, buffers.rays,
        buffers.hits, buffers.overflows, buffers.uniform];
      const bindGroup = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0),
        entries: bound.map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const encoder = this.device.createCommandEncoder({ label: "ray-trace-batch" });
      const pass = encoder.beginComputePass({ label: "ray-trace-batch" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(plan.dispatchX, 1, 1);
      pass.end();
      encoder.copyBufferToBuffer(buffers.hits, 0, buffers.hitReadback, 0, plan.hitBytes);
      encoder.copyBufferToBuffer(buffers.overflows, 0, buffers.overflowReadback, 0, 4);
      this.device.queue.submit([encoder.finish()]);
      const validationError = await this.device.popErrorScope();
      if (validationError) throw new Error(`Ray trace GPU validation failed: ${validationError.message}`);
      const [hitBytes, overflowBytes] = await Promise.all([readBack(buffers.hitReadback), readBack(buffers.overflowReadback)]);
      const rawRecords = unpackHitRecords(hitBytes);
      const stackOverflows = unpackStackOverflows(overflowBytes);
      if (stackOverflows !== 0) {
        throw new Error(`Ray trace stack overflow (capacity ${RAY_TRACE_STACK_CAPACITY}) on ${stackOverflows} ray(s); batch rejected (fail-closed).`);
      }
      const hits: (GpuTraceHit | undefined)[] = new Array(rayCount).fill(undefined);
      for (const record of unpackHitRecords(hitBytes)) {
        if (record.index >= rayCount) throw new Error(`Hit record index ${record.index} out of batch range.`);
        if (record.status === HIT_STATUS.hit) {
          hits[record.index] = { t: record.t, primitiveIndex: record.primitiveIndex };
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

async function readBack(buffer: GPUBuffer): Promise<ArrayBuffer> {
  await buffer.mapAsync(MAP_MODE_READ);
  try {
    return new Uint8Array(buffer.getMappedRange() as ArrayBuffer).slice().buffer;
  } finally {
    buffer.unmap();
  }
}

export interface GpuCpuComparison {
  readonly rayCount: number;
  readonly passed: boolean;
  readonly mismatchCount: number;
  readonly maxRelativeTDelta: number;
  readonly firstMismatches: readonly string[];
}

/** API 级对拍：GPU 批量输出 vs CPU 参考逐射线比对（primitiveIndex 精确 / t 相对 1e-5）。 */
export function compareGpuAgainstCpu(scene: TracedScene, queries: readonly TraceQuery[],
  gpuHits: readonly (GpuTraceHit | undefined)[], relativeTolerance = 1e-5): GpuCpuComparison {
  if (queries.length !== gpuHits.length) throw new Error("GPU/CPU comparison requires equal ray counts.");
  const mismatches: string[] = [];
  let mismatchCount = 0;
  let maxRelativeTDelta = 0;
  for (let index = 0; index < queries.length; index++) {
    const cpu = traceClosest(scene, queries[index]!);
    const gpu = gpuHits[index]!;
    if ((cpu === undefined) !== (gpu === undefined)) {
      mismatchCount++;
      pushMismatch(mismatches, `ray ${index}: hit agreement broken (cpu=${cpu ? cpu.primitiveIndex : "miss"} gpu=${gpu ? gpu.primitiveIndex : "miss"})`);
      continue;
    }
    if (cpu === undefined || gpu === undefined) continue;
    if (cpu.primitiveIndex !== gpu.primitiveIndex) {
      mismatchCount++;
      pushMismatch(mismatches, `ray ${index}: primitiveIndex cpu=${cpu.primitiveIndex} gpu=${gpu.primitiveIndex}`);
      continue;
    }
    const relative = Math.abs(cpu.t - gpu.t) / Math.max(1, Math.abs(cpu.t), Math.abs(gpu.t));
    maxRelativeTDelta = Math.max(maxRelativeTDelta, relative);
    if (!(relative <= relativeTolerance)) {
      mismatchCount++;
      pushMismatch(mismatches, `ray ${index}: t cpu=${cpu.t} gpu=${gpu.t} relative=${relative}`);
    }
  }
  return { rayCount: queries.length, passed: mismatchCount === 0, mismatchCount, maxRelativeTDelta,
    firstMismatches: mismatches };
}

function pushMismatch(sink: string[], message: string): void {
  if (sink.length < 8) sink.push(message);
}
