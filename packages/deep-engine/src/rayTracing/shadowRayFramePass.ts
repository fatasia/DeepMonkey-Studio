/// <reference types="@webgpu/types" />
/**
 * 方向光阴影光线帧执行器(GBuffer 内联切片 2/3):持久场景缓冲 + 每帧只写 uniform。
 * 与探针执行器(shadowRayPass)的合同差异:**encode 无 readback、无 mapAsync、
 * 无逐帧缓冲创建**——mask 写 r32float storage 纹理由直接光 pass 原位采样,
 * 帧时经 passTiming marker 采集(探针职责,本执行器不掺测量语义)。
 *
 * == 合同 ==
 * - 场景缓冲(nodes/instances/vertices/indices/order)构造期一次上传;增量 TLAS
 *   `updateTlasRegion` 只重写 nodes/instances 段(BLAS 段与顶点/索引驻留,合同同探针);
 * - f16=true 需 device.features "shader-f16",缺失即构造抛错(fail-closed,不静默降级);
 * - WGSL 编译错误即构造抛错;栈溢出哨兵由共享遍历片段累计,encode 逐帧清零,
 *   生产路径信任片段 fail-closed(溢出像素保守写遮挡),哨兵读回属验收/探针通道
 *   (`readbackStackOverflows`,生产帧循环不调);
 * - bind group 按 (depthView, maskView) 缓存(LRU 4,同 contactShadow 惯例),
 *   纹理尺寸变化走 maskView 更换自然失配重建。
 */

import { RAY_BACKEND_LIMITS } from "./rayBackendTypes.js";
import { emitShadowRayFrameKernelWgsl, packShadowRayFrameUniform, SHADOW_RAY_FRAME_BINDINGS,
  SHADOW_RAY_FRAME_ENTRY_POINT, SHADOW_RAY_FRAME_PARAMS_BYTES, type ShadowRayFrameParams } from "./shadowRayFrameKernel.js";
import type { TlasPackedScene } from "./tlasLayout.js";

const USAGE_STORAGE = 0x80, USAGE_COPY_DST = 0x8, USAGE_UNIFORM = 0x40;
const MAX_CACHED_BINDINGS = 4;

export interface ShadowRayFramePassOptions {
  /** f16 压缩节点档(需 shader-f16 feature;默认 false)。 */
  readonly f16?: boolean;
}

export interface ShadowRayFrameInput {
  /** 主帧线性深度(depth_texture_2d 视图;与直接光 pass 消费的同源)。 */
  readonly depthView: GPUTextureView;
  /** r32float storage 纹理视图(内部分辨率;直接光 pass 按同一 view 采样)。 */
  readonly maskView: GPUTextureView;
  readonly width: number;
  readonly height: number;
  /** view→世界的逆变换(列主序 16 f32;与 GBuffer 相机合同一致)。 */
  readonly invViewProjection: readonly [number, number, number, number, number, number, number, number,
    number, number, number, number, number, number, number, number];
  /** 单位化"指向光"方向(世界空间)。 */
  readonly lightDir: readonly [number, number, number];
  readonly tMax: number;
  readonly rayMask: number;
}

export interface ShadowRayFrameDispatch {
  readonly dispatchX: number;
  readonly dispatchY: number;
}

interface CachedFrameBindings {
  readonly depthView: GPUTextureView;
  readonly maskView: GPUTextureView;
  readonly binding: GPUBindGroup;
}

export class ShadowRayFramePass {
  /** packed scene 当前视图(调用方校验 placements/instanceCount 用;增量更新时整体替换)。 */
  packed: TlasPackedScene;
  private readonly pipeline: GPUComputePipeline;
  private readonly validated: Promise<void>;
  private readonly sceneBuffers: GPUBuffer[];
  private readonly stackOverflows: GPUBuffer;
  private readonly uniform: GPUBuffer;
  private frameBindings: CachedFrameBindings[] = [];

