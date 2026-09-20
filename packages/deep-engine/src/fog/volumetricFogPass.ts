/// <reference types="@webgpu/types" />
import { createAdmittedBuffer, createAdmittedTexture } from "../webgpu/resourceAdmission.js";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import type { PbrTransientTextureHandle, PbrTransientTexturePool } from "../webgpu/pbrTransientTexturePool.js";
import { VOLUMETRIC_FOG_MARCH_WGSL, VOLUMETRIC_FOG_WORKGROUP_SIZE } from "./volumetricFogPassWgsl.js";
import { validateVolumetricFogOptions, volumetricFogHalfSize } from "./volumetricFogPassCpu.js";
import { VOLUMETRIC_FOG_DEPTH_FORMAT, VOLUMETRIC_FOG_SCATTER_FORMAT,
  type VolumetricFogPassOptions, type VolumetricFogPassResult, type VolumetricFogSource } from "./volumetricFogPassTypes.js";

const PARAMETER_BYTES = 96;
interface Allocation {
  readonly width: number; readonly height: number;
  readonly sourceWidth: number; readonly sourceHeight: number;
  readonly scatter: GPUTexture; readonly scatterView: GPUTextureView;
  readonly parameters: GPUBuffer;
}
interface Cache extends Allocation {
  readonly source: VolumetricFogSource; readonly options: VolumetricFogPassOptions;
  readonly binding: GPUBindGroup;
}
interface Request { readonly sourceWidth: number; readonly sourceHeight: number; readonly scatterWidth: number; readonly scatterHeight: number }
interface PooledBinding {
  readonly scatter: GPUTexture; readonly depth: GPUTexture;
  readonly binding: GPUBindGroup;
}

/**
 * G7 体积雾半分辨率 GPU ray-march(切片一):单 compute pass,输出 rgba16float
 * (rgb=散射入射亮度,a=透过率),供后续切片合成进场景色。未接入渲染链前可独立 encode。
 * API 形状与 AmbientOcclusionPass/ScreenSpaceReflectionPass 同族:encode/dispose、
 * 池化与非池缓存双路径、revision 守卫、失败回滚、设备失败关闭(fail closed)。
 */
