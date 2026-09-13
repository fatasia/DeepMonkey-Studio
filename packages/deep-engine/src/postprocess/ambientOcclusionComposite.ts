/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { validateAmbientOcclusionCompositeOptions } from "./ambientOcclusionCompositeCpu.js";
import {
  AMBIENT_OCCLUSION_COMPOSITE_COLOR_FORMAT,
  AMBIENT_OCCLUSION_COMPOSITE_DEPTH_FORMAT,
  type AmbientOcclusionCompositeOptions,
  type AmbientOcclusionCompositeResult,
  type AmbientOcclusionCompositeSource,
} from "./ambientOcclusionCompositeTypes.js";
import {
  AMBIENT_OCCLUSION_COMPOSITE_WGSL,
  AMBIENT_OCCLUSION_COMPOSITE_WORKGROUP_SIZE,
} from "./ambientOcclusionCompositeWgsl.js";
import { AMBIENT_OCCLUSION_OUTPUT_FORMAT } from "./ambientOcclusionTypes.js";
import { AMBIENT_OCCLUSION_SAMPLE_COUNT } from "./ambientOcclusionWgsl.js";

const PARAMETER_BYTES = 32;

interface Allocation {
  readonly width: number;
  readonly height: number;
  readonly output: GPUTexture;
  readonly outputView: GPUTextureView;
  readonly parameters: GPUBuffer;
}

interface Cache extends Allocation {
  readonly source: AmbientOcclusionCompositeSource;
  readonly options: AmbientOcclusionCompositeOptions;
  readonly binding: GPUBindGroup;
}