  constructor(private readonly device: GPUDevice, packed: TlasPackedScene, options: ShadowRayFramePassOptions = {}) {
    this.packed = packed;
    if (options.f16 === true && !device.features.has("shader-f16")) {
      throw new Error("ShadowRayFramePass f16 variant requires the shader-f16 adapter feature.");
    }
    if (packed.instanceCount > RAY_BACKEND_LIMITS.maxInstances) {
      throw new Error(`ShadowRayFramePass: exceeds maxInstances (${RAY_BACKEND_LIMITS.maxInstances}).`);
    }
    device.pushErrorScope("validation");
    this.pipeline = device.createComputePipeline({ label: "shadow-ray-mask-frame", layout: "auto",
      compute: { module: device.createShaderModule({ label: "shadow-ray-mask-frame",
        code: emitShadowRayFrameKernelWgsl({ f16: options.f16 === true }) }), entryPoint: SHADOW_RAY_FRAME_ENTRY_POINT } });
    this.validated = device.popErrorScope().then((error) => {
      if (error) throw new Error(`Shadow ray frame WGSL validation failed: ${error.message}`);
    });
    const storage = USAGE_STORAGE | USAGE_COPY_DST;
    const make = (label: string, size: number): GPUBuffer => device.createBuffer({ label, size, usage: storage });
    // 场景缓冲持久驻留:构造期一次上传,帧循环只写 uniform 与哨兵清零。
    const nodes = make("shadow-frame-nodes", Math.max(4, packed.nodeBytes.byteLength));
    const instances = make("shadow-frame-instances", Math.max(128, packed.recordBytes.byteLength));
    const vertices = make("shadow-frame-vertices", Math.max(4, packed.vertices.byteLength));
    const indices = make("shadow-frame-indices", Math.max(4, packed.indices.byteLength));
    const order = make("shadow-frame-order", Math.max(4, packed.order.byteLength));
    device.queue.writeBuffer(nodes, 0, packed.nodeBytes);
    device.queue.writeBuffer(instances, 0, packed.recordBytes);
    device.queue.writeBuffer(vertices, 0, packed.vertices.buffer, packed.vertices.byteOffset, packed.vertices.byteLength);
    device.queue.writeBuffer(indices, 0, packed.indices.buffer, packed.indices.byteOffset, packed.indices.byteLength);
    device.queue.writeBuffer(order, 0, packed.order.buffer, packed.order.byteOffset, packed.order.byteLength);
    this.sceneBuffers = [nodes, instances, vertices, indices, order];
    this.stackOverflows = make("shadow-frame-overflows", 4);
    this.uniform = device.createBuffer({ label: "shadow-frame-params", size: SHADOW_RAY_FRAME_PARAMS_BYTES,
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
   * 帧内联 dispatch:清零哨兵 → 写 96B uniform → 单 compute pass 写 mask 纹理。
   * 返回 dispatch 形状供 passTiming/验证;提交由调用方 encoder 统一 finish。
   */
  async encode(encoder: GPUCommandEncoder, input: ShadowRayFrameInput): Promise<ShadowRayFrameDispatch> {
    await this.validated;
    if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width <= 0 || input.height <= 0) {
      throw new Error("ShadowRayFramePass requires positive integer mask dimensions.");
    }
    if (![input.tMax, ...input.lightDir].every(Number.isFinite) || Math.hypot(...input.lightDir) === 0) {
      throw new Error("ShadowRayFramePass requires a finite nonzero light direction and tMax.");
    }
    this.device.queue.writeBuffer(this.stackOverflows, 0, new Uint32Array([0]));
    const params: ShadowRayFrameParams = { invViewProjection: input.invViewProjection,
      lightDir: input.lightDir, tMax: input.tMax, rayMask: input.rayMask, width: input.width, height: input.height };
    this.device.queue.writeBuffer(this.uniform, 0, packShadowRayFrameUniform(params));
    const binding = this.frameBindingsFor(input.depthView, input.maskView);
    const pass = encoder.beginComputePass({ label: "shadow-ray-mask-frame" });
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

  private frameBindingsFor(depthView: GPUTextureView, maskView: GPUTextureView): GPUBindGroup {
    const cached = this.frameBindings.find((entry) => entry.depthView === depthView && entry.maskView === maskView);
    if (cached) return cached.binding;
    const entries: GPUBindGroupEntry[] = [
      ...this.sceneBuffers.map((buffer, index) => ({ binding: index, resource: { buffer } })),
      { binding: 5, resource: depthView },
      { binding: 6, resource: { buffer: this.uniform } },
      { binding: 7, resource: maskView },
      { binding: 8, resource: { buffer: this.stackOverflows } },
    ];
    // binding 合同核验(9 槽,构造期一次性;防 kernel/执行器漂移)。
    if (entries.length !== SHADOW_RAY_FRAME_BINDINGS.length) {
      throw new Error(`ShadowRayFramePass bind group expects ${SHADOW_RAY_FRAME_BINDINGS.length} entries.`);
    }
    const binding = this.device.createBindGroup({ label: "shadow-ray-mask-frame",
      layout: this.pipeline.getBindGroupLayout(0), entries });
    this.frameBindings.push({ depthView, maskView, binding });
    if (this.frameBindings.length > MAX_CACHED_BINDINGS) this.frameBindings.shift();
    return binding;
  }
}
