/// <reference types="@webgpu/types" />
import { createAdmittedBuffer } from "../webgpu/resourceAdmission.js";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import type { PbrTransientTextureHandle, PbrTransientTexturePool } from "../webgpu/pbrTransientTexturePool.js";
import { SSGI_WORKGROUP_SIZE, SSGI_TRACE_WGSL, SSGI_COMPOSITE_WGSL } from "./screenSpaceGiWgsl.js";
import { screenSpaceGiHalfSize, validateScreenSpaceGiOptions } from "./screenSpaceGiCpu.js";
import { SSGI_COMPOSITE_FORMAT, SSGI_DEPTH_FORMAT, SSGI_NORMAL_FORMAT, SSGI_COLOR_FORMAT, SSGI_TRACE_FORMAT,
  type ScreenSpaceGiOptions, type ScreenSpaceGiResult, type ScreenSpaceGiSource } from "./screenSpaceGiTypes.js";

const PARAMETER_BYTES = 64;
interface PooledBindings {
  readonly trace: GPUTexture; readonly output: GPUTexture;
  readonly color: GPUTexture; readonly depth: GPUTexture; readonly normal: GPUTexture;
  readonly traceBinding: GPUBindGroup; readonly compositeBinding: GPUBindGroup;
}
interface Request { readonly sourceWidth: number; readonly sourceHeight: number;
  readonly traceWidth: number; readonly traceHeight: number }
export type { Request as ScreenSpaceGiRequest };

/**
 * Half-resolution screen-space diffuse bounce trace + full-resolution additive composite,
 * ahead of SSR/TAA (P2 六引擎对标 SSGI;见 screenSpaceGiTypes.ts 的 GI 分工裁决)。
 * 全 transient pool 路径(生产帧池恒在;构造要求 pool,拒绝隐式自有分配)。
 */
export class ScreenSpaceGiPass {
  private readonly traceLayout: GPUBindGroupLayout; private readonly compositeLayout: GPUBindGroupLayout;
  private readonly tracePipeline: GPUComputePipeline; private readonly compositePipeline: GPUComputePipeline;
  private disposed = false;
  private pooledParameters: GPUBuffer | undefined; private pooledEpoch = -1; private pooledBindings: PooledBindings[] = [];
  private pooledSource: ScreenSpaceGiSource | undefined;

