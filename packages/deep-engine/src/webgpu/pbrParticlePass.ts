/// <reference types="@webgpu/types" />
/**
 * GPU 粒子渲染 pass（A4 接线切片）：把 `GpuParticleRuntime` 的模拟输出（compacted
 * particle buffer + indirect 绘制参数）真正画进 HDR 目标。
 *
 * == 现状核查（2026-09-22，按强制纪律） ==
 * 粒子**模拟与间接绘制**已完整存在：`gpuParticleRuntime.ts`（298 行，双缓冲 compacted
 * 发布 + indirect DCIR）、`gpuParticleWgsl.ts`（compute + `GPU_PARTICLE_RENDER_WGSL`
 * billboard 顶点/片元）、`gpuParticleEmitters.ts`（199 行，alarm-pulse / expanding-ring /
 * flow-line / 预设）、`gpuParticleBurstStage.ts`（爆发事件）。但**渲染管线零消费方**——
 * 全仓只有 lab probe 构造运行时，产品渲染循环从未画过粒子。本模块补这一条接线，
 * 不重建任何模拟逻辑。
 *
 * == 契约 ==
 * - 顶点着色器读 `array<Particle>`（storage，binding 0 @group 0）与相机 uniform
 *   （binding 0 @group 1，96B：viewProjection + cameraRight + cameraUp）；
 * - 绘制走 `drawIndirect`，实例数由模拟阶段的原子计数写出，CPU 不读回；
 * - 混合：预乘 alpha（着色器输出 `rgb*alpha, alpha`），src=one / dst=one-minus-src-alpha；
 *   深度测试开、深度写入关（粒子在透明物体之后、后处理之前绘制）；
 * - 无粒子（indirect 计数 0）时 GPU 自然绘制 0 个实例，CPU 零分支；
 * - 目标格式随 HDR 目标（`rgba16float`）。
 */

import { runResourceCleanup } from "./resourceCleanup.js";
import type { DeviceSession } from "./deviceSession.js";
import { GPU_PARTICLE_CAMERA_UNIFORM_BYTES, GPU_PARTICLE_INDIRECT_BYTES } from "./gpuParticleTypes.js";
import type { GpuParticleRenderBinding } from "./gpuParticleRuntime.js";
import { GPU_PARTICLE_RENDER_WGSL } from "./gpuParticleWgsl.js";

export interface ParticlePassCamera {
  /** 列主序 4x4 视图投影矩阵（与引擎相机一致）。 */
  readonly viewProjection: readonly number[];
  readonly cameraRight: readonly [number, number, number];
  readonly cameraUp: readonly [number, number, number];
}

export interface ParticlePassDrawInput {
  readonly encoder: GPUCommandEncoder;
  readonly colorView: GPUTextureView;
  readonly depthView: GPUTextureView;
  readonly width: number;
  readonly height: number;
  readonly camera: ParticlePassCamera;
  readonly binding: GpuParticleRenderBinding;
}

/** 持有粒子渲染管线；模拟运行时独占粒子缓冲。 */
export class PbrParticlePass {
  private readonly pipeline: GPURenderPipeline;
  private readonly frameLayout: GPUBindGroupLayout;
  private readonly camera: GPUBuffer;
  private readonly cameraData = new Float32Array(GPU_PARTICLE_CAMERA_UNIFORM_BYTES / 4);
  private disposed = false;

  constructor(private readonly session: DeviceSession, colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat) {
    if (session.state !== "ready") throw new Error("GPU session is not ready for the particle pass.");
    const device = session.device;
    const module = device.createShaderModule({ label: "Deep particle render shader",
      code: GPU_PARTICLE_RENDER_WGSL });
    this.frameLayout = device.createBindGroupLayout({ label: "Deep particle frame layout", entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ] });
    const cameraLayout = device.createBindGroupLayout({ label: "Deep particle camera layout", entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
    ] });
    this.pipeline = device.createRenderPipeline({ label: "Deep particle render pipeline",
      layout: device.createPipelineLayout({ label: "Deep particle pipeline layout",
        bindGroupLayouts: [this.frameLayout, cameraLayout] }),
      vertex: { module, entryPoint: "particleVertex" },
      fragment: { module, entryPoint: "particleFragment", targets: [{
        format: colorFormat,
        // 预乘 alpha，与着色器输出的 rgb*alpha 保持一致。
        blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } },
      }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      // 开启深度测试（粒子会被几何遮挡），关闭深度写入（粒子需要混合）。
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: "less-equal" },
    });
    this.camera = device.createBuffer({ label: "Deep particle camera uniform",
      size: GPU_PARTICLE_CAMERA_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** 将一次间接粒子绘制编码到调用方的帧编码器。 */
  encode(input: ParticlePassDrawInput): void {
    if (this.disposed) throw new Error("Particle pass is disposed.");
    const device = this.session.device;
    if (!Number.isSafeInteger(input.width) || input.width < 1
      || !Number.isSafeInteger(input.height) || input.height < 1) {
      throw new RangeError("Particle pass extent must be positive integers.");
    }
    this.cameraData.set(input.camera.viewProjection.slice(0, 16), 0);
    this.cameraData.set([...input.camera.cameraRight, 0], 16);
    this.cameraData.set([...input.camera.cameraUp, 0], 20);
    device.queue.writeBuffer(this.camera, 0, this.cameraData);
    const frameBindings = device.createBindGroup({ label: "Deep particle frame bindings",
      layout: this.frameLayout, entries: [{ binding: 0, resource: { buffer: input.binding.stateBuffer } }] });
    const cameraBindings = device.createBindGroup({ label: "Deep particle camera bindings",
      layout: this.pipeline.getBindGroupLayout(1), entries: [{ binding: 0, resource: { buffer: this.camera } }] });
    const pass = input.encoder.beginRenderPass({ label: "Deep particles", colorAttachments: [{
      view: input.colorView, loadOp: "load", storeOp: "store" }],
      depthStencilAttachment: { view: input.depthView, depthLoadOp: "load", depthStoreOp: "store" } });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, frameBindings);
    pass.setBindGroup(1, cameraBindings);
    // 间接参数（顶点数、实例数、首顶点、首实例）由模拟阶段的 DCIR 写入；
    // CPU 永远不回读实例数量。
    pass.drawIndirect(input.binding.indirectBuffer, 0);
    pass.end();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    runResourceCleanup("Particle pass disposal failed.", [() => this.camera.destroy()]);
  }
}

export const PARTICLE_PASS_INDIRECT_BYTES = GPU_PARTICLE_INDIRECT_BYTES;
