/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";
import { runResourceCleanup } from "./resourceCleanup.js";
import {
  type ProbeVolumeSize, WEBGPU_PROBE_VOLUME_FORMAT,
} from "./webgpuProbeCaptureTypes.js";

export interface ProbeVolume extends ProbeVolumeSize {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly levels: readonly GPUTextureView[];
}

/** Bounded pool for transaction-local probe textures and small parameter buffers. */
export class WebGpuProbeCapturePool {
  private readonly volumes: ProbeVolume[] = [];
  private readonly buffers: GPUBuffer[] = [];
  private disposed = false;

  constructor(private readonly session: DeviceSession) {}

  takeVolume(size: ProbeVolumeSize): ProbeVolume {
    this.assertReady();
    const pooled = this.volumes.findIndex(item => item.key === size.key);
    if (pooled >= 0) return this.volumes.splice(pooled, 1)[0]!;
    const texture = this.session.own(this.session.device.createTexture({ label: "Deep GI probe volume",
      size: { width: size.width, height: size.height, depthOrArrayLayers: size.layers }, dimension: "2d",
      mipLevelCount: size.mipCount, format: WEBGPU_PROBE_VOLUME_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC
        | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT }));
    try {
      const levels = Object.freeze(Array.from({ length: size.mipCount }, (_, mip) => texture.createView({
        label: `Deep GI probe volume mip ${mip}`, dimension: "2d-array", baseMipLevel: mip, mipLevelCount: 1,
        baseArrayLayer: 0, arrayLayerCount: size.layers })));
      return { ...size, texture, levels, view: texture.createView({ label: "Deep GI probe sampling volume",
        dimension: "2d-array", baseMipLevel: 0, mipLevelCount: size.mipCount,
        baseArrayLayer: 0, arrayLayerCount: size.layers }) };
    } catch (error) { this.session.release(texture); throw error; }
  }

  takeBuffer(label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer {
    this.assertReady();
    const pooled = this.buffers.findIndex(buffer => buffer.size === size && buffer.usage === usage);
    if (pooled >= 0) return this.buffers.splice(pooled, 1)[0]!;
    return this.session.own(this.session.device.createBuffer({ label, size, usage }));
  }

  recycleVolume(volume: ProbeVolume): void {
    if (this.disposed || this.session.state !== "ready" || this.volumes.length >= 3) {
      this.session.release(volume.texture);
    } else this.volumes.push(volume);
  }
  recycleBuffer(buffer: GPUBuffer): void {
    if (this.disposed || this.session.state !== "ready" || this.buffers.length >= 4) {
      this.session.release(buffer);
    } else this.buffers.push(buffer);
  }

  dispose(extraVolumes: readonly ProbeVolume[] = [], extraBuffers: readonly GPUBuffer[] = []): void {
    if (this.disposed) return;
    this.disposed = true;
    const volumes = [...this.volumes, ...extraVolumes], buffers = [...this.buffers, ...extraBuffers];
    this.volumes.length = 0; this.buffers.length = 0;
    runResourceCleanup("Probe capture resource pool disposal failed.", [
      ...volumes.map(volume => () => this.session.release(volume.texture)),
      ...buffers.map(buffer => () => this.session.release(buffer)),
    ]);
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("Probe capture resource pool is disposed.");
    if (this.session.state !== "ready") throw new Error("GPU session is not ready for probe capture resources.");
  }
}
