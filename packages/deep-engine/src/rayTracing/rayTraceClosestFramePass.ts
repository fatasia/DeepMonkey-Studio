/// <reference types="@webgpu/types" />
/**
 * 反射 closest-hit 帧执行器(GBuffer 内联切片):持久场景缓冲 + 每帧只写 uniform。
 * 与 ShadowRayFramePass 同族合同(场景五缓冲构造期一次上传、增量 TLAS updateTlasRegion、
 * bind group LRU 4、哨兵 COPY_SRC、f16 缺 feature 构造即抛、WGSL 校验失败构造即抛),
 * 差异仅在输出:rgba32float 命中记录纹理([t, normal.xyz],miss=[-1,0,0,0]),
 * STORAGE|COPY_SRC(COPY_SRC 供验收 readback,生产帧循环不读回)。
 */

import { RAY_BACKEND_LIMITS } from "./rayBackendTypes.js";
import { emitRayTraceClosestFrameKernelWgsl, packRayTraceClosestFrameUniform,
  RAY_TRACE_CLOSEST_FRAME_BINDINGS, RAY_TRACE_CLOSEST_FRAME_ENTRY_POINT,
  RAY_TRACE_CLOSEST_FRAME_PARAMS_BYTES, type RayTraceClosestFrameParams } from "./rayTraceClosestFrameKernel.js";
import type { TlasPackedScene } from "./tlasLayout.js";

export const RAY_TRACE_CLOSEST_FRAME_FORMAT: GPUTextureFormat = "rgba32float";
const USAGE_STORAGE = 0x80, USAGE_COPY_DST = 0x8, USAGE_UNIFORM = 0x40, USAGE_COPY_SRC = 0x4;
const HIT_TEXTURE_USAGE = USAGE_STORAGE | USAGE_COPY_DST | USAGE_COPY_SRC;
const MAX_CACHED_BINDINGS = 4;

export interface RayTraceClosestFramePassOptions {
  /** f16 压缩节点档(需 shader-f16 feature;默认 false)。 */
  readonly f16?: boolean;
}

export interface RayTraceClosestFrameInput {
  /** 主帧线性深度(depth_texture_2d 视图;与阴影内核消费的同源)。 */
  readonly depthView: GPUTextureView;
  /** rgba32float storage 纹理视图(内部分辨率;消费端按同一 view 采样/拷出)。 */
  readonly hitView: GPUTextureView;
  readonly width: number;
  readonly height: number;
  /** view→世界的逆变换(列主序 16 f32;与 GBuffer 相机合同一致)。 */
  readonly invViewProjection: readonly [number, number, number, number, number, number, number, number,
    number, number, number, number, number, number, number, number];
  /** 相机世界位置(帧 eye)。 */
  readonly eye: readonly [number, number, number];
  readonly tMax: number;
  /** 自相交偏移(世界单位;调用方按 extent 派生,CPU 参考同式同值)。 */
  readonly bias: number;
  readonly rayMask: number;
}

export interface RayTraceClosestFrameDispatch {
  readonly dispatchX: number;
  readonly dispatchY: number;
}

interface CachedFrameBindings {
  readonly depthView: GPUTextureView;
  readonly hitView: GPUTextureView;
  readonly binding: GPUBindGroup;
}

export class RayTraceClosestFramePass {
  /** packed scene 当前视图(调用方校验 placements/instanceCount 用;增量更新时整体替换)。 */
  packed: TlasPackedScene;
  private readonly pipeline: GPUComputePipeline;
  private readonly validated: Promise<void>;
  private readonly sceneBuffers: GPUBuffer[];
  private readonly stackOverflows: GPUBuffer;
  private readonly uniform: GPUBuffer;
  private frameBindings: CachedFrameBindings[] = [];

  constructor(private readonly device: GPUDevice, packed: TlasPackedScene, options: RayTraceClosestFramePassOptions = {}) {
    this.packed = packed;
    if (options.f16 === true && !device.features.has("shader-f16")) {
      throw new Error("RayTraceClosestFramePass f16 variant requires the shader-f16 adapter feature.");
    }
    if (packed.instanceCount > RAY_BACKEND_LIMITS.maxInstances) {
      throw new Error(`RayTraceClosestFramePass: exceeds maxInstances (${RAY_BACKEND_LIMITS.maxInstances}).`);
    }
    device.pushErrorScope("validation");
    this.pipeline = device.createComputePipeline({ label: "ray-trace-closest-frame", layout: "auto",
      compute: { module: device.createShaderModule({ label: "ray-trace-closest-frame",
        code: emitRayTraceClosestFrameKernelWgsl({ f16: options.f16 === true }) }),
        entryPoint: RAY_TRACE_CLOSEST_FRAME_ENTRY_POINT } });
    this.validated = device.popErrorScope().then((error) => {
      if (error) throw new Error(`Reflection closest-hit frame WGSL validation failed: ${error.message}`);
    });
    const storage = USAGE_STORAGE | USAGE_COPY_DST;
    const make = (label: string, size: number, extraUsage = 0): GPUBuffer =>
      device.createBuffer({ label, size, usage: storage | extraUsage });
    // 场景缓冲持久驻留:构造期一次上传,帧循环只写 uniform 与哨兵清零(阴影内核同族)。
    const nodes = make("closest-frame-nodes", Math.max(4, packed.nodeBytes.byteLength));
    const instances = make("closest-frame-instances", Math.max(128, packed.recordBytes.byteLength));
    const vertices = make("closest-frame-vertices", Math.max(4, packed.vertices.byteLength));
    const indices = make("closest-frame-indices", Math.max(4, packed.indices.byteLength));
    const order = make("closest-frame-order", Math.max(4, packed.order.byteLength));
    device.queue.writeBuffer(nodes, 0, packed.nodeBytes);
    device.queue.writeBuffer(instances, 0, packed.recordBytes);
    device.queue.writeBuffer(vertices, 0, packed.vertices.buffer, packed.vertices.byteOffset, packed.vertices.byteLength);
    device.queue.writeBuffer(indices, 0, packed.indices.buffer, packed.indices.byteOffset, packed.indices.byteLength);
    device.queue.writeBuffer(order, 0, packed.order.buffer, packed.order.byteOffset, packed.order.byteLength);
    this.sceneBuffers = [nodes, instances, vertices, indices, order];
    this.stackOverflows = make("closest-frame-overflows", 4, USAGE_COPY_SRC);
    this.uniform = device.createBuffer({ label: "closest-frame-params", size: RAY_TRACE_CLOSEST_FRAME_PARAMS_BYTES,
      usage: USAGE_UNIFORM | USAGE_COPY_DST });
  }

