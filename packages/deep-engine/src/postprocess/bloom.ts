/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { bloomPyramidSizes, validateBloomOptions } from "./bloomCpu.js";
import {
  allocateBloomResources,
  createBloomSourceBindings,
  releaseBloomResources,
  type BloomAllocation,
} from "./bloomResources.js";
import { BLOOM_COLOR_FORMAT, type BloomOptions, type BloomResult, type BloomSource } from "./bloomTypes.js";
import { BLOOM_WGSL, BLOOM_WORKGROUP_SIZE } from "./bloomWgsl.js";

interface Cache extends BloomAllocation {
  readonly source: BloomSource;
  readonly options: BloomOptions;
  readonly sourceBindings: Readonly<{ extract: GPUBindGroup; composite: GPUBindGroup }>;
}

interface Pipelines {
  readonly extract: GPUComputePipeline;
  readonly downsample: GPUComputePipeline;
  readonly horizontal: GPUComputePipeline;
  readonly vertical: GPUComputePipeline;
  readonly upsample: GPUComputePipeline;
  readonly composite: GPUComputePipeline;
}

/** HDR threshold, dynamic Gaussian pyramid, progressive upsample, and scene composite. */
export class BloomPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipelines: Pipelines;
  private cache: Cache | undefined;
  private disposed = false;

  constructor(private readonly session: DeviceSession) {
    this.assertReady();
    const device = session.device, module = device.createShaderModule({ label: "Deep HDR bloom WGSL", code: BLOOM_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep HDR bloom layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 16 } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: BLOOM_COLOR_FORMAT } },
    ] });
    const pipelineLayout = device.createPipelineLayout({ label: "Deep HDR bloom pipeline layout", bindGroupLayouts: [this.layout] });
    const pipeline = (label: string, entryPoint: string): GPUComputePipeline => device.createComputePipeline({
      label, layout: pipelineLayout, compute: { module, entryPoint },
    });
    this.pipelines = Object.freeze({
      extract: pipeline("Deep bloom threshold extract pipeline", "extractDownsample"),
      downsample: pipeline("Deep bloom downsample pipeline", "downsample"),
      horizontal: pipeline("Deep bloom horizontal Gaussian pipeline", "blurHorizontal"),
      vertical: pipeline("Deep bloom vertical Gaussian pipeline", "blurVertical"),
      upsample: pipeline("Deep bloom progressive upsample pipeline", "upsampleCombine"),
      composite: pipeline("Deep bloom HDR scene composite pipeline", "compositeScene"),
    });
  }

  get current(): BloomResult | undefined {
    if (this.disposed) return undefined;
    if (this.session.state !== "ready") { this.clearCache(); return undefined; }
    return this.cache ? bloomResult(this.cache, false) : undefined;
  }

  encode(encoder: GPUCommandEncoder, source: BloomSource, options: BloomOptions): BloomResult {
    this.assertUsable();
    const sizes = validateRequest(this.session.device, source, options), previous = this.cache;
    if (previous && source.revision < previous.source.revision) throw new Error("Stale bloom source revision.");
    if (previous && source.revision === previous.source.revision && source.color !== previous.source.color) {
      throw new Error("Bloom source texture changed without a revision.");
    }
    if (previous && sameSource(previous.source, source) && sameOptions(previous.options, options)) return bloomResult(previous, false);
    const reusable = previous && previous.width === source.color.width && previous.height === source.color.height
      && sameLevelSizes(previous.levels, sizes);
    let candidate: BloomAllocation | undefined;
    try {
      candidate = reusable ? previous : allocateBloomResources(this.session, this.layout, source.color.width, source.color.height, sizes);
      const sourceBindings = reusable && source.color === previous.source.color
        ? previous.sourceBindings : createBloomSourceBindings(this.session.device, this.layout, candidate, source.color);
      this.session.device.queue.writeBuffer(candidate.parameters, 0,
        new Float32Array([options.threshold, options.softKnee, options.intensity, 0]));
      encodeBloomCommands(encoder, candidate, sourceBindings, this.pipelines);
      const next: Cache = { ...candidate, source, options: Object.freeze({ ...options }), sourceBindings };
      this.cache = next;
      if (previous && previous.output !== next.output) releaseBloomResources(this.session, previous);
      return bloomResult(next, true);
    } catch (error) {
      if (candidate && candidate !== previous) releaseBloomResources(this.session, candidate);
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.clearCache();
  }

  private clearCache(): void {
    if (this.cache) releaseBloomResources(this.session, this.cache);
    this.cache = undefined;
  }
  private assertReady(): void {
    if (this.session.state !== "ready") throw new Error("GPU session is not ready for bloom.");
  }
  private assertUsable(): void {
    if (this.disposed) throw new Error("Bloom pass is disposed.");
    if (this.session.state !== "ready") { this.clearCache(); throw new Error("GPU session is not ready for bloom."); }
  }
}

