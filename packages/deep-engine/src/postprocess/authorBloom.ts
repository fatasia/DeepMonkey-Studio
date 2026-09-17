import type { DeviceSession } from "../webgpu/deviceSession.js";
import type { PbrTransientTexturePool } from "../webgpu/pbrTransientTexturePool.js";
import type { BloomResult, BloomSource } from "./bloomTypes.js";
import { validateAuthorBloomOptions, validateAuthorBloomSource, type AuthorBloomOptions } from "./authorBloomCpu.js";
import { acquirePooledAuthorBloom, allocateAuthorBloom, bindAuthorBloom, releaseAuthorBloom,
  type AuthorBloomAllocation } from "./authorBloomResources.js";
import { AUTHOR_BLOOM_WGSL } from "./authorBloomWgsl.js";
import { failWithResourceCleanup } from "../webgpu/resourceCleanup.js";
export type { AuthorBloomOptions } from "./authorBloomCpu.js";

interface Cache {
  readonly allocation: AuthorBloomAllocation; readonly source: BloomSource; readonly options: AuthorBloomOptions;
  readonly bindings: readonly GPUBindGroup[];
}

/** Studio's fixed-radius UnrealBloomPass r185 profile, before output tone mapping. */
export class AuthorBloomPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipelines: readonly GPUComputePipeline[];
  private cache: Cache | undefined;
  private pooledParameters: GPUBuffer | undefined;
  private pooledEpoch = -1;
  private pooledCaches: Cache[] = [];
  private pooledSource: BloomSource | undefined;
  private disposed = false;

  constructor(private readonly session: DeviceSession, private readonly pool?: PbrTransientTexturePool) {
    this.assertReady();
    const device = session.device;
    const module = device.createShaderModule({ label: "Deep author bloom r185", code: AUTHOR_BLOOM_WGSL });
    this.layout = device.createBindGroupLayout({ entries: [
      ...Array.from({ length: 6 }, (_, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" as const } })),
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 16 } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
    ] });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const entries = ["extract", ...Array.from({ length: 5 }, (_, index) => [`horizontal${index}`, `vertical${index}`]).flat(), "combine", "composite"];
    this.pipelines = entries.map(entryPoint => device.createComputePipeline({ label: `Deep author bloom ${entryPoint}`,
      layout, compute: { module, entryPoint } }));
  }

  get current(): BloomResult | undefined {
    if (this.disposed || this.pool) return undefined;
    if (this.session.state !== "ready") { this.clear(); return undefined; }
    return this.cache ? result(this.cache, false) : undefined;
  }

  encode(encoder: GPUCommandEncoder, source: BloomSource, options: AuthorBloomOptions): BloomResult {
    this.assertReady(); validateAuthorBloomSource(this.session.device, source); validateAuthorBloomOptions(options);
    if (this.pool) return this.encodePooled(encoder, source, options);
    const previous = this.cache;
    if (previous && source.revision < previous.source.revision) throw new Error("Stale author bloom revision.");
    if (previous && source.revision === previous.source.revision && source.color !== previous.source.color) throw new Error("Author bloom source changed without a revision.");
    // Encoding alone is not a submission guarantee. Always encode again, even for an identical revision.
    const reusable = previous?.allocation.width === source.color.width && previous.allocation.height === source.color.height;
    let allocation: AuthorBloomAllocation | undefined;
    try {
      allocation = reusable ? previous.allocation : allocateAuthorBloom(this.session, this.layout, source.color.width, source.color.height);
      const bindings = reusable && source.color === previous.source.color ? previous.bindings : [
        bindAuthorBloom(this.session.device, this.layout, allocation.parameters, source.color, allocation.bright),
        ...allocation.fixedBindings,
        bindAuthorBloom(this.session.device, this.layout, allocation.parameters, source.color, allocation.output, [allocation.combined]),
      ];
      this.session.device.queue.writeBuffer(allocation.parameters, 0, new Float32Array([options.threshold, options.strength, 0, 0]));
      for (let index = 0; index < this.pipelines.length; index++) {
        const size = index === 12 ? allocation : allocation.levels[index === 0 || index === 11 ? 0 : Math.floor((index - 1) / 2)]!;
        const pass = encoder.beginComputePass({ label: `Deep author bloom ${index}` });
        try {
          pass.setPipeline(this.pipelines[index]!); pass.setBindGroup(0, bindings[index]!);
          pass.dispatchWorkgroups(Math.ceil(size.width / 8), Math.ceil(size.height / 8));
        } finally { pass.end(); }
      }
      const next: Cache = { allocation, source: { ...source }, options: { ...options }, bindings };
      this.cache = next;
      if (previous && previous.allocation !== allocation) releaseAuthorBloom(this.session, previous.allocation);
      return result(next, true);
    } catch (error) {
      failWithResourceCleanup(error, "Author bloom encode failed", allocation && allocation !== previous?.allocation
        && allocation !== this.cache?.allocation ? [() => releaseAuthorBloom(this.session, allocation!)] : []);
    }
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true; this.clear();
      if (this.pooledParameters) this.session.release(this.pooledParameters);
      this.pooledParameters = undefined; this.pooledCaches = []; this.pooledSource = undefined;
    }
  }
  private encodePooled(encoder: GPUCommandEncoder, source: BloomSource, options: AuthorBloomOptions): BloomResult {
    if (!this.pool!.frameOpen) throw new Error("Author bloom transient textures require an open frame scope.");
    const previous = this.pooledSource;
    if (previous && source.revision < previous.revision) throw new Error("Stale author bloom revision.");
    if (previous && source.revision === previous.revision && source.color !== previous.color) {
      throw new Error("Author bloom source changed without a revision.");
    }
    if (this.pooledEpoch !== this.pool!.epoch) { this.pooledEpoch = this.pool!.epoch; this.pooledCaches = []; }
    const acquired = acquirePooledAuthorBloom(this.session, this.pool!, this.layout, this.parameters(),
      source.color.width, source.color.height, this.pooledCaches.map(item => item.allocation));
    try {
      let cache = this.pooledCaches.find(item => item.allocation === acquired.allocation && item.source.color === source.color);
      if (!cache) {
        const bindings = [bindAuthorBloom(this.session.device, this.layout, acquired.allocation.parameters,
          source.color, acquired.allocation.bright), ...acquired.allocation.fixedBindings,
        bindAuthorBloom(this.session.device, this.layout, acquired.allocation.parameters, source.color,
          acquired.allocation.output, [acquired.allocation.combined])];
        cache = { allocation: acquired.allocation, source: { ...source }, options: { ...options }, bindings };
        this.pooledCaches.push(cache); if (this.pooledCaches.length > 8) this.pooledCaches.shift();
      }
      this.session.device.queue.writeBuffer(acquired.allocation.parameters, 0,
        new Float32Array([options.threshold, options.strength, 0, 0]));
      for (let index = 0; index < this.pipelines.length; index++) {
        const size = index === 12 ? acquired.allocation
          : acquired.allocation.levels[index === 0 || index === 11 ? 0 : Math.floor((index - 1) / 2)]!;
        const pass = encoder.beginComputePass({ label: `Deep author bloom ${index}` });
        try { pass.setPipeline(this.pipelines[index]!); pass.setBindGroup(0, cache.bindings[index]!);
          pass.dispatchWorkgroups(Math.ceil(size.width / 8), Math.ceil(size.height / 8)); } finally { pass.end(); }
      }
      const resultCache = { allocation: acquired.allocation, source: { ...source }, options: { ...options }, bindings: cache.bindings };
      this.pooledSource = source; return result(resultCache, true);
    } finally { for (const handle of acquired.handles) this.pool!.release(handle); }
  }
  private parameters(): GPUBuffer {
    return this.pooledParameters ??= this.session.own(this.session.device.createBuffer({ label: "Deep author bloom transient parameters",
      size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
  }
  private clear(): void { const previous = this.cache; this.cache = undefined; if (previous) releaseAuthorBloom(this.session, previous.allocation); }
  private assertReady(): void {
    if (this.disposed) throw new Error("Author bloom is disposed.");
    if (this.session.state !== "ready") { this.clear(); throw new Error("GPU session is not ready for author bloom."); }
  }
}

function result(cache: Cache, updated: boolean): BloomResult {
  return Object.freeze({ texture: cache.allocation.output, format: "rgba16float", width: cache.allocation.width,
    height: cache.allocation.height, revision: cache.source.revision, updated, colorEncoding: "linear-hdr",
    levels: cache.allocation.levels, passCount: 13 });
}
