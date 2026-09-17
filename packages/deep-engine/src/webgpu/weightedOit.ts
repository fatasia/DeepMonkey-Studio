/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";
import type { PbrTransientTextureHandle, PbrTransientTexturePool } from "./pbrTransientTexturePool.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";
import { WEIGHTED_OIT_COMPOSITE_WGSL, WEIGHTED_OIT_FRAGMENT_WGSL } from "./weightedOitWgsl.js";
import {
  WEIGHTED_OIT_ACCUMULATION_FORMAT,
  WEIGHTED_OIT_REVEALAGE_FORMAT,
  type WeightedOitCompositeOptions,
  type WeightedOitCompositeResult,
  type WeightedOitTargets,
} from "./weightedOitTypes.js";

interface Allocation extends WeightedOitTargets { readonly pooled?: readonly [PbrTransientTextureHandle, PbrTransientTextureHandle] }

/** Blend states for fragment shaders returning DeepWeightedOitOutput. */
export function weightedOitColorTargets(): readonly GPUColorTargetState[] {
  const additive: GPUBlendState = {
    color: { operation: "add", srcFactor: "one", dstFactor: "one" },
    alpha: { operation: "add", srcFactor: "one", dstFactor: "one" },
  };
  const revealage: GPUBlendState = {
    color: { operation: "add", srcFactor: "zero", dstFactor: "one-minus-src" },
    alpha: { operation: "add", srcFactor: "zero", dstFactor: "one-minus-src" },
  };
  return Object.freeze([
    Object.freeze({ format: WEIGHTED_OIT_ACCUMULATION_FORMAT, blend: additive, writeMask: GPUColorWrite.ALL }),
    Object.freeze({ format: WEIGHTED_OIT_REVEALAGE_FORMAT, blend: revealage, writeMask: GPUColorWrite.RED }),
  ]);
}

/** Owns order-independent transparency accumulation targets and the linear-HDR composite pass. */
export class WeightedOitPass {
  private readonly compositeLayout: GPUBindGroupLayout;
  private readonly compositeModule: GPUShaderModule;
  private readonly pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  private allocation: Allocation | undefined;
  private generation = 0;
  private disposed = false;