/** Full-resolution depth-aware AO upsample and linear HDR modulation. */
export class AmbientOcclusionCompositePass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private cache: Cache | undefined;
  private disposed = false;

  constructor(private readonly session: DeviceSession) {
    this.assertReady();
    const device = session.device;
    const module = device.createShaderModule({ label: "Deep ambient occlusion composite WGSL", code: AMBIENT_OCCLUSION_COMPOSITE_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep ambient occlusion composite layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: PARAMETER_BYTES } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: "write-only", format: AMBIENT_OCCLUSION_COMPOSITE_COLOR_FORMAT } },
    ] });
    this.pipeline = device.createComputePipeline({
      label: "Deep ambient occlusion HDR composite pipeline",
      layout: device.createPipelineLayout({ label: "Deep ambient occlusion composite pipeline layout", bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "compositeAmbientOcclusion" },
    });
  }

  get current(): AmbientOcclusionCompositeResult | undefined {
    if (this.disposed) return undefined;
    if (this.session.state !== "ready") { this.clearCache(); return undefined; }
    return this.cache ? this.result(this.cache, false) : undefined;
  }

  encode(
    encoder: GPUCommandEncoder,
    source: AmbientOcclusionCompositeSource,
    options: AmbientOcclusionCompositeOptions,
  ): AmbientOcclusionCompositeResult {
    this.assertUsable(); validateRequest(this.session.device, source, options);
    const previous = this.cache;
    if (previous && source.revision < previous.source.revision) throw new Error("Stale AO composite source revision.");
    if (previous && source.revision === previous.source.revision && !sameSource(previous.source, source)) {
      throw new Error("AO composite source textures changed without a revision.");
    }
    if (previous && sameSource(previous.source, source) && sameOptions(previous.options, options)) return this.result(previous, false);
    const reusable = previous && previous.width === source.color.width && previous.height === source.color.height;
    let candidate: Allocation | undefined;
    try {
      candidate = reusable ? previous : this.allocate(source.color.width, source.color.height);
      const binding = reusable && sameTextureBindings(previous.source, source) ? previous.binding : this.bind(candidate, source);
      this.session.device.queue.writeBuffer(candidate.parameters, 0, packParameters(source, options));
      const pass = encoder.beginComputePass({ label: "Deep ambient occlusion HDR composite" });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, binding);
      pass.dispatchWorkgroups(
        Math.ceil(candidate.width / AMBIENT_OCCLUSION_COMPOSITE_WORKGROUP_SIZE),
        Math.ceil(candidate.height / AMBIENT_OCCLUSION_COMPOSITE_WORKGROUP_SIZE),
      );
      pass.end();
      const next: Cache = { ...candidate, source, options: Object.freeze({ ...options }), binding };
      this.cache = next;
      if (previous && previous.output !== next.output) this.release(previous);
      return this.result(next, true);
    } catch (error) {
      if (candidate && candidate !== previous) this.release(candidate);
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.clearCache();
  }

  private allocate(width: number, height: number): Allocation {
    let output: GPUTexture | undefined, parameters: GPUBuffer | undefined;
    try {
      output = this.session.own(this.session.device.createTexture({
        label: "Deep full-resolution AO composite HDR",
        size: { width, height, depthOrArrayLayers: 1 },
        dimension: "2d",
        format: AMBIENT_OCCLUSION_COMPOSITE_COLOR_FORMAT,
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
          | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      }));
      const outputView = output.createView();
      parameters = this.session.own(this.session.device.createBuffer({
        label: "Deep ambient occlusion composite parameters",
        size: PARAMETER_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }));
      return { width, height, output, outputView, parameters };
    } catch (error) {
      if (parameters) this.session.release(parameters);
      if (output) this.session.release(output);
      throw error;
    }
  }

  private bind(allocation: Allocation, source: AmbientOcclusionCompositeSource): GPUBindGroup {
    const views = [
      source.color.createView({ format: AMBIENT_OCCLUSION_COMPOSITE_COLOR_FORMAT, dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 }),
      source.depth.createView({ format: AMBIENT_OCCLUSION_COMPOSITE_DEPTH_FORMAT, dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 }),
      source.ambientOcclusion.texture.createView({ format: AMBIENT_OCCLUSION_OUTPUT_FORMAT, dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 }),
    ];
    return this.session.device.createBindGroup({
      label: "Deep ambient occlusion composite bindings",
      layout: this.layout,
      entries: [
        ...views.map((resource, binding) => ({ binding, resource })),
        { binding: 3, resource: { buffer: allocation.parameters } },
        { binding: 4, resource: allocation.outputView },
      ],
    });
  }

  private result(cache: Cache, updated: boolean): AmbientOcclusionCompositeResult {
    return Object.freeze({ texture: cache.output, format: AMBIENT_OCCLUSION_COMPOSITE_COLOR_FORMAT,
      width: cache.width, height: cache.height, revision: cache.source.revision, updated, colorEncoding: "linear-hdr" });
  }
  private release(allocation: Allocation): void {
    this.session.release(allocation.parameters); this.session.release(allocation.output);
  }
  private clearCache(): void { if (this.cache) this.release(this.cache); this.cache = undefined; }
  private assertReady(): void {
    if (this.session.state !== "ready") throw new Error("GPU session is not ready for AO composite.");
  }
  private assertUsable(): void {
    if (this.disposed) throw new Error("AO composite pass is disposed.");
    if (this.session.state !== "ready") { this.clearCache(); throw new Error("GPU session is not ready for AO composite."); }
  }
}

