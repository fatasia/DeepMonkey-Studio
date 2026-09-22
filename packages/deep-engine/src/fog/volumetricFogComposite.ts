/// <reference types="@webgpu/types" />
import { createAdmittedBuffer, createAdmittedTexture } from "../webgpu/resourceAdmission.js";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import type { PbrTransientTextureHandle, PbrTransientTexturePool } from "../webgpu/pbrTransientTexturePool.js";
import { VOLUMETRIC_FOG_SCATTER_FORMAT } from "./volumetricFogPassTypes.js";
import { VOLUMETRIC_FOG_COMPOSITE_FORMAT, type VolumetricFogCompositeResult,
  type VolumetricFogCompositeSource } from "./volumetricFogCompositeTypes.js";
import { VOLUMETRIC_FOG_COMPOSITE_WGSL, VOLUMETRIC_FOG_COMPOSITE_WORKGROUP_SIZE } from "./volumetricFogCompositeWgsl.js";

const PARAMETER_BYTES = 16;
interface Allocation { readonly width: number; readonly height: number; readonly output: GPUTexture;
  readonly outputView: GPUTextureView; readonly parameters: GPUBuffer }
interface Cache extends Allocation { readonly source: VolumetricFogCompositeSource; readonly binding: GPUBindGroup }
interface PooledBinding { readonly output: GPUTexture; readonly color: GPUTexture; readonly scatter: GPUTexture;
  readonly binding: GPUBindGroup }

/** Full-resolution linear-HDR composite for the half-resolution G7 march result. */
export class VolumetricFogCompositePass {
  private readonly layout: GPUBindGroupLayout; private readonly pipeline: GPUComputePipeline;
  private cache: Cache | undefined; private disposed = false;
  private pooledParameters: GPUBuffer | undefined; private pooledEpoch = -1;
  private pooledBindings: PooledBinding[] = []; private pooledSource: VolumetricFogCompositeSource | undefined;