  constructor(private readonly session: DeviceSession, private readonly pool?: PbrTransientTexturePool) {
    this.assertSessionReady();
    const device = session.device;
    this.compositeModule = device.createShaderModule({ label: "Deep weighted OIT composite WGSL", code: WEIGHTED_OIT_COMPOSITE_WGSL });
    this.compositeLayout = device.createBindGroupLayout({ label: "Deep weighted OIT composite layout", entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "2d", multisampled: false } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "2d", multisampled: false } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "2d", multisampled: false } },
    ] });
  }

  get current(): WeightedOitTargets | undefined {
    if (this.disposed || this.session.state !== "ready") return undefined;
    return this.allocation;
  }

  resize(width: number, height: number): WeightedOitTargets {
    this.assertReady();
    validateSize(this.session.device, width, height);
    if (this.allocation?.width === width && this.allocation.height === height) return this.allocation;
    const previous = this.allocation;
    const candidate = this.allocate(width, height, this.generation + 1);
    this.allocation = candidate;
    this.generation = candidate.generation;
    if (previous) this.release(previous);
    return candidate;
  }

  accumulationAttachments(loadOp: GPULoadOp = "clear"): readonly [GPURenderPassColorAttachment, GPURenderPassColorAttachment] {
    this.assertReady();
    const targets = this.requireAllocation();
    if (loadOp !== "clear" && loadOp !== "load") throw new Error("Weighted OIT accumulation loadOp must be clear or load.");
    return Object.freeze([
      Object.freeze({ view: targets.accumulationView, loadOp, storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }),
      Object.freeze({ view: targets.revealageView, loadOp, storeOp: "store", clearValue: { r: 1, g: 1, b: 1, a: 1 } }),
    ]);
  }

  encodeComposite(encoder: GPUCommandEncoder, opaqueView: GPUTextureView, destinationView: GPUTextureView,
    options: WeightedOitCompositeOptions): WeightedOitCompositeResult {
    this.assertReady();
    const targets = this.requireAllocation();
    const outputFormat = validateOutputFormat(options.outputFormat);
    const binding = this.session.device.createBindGroup({ label: "Deep weighted OIT composite bindings", layout: this.compositeLayout, entries: [
      { binding: 0, resource: opaqueView }, { binding: 1, resource: targets.accumulationView }, { binding: 2, resource: targets.revealageView },
    ] });
    const loadOp = options.loadOp ?? "clear";
    if (loadOp !== "clear" && loadOp !== "load") throw new Error("Weighted OIT composite loadOp must be clear or load.");
    const pipeline = this.pipeline(outputFormat);
    const pass = encoder.beginRenderPass({ label: "Deep weighted OIT composite", colorAttachments: [{
      view: destinationView, loadOp, storeOp: "store", clearValue: options.clearColor ?? { r: 0, g: 0, b: 0, a: 0 },
    }] });
    try { pass.setPipeline(pipeline); pass.setBindGroup(0, binding); pass.draw(3); }
    finally { pass.end(); }
    return Object.freeze({ width: targets.width, height: targets.height, generation: targets.generation, outputFormat });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const allocation = this.allocation;
    this.allocation = undefined; this.pipelines.clear();
    if (allocation) this.release(allocation);
  }

  /** Returns production frame targets to the shared pool; encoded commands retain queue-ordered use. */
  releaseFrame(): void {
    if (!this.pool) return;
    const allocation = this.allocation; this.allocation = undefined;
    if (allocation) this.release(allocation);
  }

  private allocate(width: number, height: number, generation: number): Allocation {
    if (this.pool) {
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
      const accumulation = this.pool.acquire({ resourceId: "oit-accumulation", format: WEIGHTED_OIT_ACCUMULATION_FORMAT,
        width, height, sampleCount: 1, usage });
      const revealage = this.pool.acquire({ resourceId: "oit-revealage", format: WEIGHTED_OIT_REVEALAGE_FORMAT,
        width, height, sampleCount: 1, usage });
      return Object.freeze({ width, height, generation, accumulationTexture: accumulation.texture,
        accumulationView: accumulation.view, revealageTexture: revealage.texture, revealageView: revealage.view,
        pooled: Object.freeze([accumulation, revealage] as const) });
    }
    const created: GPUTexture[] = [];
    const texture = (label: string, format: GPUTextureFormat): GPUTexture => {
      const value = this.session.own(this.session.device.createTexture({ label, size: { width, height, depthOrArrayLayers: 1 },
        dimension: "2d", format, mipLevelCount: 1, sampleCount: 1,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC }));
      created.push(value); return value;
    };
    try {
      const accumulationTexture = texture("Deep weighted OIT accumulation", WEIGHTED_OIT_ACCUMULATION_FORMAT);
      const revealageTexture = texture("Deep weighted OIT revealage", WEIGHTED_OIT_REVEALAGE_FORMAT);
      return Object.freeze({ width, height, generation, accumulationTexture,
        accumulationView: accumulationTexture.createView({ label: "Deep weighted OIT accumulation view" }),
        revealageTexture, revealageView: revealageTexture.createView({ label: "Deep weighted OIT revealage view" }) });
    } catch (error) {
      failWithResourceCleanup(error, "Weighted OIT allocation failed.", created.map(value => () => this.session.release(value)));
    }
  }

  private pipeline(format: GPUTextureFormat): GPURenderPipeline {
    const cached = this.pipelines.get(format);
    if (cached) return cached;
    const layout = this.session.device.createPipelineLayout({ label: `Deep weighted OIT ${format} pipeline layout`,
      bindGroupLayouts: [this.compositeLayout] });
    const pipeline = this.session.device.createRenderPipeline({ label: `Deep weighted OIT ${format} composite pipeline`, layout,
      vertex: { module: this.compositeModule, entryPoint: "compositeVertex" },
      fragment: { module: this.compositeModule, entryPoint: "compositeFragment", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" }, multisample: { count: 1 } });
    this.pipelines.set(format, pipeline); return pipeline;
  }

  private requireAllocation(): Allocation {
    if (!this.allocation) throw new Error("Weighted OIT targets must be resized before encoding.");
    return this.allocation;
  }

  private assertSessionReady(): void {
    if (this.session.state !== "ready") throw new Error("GPU session is not ready for weighted OIT.");
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("Weighted OIT pass is disposed.");
    if (this.session.state !== "ready") {
      const allocation = this.allocation;
      this.allocation = undefined; this.pipelines.clear();
      if (allocation) this.release(allocation);
      throw new Error("GPU session is not ready for weighted OIT.");
    }
  }

  private release(allocation: Allocation): void {
    if (allocation.pooled) {
      if (this.pool?.frameOpen) for (const handle of allocation.pooled) this.pool.release(handle);
      return;
    }
    runResourceCleanup("Weighted OIT disposal failed.", [
      () => this.session.release(allocation.accumulationTexture), () => this.session.release(allocation.revealageTexture),
    ]);
  }
}

function validateSize(device: GPUDevice, width: number, height: number): void {
  const limit = device.limits.maxTextureDimension2D;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > limit || height > limit) {
    throw new Error("Weighted OIT dimensions are outside device limits.");
  }
}

function validateOutputFormat(format: GPUTextureFormat): GPUTextureFormat {
  if (typeof format !== "string" || format.length === 0 || format.startsWith("depth") || format.startsWith("stencil")) {
    throw new Error("Weighted OIT output format must be a color format.");
  }
  return format;
}

export { WEIGHTED_OIT_COMPOSITE_WGSL, WEIGHTED_OIT_FRAGMENT_WGSL } from "./weightedOitWgsl.js";
export * from "./weightedOitTypes.js";
