/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";

export const HI_Z_WORKGROUP_SIZE = 8;
export const HI_Z_OUTPUT_FORMAT = "r32float" as const satisfies GPUTextureFormat;
export type HiZReduction = "conservative" | "min" | "max";
export type HiZResolvedReduction = Exclude<HiZReduction, "conservative">;

export interface HiZSource {
  /** Borrowed depth32float texture. Ownership remains with the caller. */
  readonly texture: GPUTexture;
  /** Monotonic content revision for this pyramid instance. */
  readonly revision: number;
}

export interface HiZOptions {
  /** Required so callers cannot accidentally apply standard-Z reduction to reversed depth. */
  readonly reversedZ: boolean;
  readonly reduction?: HiZReduction;
  /** Defaults to the complete chain down to 1x1. */
  readonly mipLevelCount?: number;
}

export interface HiZLevel {
  readonly level: number;
  readonly width: number;
  readonly height: number;
  readonly view: GPUTextureView;
}

export interface HiZResult {
  /** Borrowed until resize, dispose, or device loss. */
  readonly texture: GPUTexture;
  readonly format: typeof HI_Z_OUTPUT_FORMAT;
  readonly width: number;
  readonly height: number;
  readonly mipLevelCount: number;
  readonly levels: readonly HiZLevel[];
  readonly sourceRevision: number;
  readonly reversedZ: boolean;
  readonly reduction: HiZResolvedReduction;
  /** False only when the exact source revision and options were already encoded. */
  readonly updated: boolean;
}

interface PyramidAllocation {
  readonly texture: GPUTexture;
  readonly levels: readonly HiZLevel[];
  readonly reduceBindings: readonly GPUBindGroup[];
  readonly width: number;
  readonly height: number;
  readonly mipLevelCount: number;
}

interface CachedPyramid extends PyramidAllocation {
  readonly sourceTexture: GPUTexture;
  readonly sourceRevision: number;
  readonly copyBinding: GPUBindGroup;
  readonly reversedZ: boolean;
  readonly reduction: HiZResolvedReduction;
}

export const HI_Z_COPY_WGSL = /* wgsl */ `
@group(0) @binding(0) var sourceDepth: texture_depth_2d;
@group(0) @binding(1) var targetMip: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn copyDepth(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(targetMip);
  if (id.x >= size.x || id.y >= size.y) { return; }
  textureStore(targetMip, id.xy, vec4<f32>(textureLoad(sourceDepth, vec2<i32>(id.xy), 0), 0.0, 0.0, 0.0));
}
`;

export const HI_Z_REDUCE_WGSL = /* wgsl */ `
override REDUCE_MAX: bool = true;
@group(0) @binding(0) var sourceMip: texture_2d<f32>;
@group(0) @binding(1) var targetMip: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn reduceDepth(@builtin(global_invocation_id) id: vec3<u32>) {
  let targetSize = textureDimensions(targetMip);
  if (id.x >= targetSize.x || id.y >= targetSize.y) { return; }
  let sourceSize = textureDimensions(sourceMip);
  let begin = id.xy * sourceSize / targetSize;
  let end = ((id.xy + vec2<u32>(1u)) * sourceSize + targetSize - vec2<u32>(1u)) / targetSize;
  var value = textureLoad(sourceMip, vec2<i32>(begin), 0).x;
  for (var y = begin.y; y < end.y; y++) {
    for (var x = begin.x; x < end.x; x++) {
      let sampleDepth = textureLoad(sourceMip, vec2<i32>(i32(x), i32(y)), 0).x;
      value = select(min(value, sampleDepth), max(value, sampleDepth), REDUCE_MAX);
    }
  }
  textureStore(targetMip, id.xy, vec4<f32>(value, 0.0, 0.0, 0.0));
}
`;

/** Reusable compute encoder for a single depth attachment and its monotonic revisions. */
export class HiZPyramid {
  private readonly copyLayout: GPUBindGroupLayout;
  private readonly reduceLayout: GPUBindGroupLayout;
  private readonly copyPipeline: GPUComputePipeline;
  private readonly minPipeline: GPUComputePipeline;
  private readonly maxPipeline: GPUComputePipeline;
  private cache: CachedPyramid | undefined;
  private disposed = false;