  constructor(private readonly session: DeviceSession, private readonly pool?: PbrTransientTexturePool) {
    this.assertReady(); const device = session.device;
    const module = device.createShaderModule({ label: "Deep volumetric fog composite WGSL", code: VOLUMETRIC_FOG_COMPOSITE_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep volumetric fog composite layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: PARAMETER_BYTES } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: "write-only", format: VOLUMETRIC_FOG_COMPOSITE_FORMAT } },
    ] });
    this.pipeline = device.createComputePipeline({ label: "Deep volumetric fog HDR composite pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "compositeVolumetricFog" } });
  }

  encode(encoder: GPUCommandEncoder, source: VolumetricFogCompositeSource): VolumetricFogCompositeResult {
    this.assertUsable(); validateRequest(this.session.device, source);
    if (this.pool) return this.encodePooled(encoder, source);
    const previous = this.cache;
    if (previous && source.revision < previous.source.revision) throw new Error("Stale volumetric fog composite revision.");
    if (previous && source.revision === previous.source.revision && !sameSource(previous.source, source)) {
      throw new Error("Volumetric fog composite textures changed without a revision.");
    }
    if (previous && sameSource(previous.source, source)) return this.result(previous, false);
    const reusable = previous && previous.width === source.color.width && previous.height === source.color.height;
    let candidate: Allocation | undefined;
    try {
      candidate = reusable ? previous : this.allocate(source.color.width, source.color.height);
      const binding = reusable && sameBindings(previous.source, source) ? previous.binding : this.bind(candidate, source);
      this.writeParameters(candidate.parameters, source); this.encodePass(encoder, candidate, binding);
      const next: Cache = { ...candidate, source, binding }; this.cache = next;
      if (previous && previous.output !== next.output) this.release(previous);
      return this.result(next, true);
    } catch (error) { if (candidate && candidate !== previous) this.release(candidate); throw error; }
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    if (this.cache) this.release(this.cache); this.cache = undefined;
    if (this.pooledParameters) this.session.release(this.pooledParameters); this.pooledParameters = undefined;
    this.pooledBindings = []; this.pooledSource = undefined;
  }

  private encodePooled(encoder: GPUCommandEncoder, source: VolumetricFogCompositeSource): VolumetricFogCompositeResult {
    if (!this.pool!.frameOpen) throw new Error("Volumetric fog composite requires an open frame scope.");
    const previous = this.pooledSource;
    if (previous && source.revision < previous.revision) throw new Error("Stale volumetric fog composite revision.");
    if (previous && source.revision === previous.revision && !sameSource(previous, source)) {
      throw new Error("Volumetric fog composite textures changed without a revision.");
    }
    if (this.pooledEpoch !== this.pool!.epoch) { this.pooledEpoch = this.pool!.epoch; this.pooledBindings = []; }
    let handle: PbrTransientTextureHandle | undefined;
    try {
      handle = this.pool!.acquire({ resourceId: "volumetric-fog-hdr", width: source.color.width, height: source.color.height,
        sampleCount: 1, format: VOLUMETRIC_FOG_COMPOSITE_FORMAT,
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
      const allocation: Allocation = { width: source.color.width, height: source.color.height,
        output: handle.texture, outputView: handle.view, parameters: this.parameters() };
      let cached = this.pooledBindings.find(item => item.output === handle!.texture && item.color === source.color
        && item.scatter === source.scatter.texture);
      if (!cached) {
        cached = { output: handle.texture, color: source.color, scatter: source.scatter.texture,
          binding: this.bind(allocation, source) };
        this.pooledBindings.push(cached); if (this.pooledBindings.length > 4) this.pooledBindings.shift();
      }
      this.writeParameters(allocation.parameters, source); this.encodePass(encoder, allocation, cached.binding);
      this.pooledSource = source;
      return Object.freeze({ texture: handle.texture, format: VOLUMETRIC_FOG_COMPOSITE_FORMAT,
        width: allocation.width, height: allocation.height, revision: source.revision, updated: true,
        colorEncoding: "linear-hdr", passCount: 1 });
    } finally { if (handle) this.pool!.release(handle); }
  }

  private parameters(): GPUBuffer {
    return this.pooledParameters ??= createAdmittedBuffer(this.session, { label: "Deep volumetric fog composite parameters",
      size: PARAMETER_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }
  private allocate(width: number, height: number): Allocation {
    let output: GPUTexture | undefined, parameters: GPUBuffer | undefined;
    try {
      output = createAdmittedTexture(this.session, { label: "Deep volumetric fog composite HDR", size: { width, height },
        format: VOLUMETRIC_FOG_COMPOSITE_FORMAT, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
      parameters = createAdmittedBuffer(this.session, { label: "Deep volumetric fog composite parameters",
        size: PARAMETER_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      return { width, height, output, outputView: output.createView(), parameters };
    } catch (error) { if (parameters) this.session.release(parameters); if (output) this.session.release(output); throw error; }
  }
  private bind(allocation: Allocation, source: VolumetricFogCompositeSource): GPUBindGroup {
    const device = this.session.device;
    return device.createBindGroup({ label: "Deep volumetric fog composite bindings", layout: this.layout, entries: [
      { binding: 0, resource: source.color.createView() },
      { binding: 1, resource: source.scatter.texture.createView() },
      { binding: 2, resource: device.createSampler({ label: "Deep volumetric fog upsample sampler", magFilter: "linear", minFilter: "linear" }) },
      { binding: 3, resource: { buffer: allocation.parameters } }, { binding: 4, resource: allocation.outputView },
    ] });
  }
  private writeParameters(buffer: GPUBuffer, source: VolumetricFogCompositeSource): void {
    this.session.device.queue.writeBuffer(buffer, 0, new Uint32Array([
      source.color.width, source.color.height, source.scatter.width, source.scatter.height,
    ]));
  }
  private encodePass(encoder: GPUCommandEncoder, allocation: Allocation, binding: GPUBindGroup): void {
    const pass = encoder.beginComputePass({ label: "Deep volumetric fog HDR composite" });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, binding);
    pass.dispatchWorkgroups(Math.ceil(allocation.width / VOLUMETRIC_FOG_COMPOSITE_WORKGROUP_SIZE),
      Math.ceil(allocation.height / VOLUMETRIC_FOG_COMPOSITE_WORKGROUP_SIZE)); pass.end();
  }
  private result(cache: Cache, updated: boolean): VolumetricFogCompositeResult {
    return Object.freeze({ texture: cache.output, format: VOLUMETRIC_FOG_COMPOSITE_FORMAT,
      width: cache.width, height: cache.height, revision: cache.source.revision, updated,
      colorEncoding: "linear-hdr", passCount: 1 });
  }
  private release(allocation: Allocation): void { this.session.release(allocation.parameters); this.session.release(allocation.output); }
  private assertReady(): void { if (this.session.state !== "ready") throw new Error("GPU session is not ready for volumetric fog composite."); }
  private assertUsable(): void {
    if (this.disposed) throw new Error("Volumetric fog composite pass is disposed.");
    if (this.session.state !== "ready") { if (this.cache) this.release(this.cache); this.cache = undefined;
      throw new Error("GPU session is not ready for volumetric fog composite."); }
  }
}

function validateRequest(device: GPUDevice, source: VolumetricFogCompositeSource): void {
  if (source.colorEncoding !== "linear-hdr") throw new Error("Volumetric fog composite requires linear HDR color.");
  if (!Number.isSafeInteger(source.revision) || source.revision < 0 || source.scatter.revision !== source.revision) {
    throw new Error("Volumetric fog composite revision must match its march result.");
  }
  validateTexture(source.color, VOLUMETRIC_FOG_COMPOSITE_FORMAT, "color");
  validateTexture(source.scatter.texture, VOLUMETRIC_FOG_SCATTER_FORMAT, "scatter");
  if (source.scatter.sourceWidth !== source.color.width || source.scatter.sourceHeight !== source.color.height
    || source.scatter.width !== Math.ceil(source.color.width / 2) || source.scatter.height !== Math.ceil(source.color.height / 2)) {
    throw new Error("Volumetric fog composite requires an exact ceil-half march result for the HDR input.");
  }
  if (source.color.width > device.limits.maxTextureDimension2D || source.color.height > device.limits.maxTextureDimension2D
    || Math.ceil(source.color.width / VOLUMETRIC_FOG_COMPOSITE_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension
    || Math.ceil(source.color.height / VOLUMETRIC_FOG_COMPOSITE_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension) {
    throw new Error("Volumetric fog composite dimensions exceed device limits.");
  }
}
function validateTexture(texture: GPUTexture, format: GPUTextureFormat, name: string): void {
  if (texture.format !== format || texture.dimension !== "2d" || texture.depthOrArrayLayers !== 1 || texture.sampleCount !== 1) {
    throw new Error(`Volumetric fog composite ${name} must be a single-sampled ${format} 2D texture.`);
  }
  if ((texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0) throw new Error(`Volumetric fog composite ${name} requires TEXTURE_BINDING usage.`);
}
function sameBindings(left: VolumetricFogCompositeSource, right: VolumetricFogCompositeSource): boolean {
  return left.color === right.color && left.scatter.texture === right.scatter.texture;
}
function sameSource(left: VolumetricFogCompositeSource, right: VolumetricFogCompositeSource): boolean {
  return left.revision === right.revision && sameBindings(left, right);
}
