import type { DeviceSession } from "./deviceSession.js";
import type { PbrTransientTextureHandle, PbrTransientTexturePool,
  PbrTransientTexturePoolStats } from "./pbrTransientTexturePool.js";
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

/** Superset used by full-resolution HDR nodes that may occupy one render-graph alias slot. */
export function pbrFullHdrTransientUsage(): GPUTextureUsageFlags {
  return GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;
}

/** Single-sample, shader-readable main-frame attachments for AO and temporal reconstruction. */
export class RenderTargets {
  private handles: PbrTransientTextureHandle[] = [];
  private dimensions: SurfaceSize | undefined;
  private disposed = false;
  private readonly sampler: GPUSampler;
  hdrTexture!: GPUTexture; linearDepthTexture!: GPUTexture; normalTexture!: GPUTexture; motionTexture!: GPUTexture; depthTexture!: GPUTexture;
  hdr!: GPUTextureView; linearDepth!: GPUTextureView; normal!: GPUTextureView; motion!: GPUTextureView;
  /** Compatibility alias during the renderer migration; direct rendering uses hdr without resolveTarget. */
  color!: GPUTextureView;
  depth!: GPUTextureView;
  outputBindGroup!: GPUBindGroup;

  constructor(private readonly session: DeviceSession, private readonly layout: GPUBindGroupLayout,
    private readonly settings: GPUBuffer, private readonly pool: PbrTransientTexturePool) {
    this.sampler = session.device.createSampler({ minFilter: "linear", magFilter: "linear" });
    void session.device.lost.then(() => this.invalidateDeviceLoss(), () => this.invalidateDeviceLoss());
  }

  get transientStats(): PbrTransientTexturePoolStats { return this.pool.stats; }

  /** Opens the real frame allocation scope. Resources return to the pool only after commitFrame(queue.submit). */
  beginFrame(size: SurfaceSize,
    resourceLifetimes?: readonly import("../renderGraph.js").RenderResourceLifetime[]): void {
    if (this.disposed) throw new Error("PBR render targets are disposed.");
    if (this.handles.length || this.pool.frameOpen) throw new Error("PBR render target frame is already open.");
    const resized = this.dimensions !== undefined
      && (size.width !== this.dimensions.width || size.height !== this.dimensions.height);
    if (resized) this.pool.invalidateAll("surface-resize");
    this.pool.beginFrame(resourceLifetimes ?? []);
    const device = this.session.device;
    const attachmentUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    try {
      const planned = resourceLifetimes === undefined ? undefined : new Set(resourceLifetimes.map(resource => resource.id));
      const needs = (resourceId: string): boolean => planned === undefined || planned.has(resourceId);
      const acquire = (resourceId: string, format: GPUTextureFormat, usage = attachmentUsage) => this.pool.acquire({
        resourceId, format, width: size.width, height: size.height, sampleCount: PBR_MAIN_SAMPLE_COUNT, usage,
      });
      // HDR remains available for the stable output bind group. Optional MRTs follow the compiled live-resource set.
      const hdrHandle = acquire("opaque-hdr", PBR_HDR_FORMAT, pbrFullHdrTransientUsage());
      // linear-depth 额外 COPY_SRC：R12 白名单诊断快照（planned 合同已声明，见 pbrFramePlanResources）。
      const linearDepthHandle = needs("linear-depth")
        ? acquire("linear-depth", PBR_LINEAR_DEPTH_FORMAT, attachmentUsage | GPUTextureUsage.COPY_SRC)
        : undefined;
      const normalHandle = needs("view-normal") ? acquire("view-normal", PBR_VIEW_NORMAL_FORMAT) : undefined;
      const motionHandle = needs("motion") ? acquire("motion", PBR_MOTION_FORMAT) : undefined;
      const depthHandle = acquire("hardware-depth", PBR_DEPTH_FORMAT);
      const handles = [hdrHandle, linearDepthHandle, normalHandle, motionHandle, depthHandle]
        .filter((handle): handle is PbrTransientTextureHandle => handle !== undefined);
      const outputBindGroup = device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: hdrHandle.view }, { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.settings } },
      ] });
      this.handles = handles;
      this.hdrTexture = hdrHandle.texture; this.linearDepthTexture = linearDepthHandle?.texture as GPUTexture;
      this.normalTexture = normalHandle?.texture as GPUTexture; this.motionTexture = motionHandle?.texture as GPUTexture;
      this.depthTexture = depthHandle.texture;
      this.hdr = hdrHandle.view; this.color = this.hdr; this.linearDepth = linearDepthHandle?.view as GPUTextureView;
      this.normal = normalHandle?.view as GPUTextureView; this.motion = motionHandle?.view as GPUTextureView;
      this.depth = depthHandle.view;
      this.outputBindGroup = outputBindGroup; this.dimensions = Object.freeze({ width: size.width, height: size.height });
    } catch (error) {
      this.pool.endFrame(false); throw error;
    }
  }

  commitFrame(): void {
    if (!this.handles.length) throw new Error("PBR render target commit requires an open frame.");
    for (const handle of this.handles) this.pool.release(handle);
    this.handles = []; this.pool.endFrame(true);
  }

  failFrame(): void {
    if (!this.pool.frameOpen) return;
    this.handles = []; this.pool.endFrame(false);
  }

  invalidateDeviceEpoch(): void {
    this.handles = []; this.dimensions = undefined; this.pool.invalidateAll("epoch-advance");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.failFrame(); this.pool.dispose(); this.handles = []; this.dimensions = undefined;
  }

  private invalidateDeviceLoss(): void {
    if (this.disposed) return;
    this.handles = []; this.dimensions = undefined; this.pool.invalidateAll("device-lost");
  }
}