  constructor(private readonly session: DeviceSession) {
    this.assertSessionReady();
    const device = session.device;
    const copyModule = device.createShaderModule({ label: "Deep Hi-Z depth copy WGSL", code: HI_Z_COPY_WGSL });
    const reduceModule = device.createShaderModule({ label: "Deep Hi-Z reduction WGSL", code: HI_Z_REDUCE_WGSL });
    this.copyLayout = device.createBindGroupLayout({ label: "Deep Hi-Z depth copy layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth", viewDimension: "2d", multisampled: false } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: HI_Z_OUTPUT_FORMAT, viewDimension: "2d" } },
    ] });
    this.reduceLayout = device.createBindGroupLayout({ label: "Deep Hi-Z reduction layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float", viewDimension: "2d", multisampled: false } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: HI_Z_OUTPUT_FORMAT, viewDimension: "2d" } },
    ] });
    const copyPipelineLayout = device.createPipelineLayout({ label: "Deep Hi-Z depth copy pipeline layout", bindGroupLayouts: [this.copyLayout] });
    const reducePipelineLayout = device.createPipelineLayout({ label: "Deep Hi-Z reduction pipeline layout", bindGroupLayouts: [this.reduceLayout] });
    this.copyPipeline = device.createComputePipeline({ label: "Deep Hi-Z depth copy pipeline", layout: copyPipelineLayout,
      compute: { module: copyModule, entryPoint: "copyDepth" } });
    this.minPipeline = device.createComputePipeline({ label: "Deep Hi-Z min pipeline", layout: reducePipelineLayout,
      compute: { module: reduceModule, entryPoint: "reduceDepth", constants: { REDUCE_MAX: 0 } } });
    this.maxPipeline = device.createComputePipeline({ label: "Deep Hi-Z max pipeline", layout: reducePipelineLayout,
      compute: { module: reduceModule, entryPoint: "reduceDepth", constants: { REDUCE_MAX: 1 } } });
  }

  get current(): HiZResult | undefined {
    if (this.disposed || this.session.state !== "ready" || !this.cache) return undefined;
    return this.result(this.cache, false);
  }

  encode(encoder: GPUCommandEncoder, source: HiZSource, options: HiZOptions): HiZResult {
    this.assertReady();
    const descriptor = validateRequest(this.session.device, source, options);
    const previous = this.cache;
    if (previous && source.revision < previous.sourceRevision) throw new Error("Stale Hi-Z source revision.");
    if (previous && source.revision === previous.sourceRevision && source.texture !== previous.sourceTexture) {
      throw new Error("Hi-Z source texture changed without a revision.");
    }
    if (previous && source.revision === previous.sourceRevision
      && previous.width === descriptor.width && previous.height === descriptor.height
      && previous.mipLevelCount === descriptor.mipLevelCount
      && previous.reversedZ === descriptor.reversedZ && previous.reduction === descriptor.reduction) {
      return this.result(previous, false);
    }

    let candidate: PyramidAllocation | undefined;
    const reusable = previous && previous.width === descriptor.width && previous.height === descriptor.height
      && previous.mipLevelCount === descriptor.mipLevelCount;
    try {
      candidate = reusable ? previous : this.allocate(descriptor.width, descriptor.height, descriptor.mipLevelCount);
      let copyBinding = reusable && source.texture === previous.sourceTexture ? previous.copyBinding : undefined;
      if (!copyBinding) {
        const sourceView = source.texture.createView({ label: "Deep Hi-Z source depth view", format: "depth32float", dimension: "2d",
          aspect: "depth-only", baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 });
        copyBinding = this.session.device.createBindGroup({ label: "Deep Hi-Z depth copy bindings", layout: this.copyLayout, entries: [
          { binding: 0, resource: sourceView }, { binding: 1, resource: candidate.levels[0]!.view },
        ] });
      }
      this.encodePasses(encoder, candidate, copyBinding, descriptor.reduction);
      const next: CachedPyramid = { ...candidate, sourceTexture: source.texture, sourceRevision: source.revision,
        copyBinding, reversedZ: descriptor.reversedZ, reduction: descriptor.reduction };
      this.cache = next;
      if (previous && previous.texture !== next.texture) this.session.release(previous.texture);
      return this.result(next, true);
    } catch (error) {
      if (candidate && candidate !== previous) this.session.release(candidate.texture);
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.cache) this.session.release(this.cache.texture);
    this.cache = undefined;
  }

  private allocate(width: number, height: number, mipLevelCount: number): PyramidAllocation {
    const texture = this.session.own(this.session.device.createTexture({ label: "Deep Hi-Z pyramid",
      size: { width, height, depthOrArrayLayers: 1 }, dimension: "2d", format: HI_Z_OUTPUT_FORMAT, mipLevelCount,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC }));
    try {
      const levels = Array.from({ length: mipLevelCount }, (_, level): HiZLevel => ({
        level, width: mipDimension(width, level), height: mipDimension(height, level),
        view: texture.createView({ label: `Deep Hi-Z mip ${level}`, format: HI_Z_OUTPUT_FORMAT, dimension: "2d",
          baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 }),
      }));
      const reduceBindings = levels.slice(1).map((target, index) => this.session.device.createBindGroup({
        label: `Deep Hi-Z reduction bindings ${target.level}`, layout: this.reduceLayout, entries: [
          { binding: 0, resource: levels[index]!.view }, { binding: 1, resource: target.view },
        ],
      }));
      return { texture, levels: Object.freeze(levels), reduceBindings: Object.freeze(reduceBindings), width, height, mipLevelCount };
    } catch (error) { this.session.release(texture); throw error; }
  }

  private encodePasses(encoder: GPUCommandEncoder, pyramid: PyramidAllocation, copyBinding: GPUBindGroup,
    reduction: HiZResolvedReduction): void {
    const copy = encoder.beginComputePass({ label: "Deep Hi-Z copy depth" });
    copy.setPipeline(this.copyPipeline); copy.setBindGroup(0, copyBinding);
    copy.dispatchWorkgroups(dispatchCount(pyramid.width), dispatchCount(pyramid.height)); copy.end();
    const pipeline = reduction === "max" ? this.maxPipeline : this.minPipeline;
    for (let level = 1; level < pyramid.mipLevelCount; level++) {
      const target = pyramid.levels[level]!;
      const pass = encoder.beginComputePass({ label: `Deep Hi-Z reduce mip ${level}` });
      pass.setPipeline(pipeline); pass.setBindGroup(0, pyramid.reduceBindings[level - 1]!);
      pass.dispatchWorkgroups(dispatchCount(target.width), dispatchCount(target.height)); pass.end();
    }
  }

  private result(cache: CachedPyramid, updated: boolean): HiZResult {
    return Object.freeze({ texture: cache.texture, format: HI_Z_OUTPUT_FORMAT, width: cache.width, height: cache.height,
      mipLevelCount: cache.mipLevelCount, levels: cache.levels, sourceRevision: cache.sourceRevision,
      reversedZ: cache.reversedZ, reduction: cache.reduction, updated });
  }

  private assertSessionReady(): void {
    if (this.session.state !== "ready") throw new Error("GPU session is not ready for Hi-Z.");
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("Hi-Z pyramid is disposed.");
    if (this.session.state !== "ready") {
      if (this.cache) this.session.release(this.cache.texture);
      this.cache = undefined;
      throw new Error("GPU session is not ready for Hi-Z.");
    }
  }
}

