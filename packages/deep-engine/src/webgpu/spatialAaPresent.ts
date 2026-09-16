import type { DeviceSession } from "./deviceSession.js";
import { SPATIAL_AA_PRESENT_WGSL } from "../postprocess/spatialAaWgsl.js";

interface Target { texture: GPUTexture; view: GPUTextureView; binding: GPUBindGroup }
/** One display-encoded intermediate; allocation/binding is transactional. Overlay is drawn after encode. */
export class SpatialAaPresent {
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private target: Target | undefined;
  private disposed = false;
  constructor(private readonly session: DeviceSession) {
    if (session.format !== "rgba8unorm" && session.format !== "bgra8unorm") throw new Error("Spatial AA requires a non-sRGB 8-bit display target.");
    const device = session.device, module = device.createShaderModule({ label: "Deep spatial AA", code: SPATIAL_AA_PRESENT_WGSL });
    this.pipeline = device.createRenderPipeline({ label: "Deep spatial AA", layout: "auto",
      vertex: { module, entryPoint: "vertexMain" }, fragment: { module, entryPoint: "fragmentMain", targets: [{ format: session.format }] },
      primitive: { topology: "triangle-list" } });
    this.sampler = device.createSampler({ minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
  }
  prepare(width: number, height: number): GPUTextureView {
    this.assertReady();
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width > this.session.device.limits.maxTextureDimension2D || height > this.session.device.limits.maxTextureDimension2D) throw new Error("Invalid spatial AA target dimensions.");
    if (this.target?.texture.width === width && this.target.texture.height === height) return this.target.view;
    const texture = this.session.own(this.session.device.createTexture({ label: "Deep display-encoded AA input",
      size: [width, height], format: this.session.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
    let candidate: Target;
    try {
      const view = texture.createView(), binding = this.session.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: view }, { binding: 1, resource: this.sampler }] });
      candidate = { texture, view, binding };
    } catch (error) { this.session.release(texture); throw error; }
    const old = this.target; this.target = candidate;
    if (old) this.session.release(old.texture);
    return candidate.view;
  }
  encode(encoder: GPUCommandEncoder, present: GPUTextureView, queries?: GPUQuerySet): void {
    this.assertReady();
    if (!this.target) throw new Error("Spatial AA target is not prepared.");
    const pass = encoder.beginRenderPass({ label: "Deep spatial AA presentation",
      ...(queries ? { timestampWrites: { querySet: queries, endOfPassWriteIndex: 1 } } : {}),
      colorAttachments: [{ view: present, loadOp: "clear", storeOp: "store" }] });
    try { pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.target.binding); pass.draw(3); }
    finally { pass.end(); }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const old = this.target; this.target = undefined;
    if (old) this.session.release(old.texture);
  }
  private assertReady(): void {
    if (this.disposed) throw new Error("Spatial AA is disposed.");
    if (this.session.state !== "ready") { this.dispose(); throw new Error("Spatial AA session is not ready."); }
  }
}