  /** 增量 TLAS 接线:实例记录/TLAS 节点段重写(BLAS 段与顶点/索引驻留不动)。 */
  updateTlasRegion(packed: TlasPackedScene): void {
    if (packed.blasNodeCount !== this.packed.blasNodeCount || packed.triangleCount !== this.packed.triangleCount) {
      throw new Error("updateTlasRegion requires unchanged BLAS segments (build a new pass instead).");
    }
    this.packed = packed;
    const [nodes, instances] = this.sceneBuffers;
    this.device.queue.writeBuffer(nodes!, 0, packed.nodeBytes);
    this.device.queue.writeBuffer(instances!, 0, packed.recordBytes);
  }

  /**
   * 帧内联 dispatch:清零哨兵 → 写 112B uniform → 单 compute pass 写命中记录纹理。
   * 返回 dispatch 形状供 passTiming/验证;提交由调用方 encoder 统一 finish。
   */
  async encode(encoder: GPUCommandEncoder, input: RayTraceClosestFrameInput): Promise<RayTraceClosestFrameDispatch> {
    await this.validated;
    if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width <= 0 || input.height <= 0) {
      throw new Error("RayTraceClosestFramePass requires positive integer hit-record dimensions.");
    }
    if (![input.tMax, input.bias, ...input.eye, ...input.invViewProjection].every(Number.isFinite)) {
      throw new Error("RayTraceClosestFramePass requires finite eye/tMax/bias/invViewProjection.");
    }
    this.device.queue.writeBuffer(this.stackOverflows, 0, new Uint32Array([0]));
    const params: RayTraceClosestFrameParams = { invViewProjection: input.invViewProjection, eye: input.eye,
      tMax: input.tMax, bias: input.bias, rayMask: input.rayMask, width: input.width, height: input.height };
    this.device.queue.writeBuffer(this.uniform, 0, packRayTraceClosestFrameUniform(params));
    const binding = this.frameBindingsFor(input.depthView, input.hitView);
    const pass = encoder.beginComputePass({ label: "ray-trace-closest-frame" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, binding);
    const dispatchX = Math.ceil(input.width / 8);
    const dispatchY = Math.ceil(input.height / 8);
    pass.dispatchWorkgroups(dispatchX, dispatchY, 1);
    pass.end();
    return { dispatchX, dispatchY };
  }

  /** 验收/探针通道:读回栈溢出哨兵(生产帧循环不调;调用方自行 mapAsync)。 */
  readbackStackOverflows(encoder: GPUCommandEncoder, readback: GPUBuffer): void {
    encoder.copyBufferToBuffer(this.stackOverflows, 0, readback, 0, 4);
  }

  destroy(): void {
    for (const buffer of [...this.sceneBuffers, this.stackOverflows, this.uniform]) buffer.destroy();
    this.frameBindings = [];
  }

  private frameBindingsFor(depthView: GPUTextureView, hitView: GPUTextureView): GPUBindGroup {
    const cached = this.frameBindings.find((entry) => entry.depthView === depthView && entry.hitView === hitView);
    if (cached) return cached.binding;
    const entries: GPUBindGroupEntry[] = [
      ...this.sceneBuffers.map((buffer, index) => ({ binding: index, resource: { buffer } })),
      { binding: 5, resource: depthView },
      { binding: 6, resource: { buffer: this.uniform } },
      { binding: 7, resource: hitView },
      { binding: 8, resource: { buffer: this.stackOverflows } },
    ];
    // binding 合同核验(9 槽,构造期一次性;防 kernel/执行器漂移)。
    if (entries.length !== RAY_TRACE_CLOSEST_FRAME_BINDINGS.length) {
      throw new Error(`RayTraceClosestFramePass bind group expects ${RAY_TRACE_CLOSEST_FRAME_BINDINGS.length} entries.`);
    }
    const binding = this.device.createBindGroup({ label: "ray-trace-closest-frame",
      layout: this.pipeline.getBindGroupLayout(0), entries });
    this.frameBindings.push({ depthView, hitView, binding });
    if (this.frameBindings.length > MAX_CACHED_BINDINGS) this.frameBindings.shift();
    return binding;
  }
}