function encodePass(
  encoder: GPUCommandEncoder,
  pipeline: GPUComputePipeline,
  binding: GPUBindGroup,
  width: number,
  height: number,
  label: string,
): void {
  const pass = encoder.beginComputePass({ label });
  pass.setPipeline(pipeline); pass.setBindGroup(0, binding);
  pass.dispatchWorkgroups(Math.ceil(width / BLOOM_WORKGROUP_SIZE), Math.ceil(height / BLOOM_WORKGROUP_SIZE));
  pass.end();
}

function encodeBloomCommands(
  encoder: GPUCommandEncoder,
  allocation: BloomAllocation,
  sourceBindings: Readonly<{ extract: GPUBindGroup; composite: GPUBindGroup }>,
  pipelines: Pipelines,
): void {
  const levels = allocation.levels, top = levels[0]!;
  encodePass(encoder, pipelines.extract, sourceBindings.extract, top.width, top.height, "Deep bloom threshold extract");
  for (let index = 1; index < levels.length; index += 1) {
    const level = levels[index]!;
    encodePass(encoder, pipelines.downsample, allocation.internalBindings.downsample[index - 1]!,
      level.width, level.height, `Deep bloom downsample ${index}`);
  }
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index]!;
    encodePass(encoder, pipelines.horizontal, allocation.internalBindings.horizontal[index]!,
      level.width, level.height, `Deep bloom horizontal ${index}`);
    encodePass(encoder, pipelines.vertical, allocation.internalBindings.vertical[index]!,
      level.width, level.height, `Deep bloom vertical ${index}`);
  }
  for (let index = levels.length - 2; index >= 0; index -= 1) {
    const level = levels[index]!;
    encodePass(encoder, pipelines.upsample, allocation.internalBindings.upsample[index]!,
      level.width, level.height, `Deep bloom upsample ${index}`);
  }
  encodePass(encoder, pipelines.composite, sourceBindings.composite, allocation.width, allocation.height, "Deep bloom HDR composite");
}

function validateRequest(device: GPUDevice, source: BloomSource, options: BloomOptions) {
  if (source.colorEncoding !== "linear-hdr") throw new Error("Bloom requires explicit linear HDR color.");
  if (!Number.isSafeInteger(source.revision) || source.revision < 0) throw new Error("Bloom revision must be a nonnegative safe integer.");
  validateTexture(source.color);
  if (source.color.width > device.limits.maxTextureDimension2D || source.color.height > device.limits.maxTextureDimension2D) {
    throw new Error("Bloom source dimensions exceed device limits.");
  }
  validateBloomOptions(options);
  const sizes = bloomPyramidSizes(source.color.width, source.color.height, options.maxLevels);
  if (Math.ceil(source.color.width / BLOOM_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension
    || Math.ceil(source.color.height / BLOOM_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension) {
    throw new Error("Bloom dispatch exceeds device workgroup limits.");
  }
  return sizes;
}

function validateTexture(texture: GPUTexture): void {
  if (texture.format !== BLOOM_COLOR_FORMAT) throw new Error(`Bloom color format must be ${BLOOM_COLOR_FORMAT}.`);
  if (texture.dimension !== "2d" || texture.depthOrArrayLayers !== 1 || texture.sampleCount !== 1) {
    throw new Error("Bloom color must be a non-multisampled single-layer 2D texture.");
  }
  if ((texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0) throw new Error("Bloom color requires TEXTURE_BINDING usage.");
  if (!Number.isInteger(texture.width) || !Number.isInteger(texture.height) || texture.width < 1 || texture.height < 1) {
    throw new Error("Bloom color dimensions must be positive integers.");
  }
}

function sameSource(left: BloomSource, right: BloomSource): boolean {
  return left.revision === right.revision && left.color === right.color;
}
function sameOptions(left: BloomOptions, right: BloomOptions): boolean {
  return left.threshold === right.threshold && left.softKnee === right.softKnee
    && left.intensity === right.intensity && left.maxLevels === right.maxLevels;
}
function sameLevelSizes(left: readonly BloomLevelSizeLike[], right: readonly BloomLevelSizeLike[]): boolean {
  return left.length === right.length && left.every((level, index) => level.width === right[index]!.width && level.height === right[index]!.height);
}
interface BloomLevelSizeLike { readonly width: number; readonly height: number }

function bloomResult(cache: Cache, updated: boolean): BloomResult {
  const levels = Object.freeze(cache.levels.map(level => Object.freeze({ width: level.width, height: level.height })));
  return Object.freeze({ texture: cache.output, format: BLOOM_COLOR_FORMAT, width: cache.width, height: cache.height,
    revision: cache.source.revision, updated, colorEncoding: "linear-hdr", levels, passCount: levels.length * 4 });
}