function validateRequest(
  device: GPUDevice,
  source: AmbientOcclusionCompositeSource,
  options: AmbientOcclusionCompositeOptions,
): void {
  if (source.colorEncoding !== "linear-hdr") throw new Error("AO composite requires explicit linear HDR color.");
  if (source.depthEncoding !== "linear-view-depth-positive") throw new Error("AO composite requires positive linear view depth.");
  if (!Number.isSafeInteger(source.revision) || source.revision < 0) throw new Error("AO composite revision must be a nonnegative safe integer.");
  validateTexture(source.color, AMBIENT_OCCLUSION_COMPOSITE_COLOR_FORMAT, "color");
  validateTexture(source.depth, AMBIENT_OCCLUSION_COMPOSITE_DEPTH_FORMAT, "depth");
  if (source.color.width !== source.depth.width || source.color.height !== source.depth.height) {
    throw new Error("AO composite color and depth dimensions must match.");
  }
  validateAmbientOcclusionResult(source);
  if (source.color.width > device.limits.maxTextureDimension2D || source.color.height > device.limits.maxTextureDimension2D) {
    throw new Error("AO composite dimensions exceed device limits.");
  }
  if (Math.ceil(source.color.width / AMBIENT_OCCLUSION_COMPOSITE_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension
    || Math.ceil(source.color.height / AMBIENT_OCCLUSION_COMPOSITE_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension) {
    throw new Error("AO composite dispatch exceeds device workgroup limits.");
  }
  validateAmbientOcclusionCompositeOptions(options);
}

function validateAmbientOcclusionResult(source: AmbientOcclusionCompositeSource): void {
  const ao = source.ambientOcclusion;
  if (ao.format !== AMBIENT_OCCLUSION_OUTPUT_FORMAT || ao.texture.format !== AMBIENT_OCCLUSION_OUTPUT_FORMAT) {
    throw new Error(`AO composite ambient occlusion format must be ${AMBIENT_OCCLUSION_OUTPUT_FORMAT}.`);
  }
  validateTexture(ao.texture, AMBIENT_OCCLUSION_OUTPUT_FORMAT, "ambient occlusion");
  if (ao.width !== ao.texture.width || ao.height !== ao.texture.height
    || ao.width !== Math.ceil(source.color.width / 2) || ao.height !== Math.ceil(source.color.height / 2)) {
    throw new Error("AO composite requires exact ceil-half ambient occlusion dimensions.");
  }
  if (ao.sourceWidth !== source.color.width || ao.sourceHeight !== source.color.height) {
    throw new Error("AO composite ambient occlusion source dimensions do not match HDR input.");
  }
  if (ao.revision !== source.revision) throw new Error("AO composite ambient occlusion revision must match the frame revision.");
  if (ao.depthEncoding !== "linear-view-depth-positive" || ao.sampleCount !== AMBIENT_OCCLUSION_SAMPLE_COUNT) {
    throw new Error("AO composite requires a compatible Deep ambient occlusion result.");
  }
}

function validateTexture(texture: GPUTexture, format: GPUTextureFormat, name: string): void {
  if (texture.format !== format) throw new Error(`AO composite ${name} format must be ${format}.`);
  if (texture.dimension !== "2d" || texture.depthOrArrayLayers !== 1 || texture.sampleCount !== 1) {
    throw new Error(`AO composite ${name} must be a non-multisampled single-layer 2D texture.`);
  }
  if ((texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0) throw new Error(`AO composite ${name} requires TEXTURE_BINDING usage.`);
  if (!Number.isInteger(texture.width) || !Number.isInteger(texture.height) || texture.width < 1 || texture.height < 1) {
    throw new Error(`AO composite ${name} dimensions must be positive integers.`);
  }
}

function packParameters(source: AmbientOcclusionCompositeSource, options: AmbientOcclusionCompositeOptions): ArrayBuffer {
  const buffer = new ArrayBuffer(PARAMETER_BYTES), uints = new Uint32Array(buffer), floats = new Float32Array(buffer);
  uints.set([source.color.width, source.color.height, source.ambientOcclusion.width, source.ambientOcclusion.height], 0);
  floats.set([options.depthSigma, options.strength, 0, 0], 4);
  return buffer;
}

function sameTextureBindings(left: AmbientOcclusionCompositeSource, right: AmbientOcclusionCompositeSource): boolean {
  return left.color === right.color && left.depth === right.depth
    && left.ambientOcclusion.texture === right.ambientOcclusion.texture;
}
function sameSource(left: AmbientOcclusionCompositeSource, right: AmbientOcclusionCompositeSource): boolean {
  return left.revision === right.revision && sameTextureBindings(left, right);
}
function sameOptions(left: AmbientOcclusionCompositeOptions, right: AmbientOcclusionCompositeOptions): boolean {
  return left.depthSigma === right.depthSigma && left.strength === right.strength;
}
