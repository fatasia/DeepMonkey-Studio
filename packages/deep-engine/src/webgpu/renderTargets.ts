import type { DeviceSession } from "./deviceSession.js";
import type { SurfaceSize } from "./surfaceSize.js";

export const PBR_MAIN_SAMPLE_COUNT = 1;
export const PBR_HDR_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;
export const PBR_LINEAR_DEPTH_FORMAT = "r32float" as const satisfies GPUTextureFormat;
// rgba8snorm is not renderable on all WebGPU adapters (notably Vulkan/ANGLE).
// Store view normals in a renderable UNORM target and decode them in GTAO.
export const PBR_VIEW_NORMAL_FORMAT = "rgba8unorm" as const satisfies GPUTextureFormat;
export const PBR_MOTION_FORMAT = "rg16float" as const satisfies GPUTextureFormat;
export const PBR_DEPTH_FORMAT = "depth32float" as const satisfies GPUTextureFormat;
export const PBR_OPAQUE_ATTACHMENT_FORMATS = Object.freeze([
  PBR_HDR_FORMAT, PBR_LINEAR_DEPTH_FORMAT, PBR_VIEW_NORMAL_FORMAT, PBR_MOTION_FORMAT,
] as const);

/** Single-sample, shader-readable main-frame attachments for AO and temporal reconstruction. */
export class RenderTargets {
  private textures: GPUTexture[] = [];
  private dimensions: SurfaceSize | undefined;
  hdrTexture!: GPUTexture; linearDepthTexture!: GPUTexture; normalTexture!: GPUTexture; motionTexture!: GPUTexture; depthTexture!: GPUTexture;
  hdr!: GPUTextureView; linearDepth!: GPUTextureView; normal!: GPUTextureView; motion!: GPUTextureView;
  /** Compatibility alias during the renderer migration; direct rendering uses hdr without resolveTarget. */
  color!: GPUTextureView;
  depth!: GPUTextureView;
  outputBindGroup!: GPUBindGroup;

  constructor(private readonly session: DeviceSession, private readonly layout: GPUBindGroupLayout, private readonly settings: GPUBuffer) {}

  resize(size: SurfaceSize): void {
    if (size.width === this.dimensions?.width && size.height === this.dimensions.height) return;
    const device = this.session.device, created: GPUTexture[] = [];
    const texture = (label: string, format: GPUTextureFormat, usage: GPUTextureUsageFlags): GPUTexture => {
      const value = this.session.own(device.createTexture({ label, size, format, sampleCount: PBR_MAIN_SAMPLE_COUNT, usage }));
      created.push(value); return value;
    };
    try {
      const readable = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      const hdrTexture = texture("Deep HDR color", PBR_HDR_FORMAT, readable);
      const linearDepthTexture = texture("Deep linear view depth", PBR_LINEAR_DEPTH_FORMAT, readable);
      const normalTexture = texture("Deep view normal", PBR_VIEW_NORMAL_FORMAT, readable);
      const motionTexture = texture("Deep current-to-previous motion", PBR_MOTION_FORMAT, readable);
      const depthTexture = texture("Deep hardware depth", PBR_DEPTH_FORMAT,
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
      const hdr = hdrTexture.createView(), linearDepth = linearDepthTexture.createView();
      const normal = normalTexture.createView(), motion = motionTexture.createView(), depth = depthTexture.createView();
      const outputBindGroup = device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: hdr }, { binding: 1, resource: device.createSampler({ minFilter: "linear", magFilter: "linear" }) },
        { binding: 2, resource: { buffer: this.settings } },
      ] });
      const previous = this.textures; this.textures = created;
      this.hdrTexture = hdrTexture; this.linearDepthTexture = linearDepthTexture;
      this.normalTexture = normalTexture; this.motionTexture = motionTexture;
      this.depthTexture = depthTexture;
      this.hdr = hdr; this.color = hdr; this.linearDepth = linearDepth; this.normal = normal; this.motion = motion; this.depth = depth;
      this.outputBindGroup = outputBindGroup; this.dimensions = Object.freeze({ width: size.width, height: size.height });
      for (const value of previous) this.session.release(value);
    } catch (error) {
      for (const value of created) this.session.release(value); throw error;
    }
  }

  dispose(): void {
    for (const texture of this.textures) this.session.release(texture);
    this.textures = []; this.dimensions = undefined;
  }
}
