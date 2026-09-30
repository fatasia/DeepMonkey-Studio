import type { DeviceSession } from "./deviceSession.js";
import { GAUSSIAN_SPLAT_QUADS_WGSL } from "../gaussianSplat/splatQuadsWgsl.js";
import { SPLAT_UNIFORM_BYTE_LENGTH } from "../gaussianSplat/splatGpuResources.js";

/** Immutable PSO; records/order/frame buffers belong to the scene owner. */
export class GaussianSplatPass {
  readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPURenderPipeline;
  private readonly device: GPUDevice;
  constructor(private readonly session: DeviceSession, color: GPUTextureFormat, depth: GPUTextureFormat,
    private readonly reactive: boolean) {
    const device = session.device; this.device = device;
    this.layout = device.createBindGroupLayout({ label: "Deep Gaussian splat layout", entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform", minBindingSize: SPLAT_UNIFORM_BYTE_LENGTH } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ] });
    const module = device.createShaderModule({ label: "Deep Gaussian splat EWA", code: GAUSSIAN_SPLAT_QUADS_WGSL });
    const targets: GPUColorTargetState[] = [{ format: color, blend: {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } }];
    if (reactive) targets.push({ format: "r8unorm", blend: {
      color: { srcFactor: "one", dstFactor: "one", operation: "max" },
      alpha: { srcFactor: "one", dstFactor: "one", operation: "max" } } });
    this.pipeline = device.createRenderPipeline({ label: "Deep Gaussian splat pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: "vsMain" }, fragment: { module,
        entryPoint: reactive ? "fsMainReactive" : "fsMain", targets },
      primitive: { topology: "triangle-strip", cullMode: "none" },
      depthStencil: { format: depth, depthWriteEnabled: false, depthCompare: "less-equal" } });
  }
  encode(encoder: GPUCommandEncoder, color: GPUTextureView, depth: GPUTextureView, group: GPUBindGroup,
    count: number, reactiveView?: GPUTextureView, clearReactive = true): void {
    if (this.session.device !== this.device || !["ready", "degraded"].includes(this.session.state)) {
      throw new Error("Gaussian splat device epoch is no longer current.");
    }
    if (this.reactive !== (reactiveView !== undefined)) throw new Error("Gaussian splat reactive attachment must match its pipeline.");
    const attachments: GPURenderPassColorAttachment[] = [{ view: color, loadOp: "load", storeOp: "store" }];
    if (reactiveView) attachments.push({ view: reactiveView, loadOp: clearReactive ? "clear" : "load",
      clearValue: [0, 0, 0, 0], storeOp: "store" });
    const pass = encoder.beginRenderPass({ label: "Deep Gaussian splats", colorAttachments: attachments,
      depthStencilAttachment: { view: depth, depthLoadOp: "load", depthStoreOp: "store" } });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, group); pass.draw(4, count); pass.end();
  }
}
