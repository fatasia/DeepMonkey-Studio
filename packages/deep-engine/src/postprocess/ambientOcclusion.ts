/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { validateAmbientOcclusionOptions } from "./ambientOcclusionCpu.js";
import { AMBIENT_OCCLUSION_DEPTH_FORMAT, AMBIENT_OCCLUSION_NORMAL_FORMAT, AMBIENT_OCCLUSION_OUTPUT_FORMAT,
  type AmbientOcclusionOptions, type AmbientOcclusionResult, type AmbientOcclusionSource } from "./ambientOcclusionTypes.js";
import { AMBIENT_OCCLUSION_BLUR_WGSL, AMBIENT_OCCLUSION_EVALUATE_WGSL,
  AMBIENT_OCCLUSION_SAMPLE_COUNT, AMBIENT_OCCLUSION_WORKGROUP_SIZE } from "./ambientOcclusionWgsl.js";

const PARAMETER_BYTES = 48;
interface Allocation {
  readonly width: number; readonly height: number;
  readonly raw: GPUTexture; readonly temporary: GPUTexture; readonly output: GPUTexture;
  readonly rawView: GPUTextureView; readonly temporaryView: GPUTextureView; readonly outputView: GPUTextureView;
  readonly parameters: GPUBuffer;
}
interface Cache extends Allocation {
  readonly source: AmbientOcclusionSource; readonly options: AmbientOcclusionOptions;
  readonly evaluateBinding: GPUBindGroup; readonly horizontalBinding: GPUBindGroup; readonly verticalBinding: GPUBindGroup;
}
interface Request { readonly sourceWidth: number; readonly sourceHeight: number; readonly width: number; readonly height: number }

export function ambientOcclusionHalfSize(width: number, height: number): readonly [number, number] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error("AO source dimensions must be positive safe integers.");
  return [Math.ceil(width / 2), Math.ceil(height / 2)];
}

/** Half-resolution view-space AO with two-pass bilateral edge-preserving blur. */
export class AmbientOcclusionPass {
  private readonly evaluateLayout: GPUBindGroupLayout; private readonly blurLayout: GPUBindGroupLayout;
  private readonly evaluatePipeline: GPUComputePipeline; private readonly horizontalPipeline: GPUComputePipeline; private readonly verticalPipeline: GPUComputePipeline;
  private cache: Cache | undefined; private disposed = false;

