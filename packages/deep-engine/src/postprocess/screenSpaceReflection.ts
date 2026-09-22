/// <reference types="@webgpu/types" />
import { createAdmittedBuffer, createAdmittedTexture } from "../webgpu/resourceAdmission.js";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import type { PbrTransientTextureHandle, PbrTransientTexturePool } from "../webgpu/pbrTransientTexturePool.js";
import { SSR_WORKGROUP_SIZE, SSR_TRACE_WGSL, SSR_COMPOSITE_WGSL,
  SSR_RADIANCE_DOWNSAMPLE_WGSL } from "./screenSpaceReflectionWgsl.js";
import { screenSpaceReflectionHalfSize, validateScreenSpaceReflectionOptions } from "./screenSpaceReflectionCpu.js";
import { SSR_COMPOSITE_FORMAT, SSR_DEPTH_FORMAT, SSR_NORMAL_FORMAT, SSR_COLOR_FORMAT, SSR_TRACE_FORMAT,
  type ScreenSpaceReflectionOptions, type ScreenSpaceReflectionResult, type ScreenSpaceReflectionSource } from "./screenSpaceReflectionTypes.js";

const PARAMETER_BYTES = 64;
const MAX_RADIANCE_MIP_LEVELS = 6;
interface Allocation {
  readonly width: number; readonly height: number;
  readonly traceWidth: number; readonly traceHeight: number;
  readonly trace: GPUTexture; readonly output: GPUTexture;
  readonly traceView: GPUTextureView; readonly outputView: GPUTextureView;
  readonly radiance: GPUTexture; readonly radianceMipLevelCount: number;
  readonly radianceBindings: readonly GPUBindGroup[];
  readonly parameters: GPUBuffer;
}
interface Cache extends Allocation {
  readonly source: ScreenSpaceReflectionSource; readonly options: ScreenSpaceReflectionOptions;
  readonly traceBinding: GPUBindGroup; readonly compositeBinding: GPUBindGroup;
}
interface Request { readonly sourceWidth: number; readonly sourceHeight: number; readonly traceWidth: number; readonly traceHeight: number;
  readonly activeRadianceMipLevels: number }
interface PooledBindings {
  readonly trace: GPUTexture; readonly output: GPUTexture;
  readonly color: GPUTexture; readonly depth: GPUTexture; readonly normal: GPUTexture;
  readonly traceBinding: GPUBindGroup; readonly compositeBinding: GPUBindGroup;
  readonly radianceBindings: readonly GPUBindGroup[];
}
interface PooledRadiance {
  readonly width: number; readonly height: number; readonly texture: GPUTexture;
  readonly mipLevelCount: number;
}

/** Half-resolution screen-space ray march + full-resolution composite, ahead of temporal AA. */
export class ScreenSpaceReflectionPass {
  private readonly traceLayout: GPUBindGroupLayout; private readonly compositeLayout: GPUBindGroupLayout;
  private readonly radianceLayout: GPUBindGroupLayout;
  private readonly tracePipeline: GPUComputePipeline; private readonly compositePipeline: GPUComputePipeline;
  private readonly radiancePipeline: GPUComputePipeline;
  private cache: Cache | undefined; private disposed = false;
  private pooledParameters: GPUBuffer | undefined; private pooledEpoch = -1; private pooledBindings: PooledBindings[] = [];
  private pooledSource: ScreenSpaceReflectionSource | undefined;
  private pooledRadiance: PooledRadiance | undefined;