export class VolumetricFogPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private cache: Cache | undefined; private disposed = false;
  private pooledParameters: GPUBuffer | undefined; private pooledEpoch = -1; private pooledBindings: PooledBinding[] = [];
  private pooledSource: VolumetricFogSource | undefined;

  constructor(private readonly session: DeviceSession, private readonly pool?: PbrTransientTexturePool) {
    this.assertReady(); const device = session.device;
    const module = device.createShaderModule({ label: "Deep volumetric fog march WGSL", code: VOLUMETRIC_FOG_MARCH_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep volumetric fog layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: PARAMETER_BYTES } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: VOLUMETRIC_FOG_SCATTER_FORMAT } },
    ] });
    this.pipeline = device.createComputePipeline({ label: "Deep volumetric fog half-resolution march pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "marchVolumetricFog" } });
  }

  encode(encoder: GPUCommandEncoder, source: VolumetricFogSource,
    options: VolumetricFogPassOptions): VolumetricFogPassResult {
    this.assertUsable(); const request = validateRequest(this.session.device, source, options);
    if (this.pool) return this.encodePooled(encoder, source, options, request);
    const previous = this.cache;
    if (previous && source.revision < previous.source.revision) throw new Error("Stale volumetric fog source revision.");
    if (previous && source.revision === previous.source.revision && source.depth !== previous.source.depth) {
      throw new Error("Volumetric fog source textures changed without a revision.");
    }
    if (previous && sameSource(previous.source, source) && sameOptions(previous.options, options)) {
      return this.result(previous, false, source.revision);
    }
    const reusable = previous && previous.sourceWidth === request.sourceWidth && previous.sourceHeight === request.sourceHeight;
    let candidate: Allocation | undefined;
    try {
      candidate = reusable ? previous : this.allocate(request.sourceWidth, request.sourceHeight, request.scatterWidth, request.scatterHeight);
      const binding = reusable && source.depth === previous.source.depth
        ? previous.binding
        : this.bind(candidate, source);
      this.session.device.queue.writeBuffer(candidate.parameters, 0, packParameters(request, options));
      this.encodePass(encoder, candidate, binding);
      const next: Cache = { ...candidate, source, options: Object.freeze({ ...options }), binding };
      this.cache = next; if (previous && previous.scatter !== next.scatter) this.release(previous);
      return this.result(next, true, source.revision);
    } catch (error) { if (candidate && candidate !== previous) this.release(candidate); throw error; }
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    if (this.cache) this.release(this.cache); this.cache = undefined;
    if (this.pooledParameters) this.session.release(this.pooledParameters); this.pooledParameters = undefined;
    this.pooledBindings = []; this.pooledSource = undefined;
  }

  private encodePooled(encoder: GPUCommandEncoder, source: VolumetricFogSource,
    options: VolumetricFogPassOptions, request: Request): VolumetricFogPassResult {
    if (!this.pool!.frameOpen) throw new Error("Volumetric fog transient textures require an open frame scope.");
    const previous = this.pooledSource;
    if (previous && source.revision < previous.revision) throw new Error("Stale volumetric fog source revision.");
    if (previous && source.revision === previous.revision && source.depth !== previous.depth) {
      throw new Error("Volumetric fog source textures changed without a revision.");
    }
    if (this.pooledEpoch !== this.pool!.epoch) { this.pooledEpoch = this.pool!.epoch; this.pooledBindings = []; }
    const handles: PbrTransientTextureHandle[] = [];
    const acquire = this.pool!.acquire.bind(this.pool!);
    try {
      const scatter = acquire({ resourceId: "volumetric-fog-scatter", width: request.scatterWidth, height: request.scatterHeight,
        sampleCount: 1, format: VOLUMETRIC_FOG_SCATTER_FORMAT,
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
      handles.push(scatter);
      const allocation: Allocation = { width: request.scatterWidth, height: request.scatterHeight,
        sourceWidth: request.sourceWidth, sourceHeight: request.sourceHeight,
        scatter: scatter.texture, scatterView: scatter.view, parameters: this.parameters() };
      let pooled = this.pooledBindings.find(item => item.scatter === scatter.texture && item.depth === source.depth);
      if (!pooled) {
        pooled = { scatter: scatter.texture, depth: source.depth, binding: this.bind(allocation, source) };
        this.pooledBindings.push(pooled); if (this.pooledBindings.length > 4) this.pooledBindings.shift();
      }
      this.session.device.queue.writeBuffer(allocation.parameters, 0, packParameters(request, options));
      this.encodePass(encoder, allocation, pooled.binding); this.pooledSource = source;
      return this.result(allocation, true, source.revision);
    } finally { for (const handle of handles) this.pool!.release(handle); }
  }

  private parameters(): GPUBuffer {
    return this.pooledParameters ??= createAdmittedBuffer(this.session, { label: "Deep volumetric fog transient parameters",
      size: PARAMETER_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  private allocate(sourceWidth: number, sourceHeight: number, scatterWidth: number, scatterHeight: number): Allocation {
    const textures: GPUTexture[] = [];
    let parameters: GPUBuffer | undefined;
    try {
      const scatter = createAdmittedTexture(this.session, { label: "Deep volumetric fog half-resolution scatter",
        size: { width: scatterWidth, height: scatterHeight, depthOrArrayLayers: 1 }, dimension: "2d",
        format: VOLUMETRIC_FOG_SCATTER_FORMAT, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
      textures.push(scatter);
      parameters = createAdmittedBuffer(this.session, { label: "Deep volumetric fog parameters",
        size: PARAMETER_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      return { width: scatterWidth, height: scatterHeight, sourceWidth, sourceHeight,
        scatter, scatterView: scatter.createView(), parameters };
    } catch (error) {
      if (parameters) this.session.release(parameters); for (const value of textures) this.session.release(value); throw error;
    }
  }

  private bind(allocation: Allocation, source: VolumetricFogSource): GPUBindGroup {
    const device = this.session.device;
    const depth = source.depth.createView({ format: VOLUMETRIC_FOG_DEPTH_FORMAT, dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 });
    return device.createBindGroup({ label: "Deep volumetric fog bindings", layout: this.layout, entries: [
      { binding: 0, resource: depth },
      { binding: 1, resource: { buffer: allocation.parameters } },
      { binding: 2, resource: allocation.scatterView },
    ] });
  }

  private encodePass(encoder: GPUCommandEncoder, allocation: Allocation, binding: GPUBindGroup): void {
    const x = Math.ceil(allocation.width / VOLUMETRIC_FOG_WORKGROUP_SIZE), y = Math.ceil(allocation.height / VOLUMETRIC_FOG_WORKGROUP_SIZE);
    const pass = encoder.beginComputePass({ label: "Deep volumetric fog march" });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, binding);
    pass.dispatchWorkgroups(x, y); pass.end();
  }

  private release(allocation: Allocation): void {
    this.session.release(allocation.parameters); this.session.release(allocation.scatter);
  }
  private result(cache: Allocation, updated: boolean, revision: number): VolumetricFogPassResult {
    return Object.freeze({ texture: cache.scatter, format: VOLUMETRIC_FOG_SCATTER_FORMAT, width: cache.width,
      height: cache.height, sourceWidth: cache.sourceWidth, sourceHeight: cache.sourceHeight,
      revision, updated, passCount: 1 });
  }
  private assertReady(): void { if (this.session.state !== "ready") throw new Error("GPU session is not ready for volumetric fog."); }
  private assertUsable(): void {
    if (this.disposed) throw new Error("Volumetric fog pass is disposed.");
    if (this.session.state !== "ready") { if (this.cache) this.release(this.cache); this.cache = undefined;
      throw new Error("GPU session is not ready for volumetric fog."); }
  }
}

function validateRequest(device: GPUDevice, source: VolumetricFogSource, options: VolumetricFogPassOptions): Request {
  if (source.depthEncoding !== "linear-view-depth-positive") {
    throw new Error("Volumetric fog requires explicit positive linear view depth; standard/reversed device depth must be linearized first.");
  }
  if (!Number.isSafeInteger(source.revision) || source.revision < 0) throw new Error("Volumetric fog source revision must be a nonnegative safe integer.");
  validateTexture(source.depth, "depth");
  if (source.depth.width > device.limits.maxTextureDimension2D || source.depth.height > device.limits.maxTextureDimension2D) {
    throw new Error("Volumetric fog source dimensions exceed device limits.");
  }
  validateVolumetricFogOptions(options);
  const [scatterWidth, scatterHeight] = volumetricFogHalfSize(source.depth.width, source.depth.height);
  if (Math.ceil(scatterWidth / VOLUMETRIC_FOG_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension
    || Math.ceil(scatterHeight / VOLUMETRIC_FOG_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension) {
    throw new Error("Volumetric fog dispatch exceeds device workgroup limits.");
  }
  return { sourceWidth: source.depth.width, sourceHeight: source.depth.height, scatterWidth, scatterHeight };
}
function validateTexture(texture: GPUTexture, name: string): void {
  if (texture.format !== VOLUMETRIC_FOG_DEPTH_FORMAT) throw new Error(`Volumetric fog ${name} format must be ${VOLUMETRIC_FOG_DEPTH_FORMAT}.`);
  if (texture.dimension !== "2d" || texture.depthOrArrayLayers !== 1 || texture.sampleCount !== 1) {
    throw new Error(`Volumetric fog ${name} must be a non-multisampled single-layer 2D texture.`);
  }
  if ((texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0) throw new Error(`Volumetric fog ${name} requires TEXTURE_BINDING usage.`);
  if (!Number.isInteger(texture.width) || !Number.isInteger(texture.height) || texture.width < 1 || texture.height < 1) {
    throw new Error(`Volumetric fog ${name} dimensions must be positive integers.`);
  }
}
function packParameters(request: Request, options: VolumetricFogPassOptions): ArrayBuffer {
  const buffer = new ArrayBuffer(PARAMETER_BYTES), uints = new Uint32Array(buffer), floats = new Float32Array(buffer);
  uints.set([request.sourceWidth, request.sourceHeight], 0);
  uints.set([request.scatterWidth, request.scatterHeight], 2);
  floats.set([Math.tan(options.verticalFovRadians * 0.5), request.sourceWidth / request.sourceHeight], 4);
  floats.set([options.medium.baseExtinction, options.medium.scaleHeight, options.medium.anisotropy, options.medium.albedo], 8);
  const [ldx, ldy, ldz] = options.light.direction;
  floats.set([ldx ?? 0, ldy ?? 0, ldz ?? 0, options.maxDistance], 12);
  const [lr, lg, lb] = options.light.radiance;
  floats.set([lr ?? 0, lg ?? 0, lb ?? 0], 16);
  uints.set([options.steps], 20);
  return buffer;
}
function sameSource(left: VolumetricFogSource, right: VolumetricFogSource): boolean {
  return left.revision === right.revision && left.depth === right.depth;
}
function sameOptions(left: VolumetricFogPassOptions, right: VolumetricFogPassOptions): boolean {
  return left.verticalFovRadians === right.verticalFovRadians && left.steps === right.steps
    && left.maxDistance === right.maxDistance
    && left.medium.baseExtinction === right.medium.baseExtinction && left.medium.scaleHeight === right.medium.scaleHeight
    && left.medium.anisotropy === right.medium.anisotropy && left.medium.albedo === right.medium.albedo
    && left.light.direction[0] === right.light.direction[0] && left.light.direction[1] === right.light.direction[1]
    && left.light.direction[2] === right.light.direction[2]
    && left.light.radiance[0] === right.light.radiance[0] && left.light.radiance[1] === right.light.radiance[1]
    && left.light.radiance[2] === right.light.radiance[2];
}