  constructor(private readonly session: DeviceSession) {
    this.assertReady(); const device = session.device;
    const evaluateModule = device.createShaderModule({ label: "Deep ambient occlusion WGSL", code: AMBIENT_OCCLUSION_EVALUATE_WGSL });
    const blurModule = device.createShaderModule({ label: "Deep ambient occlusion bilateral blur WGSL", code: AMBIENT_OCCLUSION_BLUR_WGSL });
    this.evaluateLayout = device.createBindGroupLayout({ label: "Deep ambient occlusion layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: PARAMETER_BYTES } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: AMBIENT_OCCLUSION_OUTPUT_FORMAT } },
    ] });
    this.blurLayout = device.createBindGroupLayout({ label: "Deep ambient occlusion bilateral layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: PARAMETER_BYTES } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: AMBIENT_OCCLUSION_OUTPUT_FORMAT } },
    ] });
    const evaluatePipelineLayout = device.createPipelineLayout({ label: "Deep ambient occlusion pipeline layout", bindGroupLayouts: [this.evaluateLayout] });
    const blurPipelineLayout = device.createPipelineLayout({ label: "Deep ambient occlusion bilateral pipeline layout", bindGroupLayouts: [this.blurLayout] });
    this.evaluatePipeline = device.createComputePipeline({ label: "Deep half-resolution ambient occlusion pipeline", layout: evaluatePipelineLayout,
      compute: { module: evaluateModule, entryPoint: "evaluateAo" } });
    this.horizontalPipeline = device.createComputePipeline({ label: "Deep ambient occlusion horizontal bilateral pipeline", layout: blurPipelineLayout,
      compute: { module: blurModule, entryPoint: "bilateralBlur", constants: { HORIZONTAL: 1 } } });
    this.verticalPipeline = device.createComputePipeline({ label: "Deep ambient occlusion vertical bilateral pipeline", layout: blurPipelineLayout,
      compute: { module: blurModule, entryPoint: "bilateralBlur", constants: { HORIZONTAL: 0 } } });
  }

  get current(): AmbientOcclusionResult | undefined {
    return !this.disposed && this.session.state === "ready" && this.cache ? this.result(this.cache, false) : undefined;
  }

  encode(encoder: GPUCommandEncoder, source: AmbientOcclusionSource, options: AmbientOcclusionOptions): AmbientOcclusionResult {
    this.assertUsable(); const request = validateRequest(this.session.device, source, options), previous = this.cache;
    if (previous && source.revision < previous.source.revision) throw new Error("Stale ambient occlusion source revision.");
    if (previous && source.revision === previous.source.revision
      && (source.depth !== previous.source.depth || source.normal !== previous.source.normal)) throw new Error("Ambient occlusion source textures changed without a revision.");
    if (previous && sameSource(previous.source, source) && sameOptions(previous.options, options)) return this.result(previous, false);
    const reusable = previous && previous.width === request.width && previous.height === request.height;
    let candidate: Allocation | undefined;
    try {
      candidate = reusable ? previous : this.allocate(request.width, request.height);
      const bindings = reusable && source.depth === previous.source.depth && source.normal === previous.source.normal
        ? { evaluate: previous.evaluateBinding, horizontal: previous.horizontalBinding, vertical: previous.verticalBinding }
        : this.bind(candidate, source);
      this.session.device.queue.writeBuffer(candidate.parameters, 0, packParameters(request, options));
      this.encodePass(encoder, candidate, bindings);
      const next: Cache = { ...candidate, source, options: Object.freeze({ ...options }), evaluateBinding: bindings.evaluate,
        horizontalBinding: bindings.horizontal, verticalBinding: bindings.vertical };
      this.cache = next; if (previous && previous.output !== next.output) this.release(previous);
      return this.result(next, true);
    } catch (error) { if (candidate && candidate !== previous) this.release(candidate); throw error; }
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; if (this.cache) this.release(this.cache); this.cache = undefined; }

  private allocate(width: number, height: number): Allocation {
    const textures: GPUTexture[] = [], device = this.session.device;
    const texture = (label: string, usage: GPUTextureUsageFlags): GPUTexture => {
      const value = this.session.own(device.createTexture({ label, size: { width, height, depthOrArrayLayers: 1 }, dimension: "2d",
        format: AMBIENT_OCCLUSION_OUTPUT_FORMAT, usage })); textures.push(value); return value;
    };
    let parameters: GPUBuffer | undefined;
    try {
      const raw = texture("Deep half-resolution raw ambient occlusion", GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);
      const temporary = texture("Deep ambient occlusion bilateral temporary", GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);
      const output = texture("Deep ambient occlusion output", GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC);
      parameters = this.session.own(device.createBuffer({ label: "Deep ambient occlusion parameters", size: PARAMETER_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
      return { width, height, raw, temporary, output, rawView: raw.createView(), temporaryView: temporary.createView(), outputView: output.createView(), parameters };
    } catch (error) {
      if (parameters) this.session.release(parameters); for (const value of textures) this.session.release(value); throw error;
    }
  }

  private bind(allocation: Allocation, source: AmbientOcclusionSource) {
    const depth = source.depth.createView({ format: AMBIENT_OCCLUSION_DEPTH_FORMAT, dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 });
    const normal = source.normal.createView({ format: AMBIENT_OCCLUSION_NORMAL_FORMAT, dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 });
    const viewEntry = (binding: number, resource: GPUTextureView): GPUBindGroupEntry => ({ binding, resource });
    const bufferEntry = (binding: number, buffer: GPUBuffer): GPUBindGroupEntry => ({ binding, resource: { buffer } });
    const prefix = [viewEntry(0, depth), viewEntry(1, normal), bufferEntry(2, allocation.parameters)];
    const evaluate = this.session.device.createBindGroup({ label: "Deep ambient occlusion bindings", layout: this.evaluateLayout,
      entries: [...prefix, viewEntry(3, allocation.rawView)] });
    const horizontal = this.session.device.createBindGroup({ label: "Deep ambient occlusion horizontal bindings", layout: this.blurLayout,
      entries: [...prefix, viewEntry(3, allocation.rawView), viewEntry(4, allocation.temporaryView)] });
    const vertical = this.session.device.createBindGroup({ label: "Deep ambient occlusion vertical bindings", layout: this.blurLayout,
      entries: [...prefix, viewEntry(3, allocation.temporaryView), viewEntry(4, allocation.outputView)] });
    return { evaluate, horizontal, vertical };
  }

  private encodePass(encoder: GPUCommandEncoder, allocation: Allocation,
    bindings: { evaluate: GPUBindGroup; horizontal: GPUBindGroup; vertical: GPUBindGroup }): void {
    const x = Math.ceil(allocation.width / AMBIENT_OCCLUSION_WORKGROUP_SIZE), y = Math.ceil(allocation.height / AMBIENT_OCCLUSION_WORKGROUP_SIZE);
    for (const [label, pipeline, binding] of [["evaluate", this.evaluatePipeline, bindings.evaluate],
      ["horizontal bilateral", this.horizontalPipeline, bindings.horizontal], ["vertical bilateral", this.verticalPipeline, bindings.vertical]] as const) {
      const pass = encoder.beginComputePass({ label: `Deep ambient occlusion ${label}` });
      pass.setPipeline(pipeline); pass.setBindGroup(0, binding); pass.dispatchWorkgroups(x, y); pass.end();
    }
  }

  private release(allocation: Allocation): void {
    this.session.release(allocation.parameters); this.session.release(allocation.raw);
    this.session.release(allocation.temporary); this.session.release(allocation.output);
  }
  private result(cache: Cache, updated: boolean): AmbientOcclusionResult {
    return Object.freeze({ texture: cache.output, format: AMBIENT_OCCLUSION_OUTPUT_FORMAT, width: cache.width, height: cache.height,
      sourceWidth: cache.source.depth.width, sourceHeight: cache.source.depth.height, revision: cache.source.revision, updated,
      depthEncoding: "linear-view-depth-positive", sampleCount: AMBIENT_OCCLUSION_SAMPLE_COUNT });
  }
  private assertReady(): void { if (this.session.state !== "ready") throw new Error("GPU session is not ready for ambient occlusion."); }
  private assertUsable(): void {
    if (this.disposed) throw new Error("Ambient occlusion pass is disposed.");
    if (this.session.state !== "ready") { if (this.cache) this.release(this.cache); this.cache = undefined; throw new Error("GPU session is not ready for ambient occlusion."); }
  }
}

function validateRequest(device: GPUDevice, source: AmbientOcclusionSource, options: AmbientOcclusionOptions): Request {
  if (source.depthEncoding !== "linear-view-depth-positive") throw new Error("AO requires explicit positive linear view depth; standard/reversed device depth must be linearized first.");
  if (source.normalSpace !== "view") throw new Error("AO normals must be declared in view space.");
  if (!Number.isSafeInteger(source.revision) || source.revision < 0) throw new Error("AO source revision must be a nonnegative safe integer.");
  validateTexture(source.depth, AMBIENT_OCCLUSION_DEPTH_FORMAT, "depth"); validateTexture(source.normal, AMBIENT_OCCLUSION_NORMAL_FORMAT, "normal");
  if (source.depth.width !== source.normal.width || source.depth.height !== source.normal.height) throw new Error("AO depth and normal dimensions must match.");
  if (source.depth.width > device.limits.maxTextureDimension2D || source.depth.height > device.limits.maxTextureDimension2D) throw new Error("AO source dimensions exceed device limits.");
  validateAmbientOcclusionOptions(options); const [width, height] = ambientOcclusionHalfSize(source.depth.width, source.depth.height);
  if (Math.ceil(width / AMBIENT_OCCLUSION_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension
    || Math.ceil(height / AMBIENT_OCCLUSION_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension) throw new Error("AO dispatch exceeds device workgroup limits.");
  return { sourceWidth: source.depth.width, sourceHeight: source.depth.height, width, height };
}
function validateTexture(texture: GPUTexture, format: GPUTextureFormat, name: string): void {
  if (texture.format !== format) throw new Error(`AO ${name} format must be ${format}.`);
  if (texture.dimension !== "2d" || texture.depthOrArrayLayers !== 1 || texture.sampleCount !== 1) throw new Error(`AO ${name} must be a non-multisampled single-layer 2D texture.`);
  if ((texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0) throw new Error(`AO ${name} requires TEXTURE_BINDING usage.`);
  if (!Number.isInteger(texture.width) || !Number.isInteger(texture.height) || texture.width < 1 || texture.height < 1) throw new Error(`AO ${name} dimensions must be positive integers.`);
}
function packParameters(request: Request, options: AmbientOcclusionOptions): ArrayBuffer {
  const buffer = new ArrayBuffer(PARAMETER_BYTES), uints = new Uint32Array(buffer), floats = new Float32Array(buffer);
  uints.set([request.sourceWidth, request.sourceHeight, request.width, request.height], 0);
  floats.set([Math.tan(options.verticalFovRadians * 0.5), request.sourceWidth / request.sourceHeight, options.radius, options.thickness], 4);
  floats.set([options.power, 0, 0, 0], 8); return buffer;
}
function sameSource(left: AmbientOcclusionSource, right: AmbientOcclusionSource): boolean {
  return left.revision === right.revision && left.depth === right.depth && left.normal === right.normal;
}
function sameOptions(left: AmbientOcclusionOptions, right: AmbientOcclusionOptions): boolean {
  return left.verticalFovRadians === right.verticalFovRadians && left.radius === right.radius && left.thickness === right.thickness && left.power === right.power;
}