interface ValidatedRequest {
  readonly width: number;
  readonly height: number;
  readonly mipLevelCount: number;
  readonly reversedZ: boolean;
  readonly reduction: HiZResolvedReduction;
}

function validateRequest(device: GPUDevice, source: HiZSource, options: HiZOptions): ValidatedRequest {
  const texture = source.texture;
  if (!Number.isSafeInteger(source.revision) || source.revision < 0) throw new Error("Hi-Z source revision must be a nonnegative safe integer.");
  if (texture.format !== "depth32float") throw new Error("Hi-Z source format must be depth32float.");
  if (texture.dimension !== "2d" || texture.depthOrArrayLayers !== 1) throw new Error("Hi-Z source must be a single-layer 2D texture.");
  if (texture.sampleCount !== 1) throw new Error("Hi-Z source must not be multisampled.");
  if ((texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0) throw new Error("Hi-Z source requires TEXTURE_BINDING usage.");
  const width = texture.width, height = texture.height;
  const limit = device.limits.maxTextureDimension2D;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > limit || height > limit) {
    throw new Error("Hi-Z source dimensions are outside device limits.");
  }
  const fullMipCount = hiZMipLevelCount(width, height), requested = options.mipLevelCount ?? fullMipCount;
  if (!Number.isInteger(requested) || requested < 1 || requested > fullMipCount) throw new Error("Hi-Z mipLevelCount is outside the complete chain.");
  if (typeof options.reversedZ !== "boolean") throw new Error("Hi-Z reversedZ must be declared explicitly.");
  const reduction = options.reduction ?? "conservative", reversedZ = options.reversedZ;
  if (reduction !== "conservative" && reduction !== "min" && reduction !== "max") throw new Error("Invalid Hi-Z reduction mode.");
  const resolved = reduction === "conservative" ? (reversedZ ? "min" : "max") : reduction;
  const dispatchLimit = device.limits.maxComputeWorkgroupsPerDimension;
  for (let level = 0; level < requested; level++) {
    if (dispatchCount(mipDimension(width, level)) > dispatchLimit || dispatchCount(mipDimension(height, level)) > dispatchLimit) {
      throw new Error("Hi-Z dispatch exceeds device workgroup limits.");
    }
  }
  return { width, height, mipLevelCount: requested, reversedZ, reduction: resolved };
}

export function hiZMipLevelCount(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Hi-Z dimensions must be positive safe integers.");
  }
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

function mipDimension(size: number, level: number): number { return Math.max(1, Math.floor(size / 2 ** level)); }
function dispatchCount(size: number): number { return Math.ceil(size / HI_Z_WORKGROUP_SIZE); }