  constructor(private readonly session: DeviceSession, private readonly pool?: PbrTransientTexturePool) {
    this.assertReady(); const device = session.device;
    const traceModule = device.createShaderModule({ label: "Deep screen-space reflection trace WGSL", code: SSR_TRACE_WGSL });
    const compositeModule = device.createShaderModule({ label: "Deep screen-space reflection composite WGSL", code: SSR_COMPOSITE_WGSL });
    const radianceModule = device.createShaderModule({ label: "Deep SSR radiance hierarchy WGSL", code: SSR_RADIANCE_DOWNSAMPLE_WGSL });
    this.radianceLayout = device.createBindGroupLayout({ label: "Deep SSR radiance hierarchy layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: SSR_COLOR_FORMAT } },
    ] });
    this.traceLayout = device.createBindGroupLayout({ label: "Deep SSR trace layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: PARAMETER_BYTES } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: SSR_TRACE_FORMAT } },
    ] });
    this.compositeLayout = device.createBindGroupLayout({ label: "Deep SSR composite layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: PARAMETER_BYTES } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: SSR_COMPOSITE_FORMAT } },
    ] });
    this.tracePipeline = device.createComputePipeline({ label: "Deep SSR half-resolution trace pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.traceLayout] }),
      compute: { module: traceModule, entryPoint: "traceReflection" } });
    this.compositePipeline = device.createComputePipeline({ label: "Deep SSR composite pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.compositeLayout] }),
      compute: { module: compositeModule, entryPoint: "compositeReflection" } });
    this.radiancePipeline = device.createComputePipeline({ label: "Deep SSR radiance hierarchy pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.radianceLayout] }),
      compute: { module: radianceModule, entryPoint: "downsampleRadiance" } });
  }

  encode(encoder: GPUCommandEncoder, source: ScreenSpaceReflectionSource,
    options: ScreenSpaceReflectionOptions): ScreenSpaceReflectionResult {
    this.assertUsable(); const request = validateRequest(this.session.device, source, options);
    if (this.pool) return this.encodePooled(encoder, source, options, request);
    const previous = this.cache;
    if (previous && source.revision < previous.source.revision) throw new Error("Stale screen-space reflection source revision.");
    if (previous && source.revision === previous.source.revision
      && (source.depth !== previous.source.depth || source.normal !== previous.source.normal || source.color !== previous.source.color)) {
      throw new Error("Screen-space reflection source textures changed without a revision.");
    }
    if (previous && sameSource(previous.source, source) && sameOptions(previous.options, options)) {
      return this.result(previous, false, source.revision, request.activeRadianceMipLevels);
    }
    const reusable = previous && previous.width === request.sourceWidth && previous.height === request.sourceHeight;
    let candidate: Allocation | undefined;
    try {
      candidate = reusable ? previous : this.allocate(request.sourceWidth, request.sourceHeight, request.traceWidth, request.traceHeight);
      const bindings = reusable && source.depth === previous.source.depth && source.normal === previous.source.normal
        && source.color === previous.source.color
        ? { traceBinding: previous.traceBinding, compositeBinding: previous.compositeBinding,
          radianceBindings: previous.radianceBindings }
        : this.bind(candidate, source);
      this.session.device.queue.writeBuffer(candidate.parameters, 0, packParameters(request, options));
      this.encodePass(encoder, candidate, bindings, request.activeRadianceMipLevels);
      const next: Cache = { ...candidate, source, options: Object.freeze({ ...options }),
        traceBinding: bindings.traceBinding, compositeBinding: bindings.compositeBinding,
        radianceBindings: bindings.radianceBindings };
      this.cache = next; if (previous && previous.output !== next.output) this.release(previous);
      return this.result(next, true, source.revision, request.activeRadianceMipLevels);
    } catch (error) { if (candidate && candidate !== previous) this.release(candidate); throw error; }
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    if (this.cache) this.release(this.cache); this.cache = undefined;
    if (this.pooledParameters) this.session.release(this.pooledParameters); this.pooledParameters = undefined;
    if (this.pooledRadiance) this.session.release(this.pooledRadiance.texture); this.pooledRadiance = undefined;
    this.pooledBindings = []; this.pooledSource = undefined;
  }

  private encodePooled(encoder: GPUCommandEncoder, source: ScreenSpaceReflectionSource,
    options: ScreenSpaceReflectionOptions, request: Request): ScreenSpaceReflectionResult {
    if (!this.pool!.frameOpen) throw new Error("Screen-space reflection transient textures require an open frame scope.");
    if (this.pooledEpoch !== this.pool!.epoch) {
      this.pooledEpoch = this.pool!.epoch; this.pooledBindings = []; this.pooledSource = undefined;
      if (this.pooledRadiance) this.session.release(this.pooledRadiance.texture);
      this.pooledRadiance = undefined;
    }
    const previous = this.pooledSource;
    if (previous && source.revision < previous.revision) throw new Error("Stale screen-space reflection source revision.");
    if (previous && source.revision === previous.revision
      && (source.depth !== previous.depth || source.normal !== previous.normal || source.color !== previous.color)) {
      throw new Error("Screen-space reflection source textures changed without a revision.");
    }
    const handles: PbrTransientTextureHandle[] = [];
    const acquire = (resourceId: string, width: number, height: number, format: GPUTextureFormat, usage: GPUTextureUsageFlags) => {
      const handle = this.pool!.acquire({ resourceId, width, height, sampleCount: 1, format, usage });
      handles.push(handle); return handle;
    };
    try {
      const baseUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
      const trace = acquire("ssr-trace", request.traceWidth, request.traceHeight, SSR_TRACE_FORMAT, baseUsage);
      const output = acquire("ssr-hdr", request.sourceWidth, request.sourceHeight, SSR_COMPOSITE_FORMAT, baseUsage);
      const radiance = this.ensurePooledRadiance(source);
      const allocation: Allocation = { width: request.sourceWidth, height: request.sourceHeight,
        traceWidth: request.traceWidth, traceHeight: request.traceHeight,
        trace: trace.texture, output: output.texture, traceView: trace.view, outputView: output.view,
        radiance: radiance.texture, radianceMipLevelCount: radiance.mipLevelCount, radianceBindings: Object.freeze([]),
        parameters: this.parameters() };
      let bindings = this.pooledBindings.find(item => item.trace === trace.texture && item.output === output.texture
        && item.color === source.color && item.depth === source.depth && item.normal === source.normal);
      if (!bindings) {
        const created = this.bind(allocation, source);
        bindings = { trace: trace.texture, output: output.texture, color: source.color, depth: source.depth,
          normal: source.normal, ...created };
        this.pooledBindings.push(bindings); if (this.pooledBindings.length > 4) this.pooledBindings.shift();
      }
      this.session.device.queue.writeBuffer(allocation.parameters, 0, packParameters(request, options));
      this.encodePass(encoder, allocation, bindings, request.activeRadianceMipLevels); this.pooledSource = source;
      return this.result(allocation, true, source.revision, request.activeRadianceMipLevels);
    } finally { for (const handle of handles) this.pool!.release(handle); }
  }

  private parameters(): GPUBuffer {
    return this.pooledParameters ??= createAdmittedBuffer(this.session, { label: "Deep screen-space reflection transient parameters",
      size: PARAMETER_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  private allocate(width: number, height: number, traceWidth: number, traceHeight: number): Allocation {
    const textures: GPUTexture[] = [];
    const texture = (label: string, w: number, h: number, format: GPUTextureFormat, usage: GPUTextureUsageFlags): GPUTexture => {
      const value = createAdmittedTexture(this.session, { label, size: { width: w, height: h, depthOrArrayLayers: 1 },
        dimension: "2d", format, usage }); textures.push(value); return value;
    };
    let parameters: GPUBuffer | undefined;
    try {
      const trace = texture("Deep SSR half-resolution trace", traceWidth, traceHeight, SSR_TRACE_FORMAT,
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);
      const output = texture("Deep SSR composite output", width, height, SSR_COMPOSITE_FORMAT,
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);
      const radianceMipLevelCount = radianceMipLevels(width, height);
      const radiance = createAdmittedTexture(this.session, { label: "Deep SSR bounded radiance hierarchy",
        size: { width, height, depthOrArrayLayers: 1 }, dimension: "2d", format: SSR_COLOR_FORMAT,
        mipLevelCount: radianceMipLevelCount, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
      textures.push(radiance);
      parameters = createAdmittedBuffer(this.session, { label: "Deep screen-space reflection parameters",
        size: PARAMETER_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      return { width, height, traceWidth, traceHeight, trace, output, traceView: trace.createView(),
        outputView: output.createView(), radiance, radianceMipLevelCount,
        radianceBindings: Object.freeze([]), parameters };
    } catch (error) {
      if (parameters) this.session.release(parameters); for (const value of textures) this.session.release(value); throw error;
    }
  }

  private bind(allocation: Allocation, source: ScreenSpaceReflectionSource) {
    const device = this.session.device;
    const depth = source.depth.createView({ format: SSR_DEPTH_FORMAT, dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 });
    const normal = source.normal.createView({ format: SSR_NORMAL_FORMAT, dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 });
    const color = source.color.createView({ format: SSR_COLOR_FORMAT, dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 });
    const radiance = allocation.radiance.createView({ format: SSR_COLOR_FORMAT, dimension: "2d",
      baseMipLevel: 0, mipLevelCount: allocation.radianceMipLevelCount });
    const sampler = device.createSampler({ label: "Deep SSR bilinear sampler", magFilter: "linear", minFilter: "linear" });
    const traceBinding = device.createBindGroup({ label: "Deep SSR trace bindings", layout: this.traceLayout, entries: [
      { binding: 0, resource: depth }, { binding: 1, resource: normal }, { binding: 2, resource: radiance },
      { binding: 3, resource: { buffer: allocation.parameters } }, { binding: 4, resource: sampler },
      { binding: 5, resource: allocation.traceView },
    ] });
    const compositeBinding = device.createBindGroup({ label: "Deep SSR composite bindings", layout: this.compositeLayout, entries: [
      { binding: 0, resource: color }, { binding: 1, resource: allocation.traceView },
      { binding: 2, resource: { buffer: allocation.parameters } }, { binding: 3, resource: sampler },
      { binding: 4, resource: allocation.outputView },
    ] });
    return { traceBinding, compositeBinding,
      radianceBindings: this.bindRadiance(source, allocation.radiance, allocation.radianceMipLevelCount) };
  }

  private encodePass(encoder: GPUCommandEncoder, allocation: Allocation,
    bindings: { traceBinding: GPUBindGroup; compositeBinding: GPUBindGroup;
      radianceBindings: readonly GPUBindGroup[] }, activeRadianceMipLevels: number): void {
    const radianceBindings = bindings.radianceBindings.slice(0, activeRadianceMipLevels);
    for (let level = 0; level < radianceBindings.length; level += 1) {
      const width = Math.max(1, allocation.width >> level), height = Math.max(1, allocation.height >> level);
      const radiance = encoder.beginComputePass({ label: `Deep SSR radiance mip ${level}` });
      radiance.setPipeline(this.radiancePipeline); radiance.setBindGroup(0, radianceBindings[level]!);
      radiance.dispatchWorkgroups(Math.ceil(width / SSR_WORKGROUP_SIZE), Math.ceil(height / SSR_WORKGROUP_SIZE)); radiance.end();
    }
    const traceX = Math.ceil(allocation.traceWidth / SSR_WORKGROUP_SIZE), traceY = Math.ceil(allocation.traceHeight / SSR_WORKGROUP_SIZE);
    const trace = encoder.beginComputePass({ label: "Deep screen-space reflection trace" });
    trace.setPipeline(this.tracePipeline); trace.setBindGroup(0, bindings.traceBinding);
    trace.dispatchWorkgroups(traceX, traceY); trace.end();
    const compositeX = Math.ceil(allocation.width / SSR_WORKGROUP_SIZE), compositeY = Math.ceil(allocation.height / SSR_WORKGROUP_SIZE);
    const composite = encoder.beginComputePass({ label: "Deep screen-space reflection composite" });
    composite.setPipeline(this.compositePipeline); composite.setBindGroup(0, bindings.compositeBinding);
    composite.dispatchWorkgroups(compositeX, compositeY); composite.end();
  }

  private release(allocation: Allocation): void {
    this.session.release(allocation.parameters); this.session.release(allocation.trace); this.session.release(allocation.output);
    this.session.release(allocation.radiance);
  }
  private result(cache: Allocation, updated: boolean, revision: number, activeRadianceMipLevels: number): ScreenSpaceReflectionResult {
    return Object.freeze({ texture: cache.output, format: SSR_COMPOSITE_FORMAT, width: cache.width, height: cache.height,
      traceWidth: cache.traceWidth, traceHeight: cache.traceHeight, revision, updated,
      radianceMipLevelCount: activeRadianceMipLevels, passCount: activeRadianceMipLevels + 2 });
  }

  private ensurePooledRadiance(source: ScreenSpaceReflectionSource): PooledRadiance {
    const existing = this.pooledRadiance;
    if (existing && existing.width === source.color.width && existing.height === source.color.height) return existing;
    if (existing) this.session.release(existing.texture);
    const mipLevelCount = radianceMipLevels(source.color.width, source.color.height);
    const texture = createAdmittedTexture(this.session, { label: "Deep SSR pooled bounded radiance hierarchy",
      size: { width: source.color.width, height: source.color.height, depthOrArrayLayers: 1 }, dimension: "2d",
      format: SSR_COLOR_FORMAT, mipLevelCount, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    const next = { width: source.color.width, height: source.color.height, texture, mipLevelCount } satisfies PooledRadiance;
    this.pooledRadiance = next; this.pooledBindings = [];
    return next;
  }

  private bindRadiance(source: ScreenSpaceReflectionSource, texture: GPUTexture, mipLevelCount: number): readonly GPUBindGroup[] {
    const bindings: GPUBindGroup[] = [];
    for (let level = 0; level < mipLevelCount; level += 1) {
      const input = level === 0
        ? source.color.createView({ format: SSR_COLOR_FORMAT, dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 })
        : texture.createView({ format: SSR_COLOR_FORMAT, dimension: "2d", baseMipLevel: level - 1, mipLevelCount: 1 });
      const output = texture.createView({ format: SSR_COLOR_FORMAT, dimension: "2d", baseMipLevel: level, mipLevelCount: 1 });
      bindings.push(this.session.device.createBindGroup({ label: `Deep SSR radiance mip ${level} bindings`,
        layout: this.radianceLayout, entries: [{ binding: 0, resource: input }, { binding: 1, resource: output }] }));
    }
    return Object.freeze(bindings);
  }

  private assertReady(): void { if (this.session.state !== "ready") throw new Error("GPU session is not ready for screen-space reflection."); }
  private assertUsable(): void {
    if (this.disposed) throw new Error("Screen-space reflection pass is disposed.");
    if (this.session.state !== "ready") { if (this.cache) this.release(this.cache); this.cache = undefined;
      throw new Error("GPU session is not ready for screen-space reflection."); }
  }
}

function validateRequest(device: GPUDevice, source: ScreenSpaceReflectionSource,
  options: ScreenSpaceReflectionOptions): Request {
  if (source.depthEncoding !== "linear-view-depth-positive") throw new Error("SSR requires explicit positive linear view depth; standard/reversed device depth must be linearized first.");
  if (source.normalSpace !== "view") throw new Error("SSR normals must be declared in view space.");
  if (source.colorEncoding !== "linear-hdr") throw new Error("SSR color input must be linear HDR.");
  if (!Number.isSafeInteger(source.revision) || source.revision < 0) throw new Error("SSR source revision must be a nonnegative safe integer.");
  validateTexture(source.depth, SSR_DEPTH_FORMAT, "depth"); validateTexture(source.normal, SSR_NORMAL_FORMAT, "normal");
  validateTexture(source.color, SSR_COLOR_FORMAT, "color");
  if (source.depth.width !== source.normal.width || source.depth.height !== source.normal.height
    || source.depth.width !== source.color.width || source.depth.height !== source.color.height) {
    throw new Error("SSR depth, normal, and color dimensions must match.");
  }
  if (source.depth.width > device.limits.maxTextureDimension2D || source.depth.height > device.limits.maxTextureDimension2D) {
    throw new Error("SSR source dimensions exceed device limits.");
  }
  validateScreenSpaceReflectionOptions(options);
  const [traceWidth, traceHeight] = screenSpaceReflectionHalfSize(source.depth.width, source.depth.height);
  if (Math.ceil(traceWidth / SSR_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension
    || Math.ceil(traceHeight / SSR_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension
    || Math.ceil(source.depth.width / SSR_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension
    || Math.ceil(source.depth.height / SSR_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension) {
    throw new Error("SSR dispatch exceeds device workgroup limits.");
  }
  return { sourceWidth: source.depth.width, sourceHeight: source.depth.height, traceWidth, traceHeight,
    activeRadianceMipLevels: Math.min(options.coneMipLevels ?? MAX_RADIANCE_MIP_LEVELS,
      radianceMipLevels(source.depth.width, source.depth.height)) };
}
function validateTexture(texture: GPUTexture, format: GPUTextureFormat, name: string): void {
  if (texture.format !== format) throw new Error(`SSR ${name} format must be ${format}.`);
  if (texture.dimension !== "2d" || texture.depthOrArrayLayers !== 1 || texture.sampleCount !== 1) {
    throw new Error(`SSR ${name} must be a non-multisampled single-layer 2D texture.`);
  }
  if ((texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0) throw new Error(`SSR ${name} requires TEXTURE_BINDING usage.`);
  if (!Number.isInteger(texture.width) || !Number.isInteger(texture.height) || texture.width < 1 || texture.height < 1) {
    throw new Error(`SSR ${name} dimensions must be positive integers.`);
  }
}
function packParameters(request: Request, options: ScreenSpaceReflectionOptions): ArrayBuffer {
  const buffer = new ArrayBuffer(PARAMETER_BYTES), uints = new Uint32Array(buffer), floats = new Float32Array(buffer);
  uints.set([request.sourceWidth, request.sourceHeight], 0);
  uints.set([request.traceWidth, request.traceHeight], 2);
  floats.set([Math.tan(options.verticalFovRadians * 0.5), request.sourceWidth / request.sourceHeight,
    options.maxDistance, options.thickness], 4);
  uints.set([options.steps, options.refines], 8);
  floats.set([options.edgeFade, options.fresnelF0, request.activeRadianceMipLevels - 1], 12);
  return buffer;
}
export function radianceMipLevels(width: number, height: number): number {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("SSR radiance dimensions must be positive safe integers.");
  }
  return Math.min(MAX_RADIANCE_MIP_LEVELS, Math.floor(Math.log2(Math.max(width, height))) + 1);
}
function sameSource(left: ScreenSpaceReflectionSource, right: ScreenSpaceReflectionSource): boolean {
  return left.revision === right.revision && left.depth === right.depth && left.normal === right.normal && left.color === right.color;
}
function sameOptions(left: ScreenSpaceReflectionOptions, right: ScreenSpaceReflectionOptions): boolean {
  return left.verticalFovRadians === right.verticalFovRadians && left.maxDistance === right.maxDistance
    && left.thickness === right.thickness && left.steps === right.steps && left.refines === right.refines
    && left.edgeFade === right.edgeFade && left.fresnelF0 === right.fresnelF0
    && left.coneMipLevels === right.coneMipLevels;
}