  constructor(private readonly session: DeviceSession, private readonly pool: PbrTransientTexturePool) {
    this.assertReady(); const device = session.device;
    const traceModule = device.createShaderModule({ label: "Deep screen-space GI trace WGSL", code: SSGI_TRACE_WGSL });
    const compositeModule = device.createShaderModule({ label: "Deep screen-space GI composite WGSL", code: SSGI_COMPOSITE_WGSL });
    this.traceLayout = device.createBindGroupLayout({ label: "Deep SSGI trace layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: PARAMETER_BYTES } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: SSGI_TRACE_FORMAT } },
    ] });
    this.compositeLayout = device.createBindGroupLayout({ label: "Deep SSGI composite layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: PARAMETER_BYTES } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: SSGI_COMPOSITE_FORMAT } },
    ] });
    this.tracePipeline = device.createComputePipeline({ label: "Deep SSGI half-resolution trace pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.traceLayout] }),
      compute: { module: traceModule, entryPoint: "traceScreenSpaceGi" } });
    this.compositePipeline = device.createComputePipeline({ label: "Deep SSGI composite pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.compositeLayout] }),
      compute: { module: compositeModule, entryPoint: "compositeScreenSpaceGi" } });
  }

  encode(encoder: GPUCommandEncoder, source: ScreenSpaceGiSource, options: ScreenSpaceGiOptions): ScreenSpaceGiResult {
    this.assertUsable();
    if (!this.pool.frameOpen) throw new Error("Screen-space GI transient textures require an open frame scope.");
    const request = validateRequest(this.session.device, source, options);
    if (this.pooledEpoch !== this.pool.epoch) {
      this.pooledEpoch = this.pool.epoch; this.pooledBindings = []; this.pooledSource = undefined;
    }
    const previous = this.pooledSource;
    if (previous && source.revision < previous.revision) throw new Error("Stale screen-space GI source revision.");
    if (previous && source.revision === previous.revision
      && (source.depth !== previous.depth || source.normal !== previous.normal || source.color !== previous.color)) {
      throw new Error("Screen-space GI source textures changed without a revision.");
    }
    const handles: PbrTransientTextureHandle[] = [];
    const acquire = (resourceId: string, width: number, height: number, format: GPUTextureFormat,
      usage: GPUTextureUsageFlags) => {
      const handle = this.pool.acquire({ resourceId, width, height, sampleCount: 1, format, usage });
      handles.push(handle); return handle;
    };
    try {
      // 输出带 COPY_SRC:present-color 读回链在 SSGI 为链尾效果时落在本输出上(与 ssr-hdr 合同对齐)。
      const baseUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
      const trace = acquire("ssgi-trace", request.traceWidth, request.traceHeight, SSGI_TRACE_FORMAT, baseUsage);
      const output = acquire("ssgi-hdr", request.sourceWidth, request.sourceHeight, SSGI_COMPOSITE_FORMAT,
        baseUsage | GPUTextureUsage.COPY_SRC);
      let bindings = this.pooledBindings.find(item => item.trace === trace.texture && item.output === output.texture
        && item.color === source.color && item.depth === source.depth && item.normal === source.normal);
      if (!bindings) {
        const traceBinding = this.session.device.createBindGroup({ label: "Deep SSGI trace bindings",
          layout: this.traceLayout, entries: [
            { binding: 0, resource: source.depth.createView({ format: SSGI_DEPTH_FORMAT, dimension: "2d",
              baseMipLevel: 0, mipLevelCount: 1 }) },
            { binding: 1, resource: source.normal.createView({ format: SSGI_NORMAL_FORMAT, dimension: "2d",
              baseMipLevel: 0, mipLevelCount: 1 }) },
            { binding: 2, resource: source.color.createView({ format: SSGI_COLOR_FORMAT, dimension: "2d",
              baseMipLevel: 0, mipLevelCount: 1 }) },
            { binding: 3, resource: { buffer: this.parameters() } },
            { binding: 4, resource: this.sampler() },
            { binding: 5, resource: trace.view }] });
        const compositeBinding = this.session.device.createBindGroup({ label: "Deep SSGI composite bindings",
          layout: this.compositeLayout, entries: [
            { binding: 0, resource: source.color.createView({ format: SSGI_COLOR_FORMAT, dimension: "2d",
              baseMipLevel: 0, mipLevelCount: 1 }) },
            { binding: 1, resource: trace.view },
            { binding: 2, resource: { buffer: this.parameters() } },
            { binding: 3, resource: this.sampler() },
            { binding: 4, resource: output.view }] });
        bindings = { trace: trace.texture, output: output.texture, color: source.color, depth: source.depth,
          normal: source.normal, traceBinding, compositeBinding };
        this.pooledBindings.push(bindings); if (this.pooledBindings.length > 4) this.pooledBindings.shift();
      }
      this.session.device.queue.writeBuffer(this.parameters(), 0, packSsgiParameters(request, options));
      this.encodePass(encoder, request, bindings.traceBinding, bindings.compositeBinding, options.passTiming);
      this.pooledSource = source;
      return Object.freeze({ texture: output.texture, format: SSGI_COMPOSITE_FORMAT,
        width: request.sourceWidth, height: request.sourceHeight,
        traceWidth: request.traceWidth, traceHeight: request.traceHeight,
        revision: source.revision, updated: true, passCount: 2 });
    } finally { for (const handle of handles) this.pool.release(handle); }
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    if (this.pooledParameters) this.session.release(this.pooledParameters);
    this.pooledParameters = undefined; this.pooledBindings = []; this.pooledSource = undefined;
  }

  private parameters(): GPUBuffer {
    return this.pooledParameters ??= createAdmittedBuffer(this.session,
      { label: "Deep screen-space GI parameters", size: PARAMETER_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }
  private samplerCache: GPUSampler | undefined;
  private sampler(): GPUSampler {
    return this.samplerCache ??= this.session.device.createSampler(
      { label: "Deep SSGI bilinear sampler", magFilter: "linear", minFilter: "linear" });
  }

  private encodePass(encoder: GPUCommandEncoder, request: Request,
    traceBinding: GPUBindGroup, compositeBinding: GPUBindGroup,
    passTiming?: ScreenSpaceGiOptions["passTiming"]): void {
    passTiming?.beginMarker(encoder, "screen-space-gi-trace");
    const traceX = Math.ceil(request.traceWidth / SSGI_WORKGROUP_SIZE), traceY = Math.ceil(request.traceHeight / SSGI_WORKGROUP_SIZE);
    const trace = encoder.beginComputePass({ label: "Deep screen-space GI trace" });
    trace.setPipeline(this.tracePipeline); trace.setBindGroup(0, traceBinding);
    trace.dispatchWorkgroups(traceX, traceY); trace.end();
    passTiming?.endMarker(encoder, "screen-space-gi-trace");
    passTiming?.beginMarker(encoder, "screen-space-gi-composite");
    const compositeX = Math.ceil(request.sourceWidth / SSGI_WORKGROUP_SIZE), compositeY = Math.ceil(request.sourceHeight / SSGI_WORKGROUP_SIZE);
    const composite = encoder.beginComputePass({ label: "Deep screen-space GI composite" });
    composite.setPipeline(this.compositePipeline); composite.setBindGroup(0, compositeBinding);
    composite.dispatchWorkgroups(compositeX, compositeY); composite.end();
    passTiming?.endMarker(encoder, "screen-space-gi-composite");
  }

  private assertReady(): void { if (this.session.state !== "ready") throw new Error("GPU session is not ready for screen-space GI."); }
  private assertUsable(): void {
    if (this.disposed) throw new Error("Screen-space GI pass is disposed.");
    if (this.session.state !== "ready") { this.pooledBindings = []; this.pooledSource = undefined;
      throw new Error("GPU session is not ready for screen-space GI."); }
  }
}

function validateRequest(device: GPUDevice, source: ScreenSpaceGiSource, options: ScreenSpaceGiOptions): Request {
  if (source.depthEncoding !== "linear-view-depth-positive") throw new Error("SSGI requires explicit positive linear view depth; standard/reversed device depth must be linearized first.");
  if (source.normalSpace !== "view") throw new Error("SSGI normals must be declared in view space.");
  if (source.colorEncoding !== "linear-hdr") throw new Error("SSGI color input must be linear HDR.");
  if (!Number.isSafeInteger(source.revision) || source.revision < 0) throw new Error("SSGI source revision must be a nonnegative safe integer.");
  validateTexture(source.depth, SSGI_DEPTH_FORMAT, "depth"); validateTexture(source.normal, SSGI_NORMAL_FORMAT, "normal");
  validateTexture(source.color, SSGI_COLOR_FORMAT, "color");
  if (source.depth.width !== source.normal.width || source.depth.height !== source.normal.height
    || source.depth.width !== source.color.width || source.depth.height !== source.color.height) {
    throw new Error("SSGI depth, normal, and color dimensions must match.");
  }
  if (source.depth.width > device.limits.maxTextureDimension2D || source.depth.height > device.limits.maxTextureDimension2D) {
    throw new Error("SSGI source dimensions exceed device limits.");
  }
  validateScreenSpaceGiOptions(options);
  const [traceWidth, traceHeight] = screenSpaceGiHalfSize(source.depth.width, source.depth.height);
  if (Math.ceil(traceWidth / SSGI_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension
    || Math.ceil(traceHeight / SSGI_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension
    || Math.ceil(source.depth.width / SSGI_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension
    || Math.ceil(source.depth.height / SSGI_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension) {
    throw new Error("SSGI dispatch exceeds device workgroup limits.");
  }
  return { sourceWidth: source.depth.width, sourceHeight: source.depth.height, traceWidth, traceHeight };
}
function validateTexture(texture: GPUTexture, format: GPUTextureFormat, name: string): void {
  if (texture.format !== format) throw new Error(`SSGI ${name} format must be ${format}.`);
  if (texture.dimension !== "2d" || texture.depthOrArrayLayers !== 1 || texture.sampleCount !== 1) {
    throw new Error(`SSGI ${name} must be a non-multisampled single-layer 2D texture.`);
  }
  if ((texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0) throw new Error(`SSGI ${name} requires TEXTURE_BINDING usage.`);
  if (!Number.isInteger(texture.width) || !Number.isInteger(texture.height) || texture.width < 1 || texture.height < 1) {
    throw new Error(`SSGI ${name} dimensions must be positive integers.`);
  }
}

/** Parameter block shared by the pass and the real-GPU capture scripts (single packing source). */
export function packSsgiParameters(request: Request, options: ScreenSpaceGiOptions): ArrayBuffer {
  const buffer = new ArrayBuffer(PARAMETER_BYTES), uints = new Uint32Array(buffer), floats = new Float32Array(buffer);
  uints.set([request.sourceWidth, request.sourceHeight], 0);
  uints.set([request.traceWidth, request.traceHeight], 2);
  floats.set([Math.tan(options.verticalFovRadians * 0.5), request.sourceWidth / request.sourceHeight,
    options.maxDistance, options.thickness], 4);
  uints.set([options.steps, options.samples, options.seed, options.refines], 8);
  floats.set([options.intensity, options.edgeFade], 12);
  return buffer;
}

/** Scene-extent derived defaults (same derivation family as defaultScreenSpaceReflectionOptions). */
export function defaultScreenSpaceGiOptions(extent: number): Readonly<{
  verticalFovRadians: number; samples: number; maxDistance: number; thickness: number;
  steps: number; refines: number; edgeFade: number; intensity: number; seed: number }> {
  return Object.freeze({ verticalFovRadians: Math.PI / 3, samples: 12,
    maxDistance: Math.max(1, extent * 2), thickness: Math.max(0.01, extent * 0.01),
    steps: 24, refines: 4, edgeFade: 0.08, intensity: 1, seed: 0 });
}
