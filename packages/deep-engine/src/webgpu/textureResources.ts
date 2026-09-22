import { prepareTextures, sameTextureContent, type DecodedTexture, type PreparedTexture, type PreparedTextureFormat } from "../textures/decodedTexture.js";
import type { DeviceSession } from "./deviceSession.js";
import { createAdmittedTexture } from "./resourceAdmission.js";
import { runResourceCleanup } from "./resourceCleanup.js";
import type { TextureArrayLayerSource } from "./textureArrayResources.js";
import type { TextureArrayPackingEntry } from "./textureArrayPacking.js";

/** 借用句柄，生命周期归 TextureResources；调用者不能自行 destroy。 */
export interface TextureBinding {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
  readonly format: PreparedTextureFormat;
  readonly width: number;
  readonly height: number;
  readonly mipLevelCount: number;
}
interface CachedTexture { readonly source: PreparedTexture; readonly binding?: TextureBinding }
export interface StagedTextureSet {
  readonly entries: Map<string, CachedTexture>;
  readonly samplers: Map<string, GPUSampler>;
  readonly created: GPUTexture[];
  readonly changed: boolean;
  settled: boolean;
}
const cancelled = (): DOMException => new DOMException("Texture update cancelled or superseded.", "AbortError");

/** 完整纹理集事务；等待 GPU 校验期间保持旧纹理集可绘制。 */
export class TextureResources {
  private entries = new Map<string, CachedTexture>();
  private samplers = new Map<string, GPUSampler>();
  private generation = 0;
  private disposed = false;
  private pending: { cancel(): void } | undefined;
  constructor(private readonly session: DeviceSession) {}

  get size(): number { return this.entries.size; }
  get byteLength(): number { return Array.from(this.entries.values()).reduce((sum, value) => sum + value.source.byteLength, 0); }

  get(id: string): TextureBinding | undefined {
    this.assertReady();
    return this.entries.get(id)?.binding;
  }

  async setValidated(resources: readonly DecodedTexture[], signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) throw cancelled();
    this.assertReady();
    const generation = ++this.generation;
    this.pending?.cancel(); this.pending = undefined;
    const prepared = prepareTextures(resources, { maxDimension: Math.min(16384, this.session.device.limits.maxTextureDimension2D) });
    const { staged, checked } = this.stageValidated(prepared);
    let wasCancelled = false;
    let rejectCancellation!: (reason: Error) => void;
    const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    const request = { cancel: (): void => {
      if (wasCancelled) return;
      wasCancelled = true;
      const cancellationError = cancelled();
      try { this.rollback(staged); }
      catch (cleanupError) {
        rejectCancellation(new AggregateError([cancellationError, cleanupError],
          "Texture cancellation cleanup failed."));
        return;
      }
      rejectCancellation(cancellationError);
    } };
    this.pending = request;
    signal?.addEventListener("abort", request.cancel, { once: true });
    if (signal?.aborted || generation !== this.generation || this.disposed) request.cancel();
    try {
      await Promise.race([checked, cancellation]);
      if (wasCancelled) throw cancelled();
      return this.commit(staged, generation);
    } finally {
      signal?.removeEventListener("abort", request.cancel);
      if (this.pending === request) this.pending = undefined;
      this.rollback(staged);
    }
  }

  /** PacketBuffers 用于把纹理、几何和实例放进同一个发布事务。 */
  stagePrepared(prepared: readonly PreparedTexture[], omitStorage: ReadonlySet<string> = new Set()): StagedTextureSet {
    this.assertReady();
    const limit = this.session.device.limits.maxTextureDimension2D ?? 16384;
    for (const texture of prepared) {
      const level = texture.levels[0]!;
      if (level.width > limit || level.height > limit) throw new Error("Texture exceeds device dimension limit.");
      if (texture.requiredFeature && !this.session.device.features.has(texture.requiredFeature)) {
        throw new Error(`Texture format ${texture.format} requires unavailable device feature ${texture.requiredFeature}.`);
      }
    }
    return this.stage(prepared, omitStorage);
  }

  publishPrepared(staged: StagedTextureSet): boolean {
    this.assertReady();
    return this.publish(staged);
  }

  discardPrepared(staged: StagedTextureSet): void { this.rollback(staged); }

  stagedBinding(staged: StagedTextureSet, id: string): TextureBinding {
    const binding = staged.entries.get(id)?.binding;
    if (!binding) throw new Error(`Texture binding is unavailable: ${id}`);
    return binding;
  }

  stagedArrayEntries(staged: StagedTextureSet): readonly TextureArrayPackingEntry[] {
    return [...staged.entries].filter(([, value]) => !value.source.requiredFeature).map(([textureId, value]) => ({
      textureId, format: value.source.format, width: value.source.levels[0]!.width, height: value.source.levels[0]!.height,
      compatibilityKey: `${value.source.samplerKey}|mips:${value.source.levels.length}`,
    }));
  }

  stagedArrayLayer(staged: StagedTextureSet, id: string): TextureArrayLayerSource {
    const value = staged.entries.get(id);
    if (!value) throw new Error(`Texture array layer is unavailable: ${id}`);
    const sampler = staged.samplers.get(value.source.samplerKey);
    if (!sampler) throw new Error(`Texture array sampler is unavailable: ${id}`);
    return { mipLevelCount: value.source.levels.length, sampler,
      ...(value.source.requiredFeature ? { requiredFeature: value.source.requiredFeature } : {}),
      levels: value.source.levels };
  }

  semanticMap(): ReadonlyMap<string, PreparedTexture["semantic"]> {
    return new Map(Array.from(this.entries, ([id, value]) => [id, value.source.semantic]));
  }

  private assertReady(): void {
    if (this.disposed || this.session.state !== "ready") throw new Error("Texture resources are not ready.");
  }

  private stageValidated(prepared: readonly PreparedTexture[]): { staged: StagedTextureSet; checked: Promise<void> } {
    const device = this.session.device, checks: Promise<GPUError | null>[] = [];
    let depth = 0, staged: StagedTextureSet | undefined, failed = false, failure: unknown;
    try {
      for (const filter of ["validation", "out-of-memory", "internal"] as const) { device.pushErrorScope(filter); depth++; }
      staged = this.stagePrepared(prepared);
    } catch (error) { failed = true; failure = error; }
    finally {
      // 全部作用域在首次 await 之前关闭，不把后续渲染或并行资源事务纳入校验。
      while (depth-- > 0) {
        try { checks.push(device.popErrorScope()); }
        catch (error) { checks.push(Promise.reject(error)); }
      }
    }
    const checked = Promise.all(checks).then(errors => {
      const error = errors.find(value => value !== null);
      if (error) throw new Error(`GPU texture preparation failed: ${error.message}`);
    });
    if (failed) { void checked.catch(() => {}); throw failure; }
    return { staged: staged!, checked };
  }

  private stage(prepared: readonly PreparedTexture[], omitStorage: ReadonlySet<string> = new Set()): StagedTextureSet {
    const entries = new Map<string, CachedTexture>(), samplers = new Map<string, GPUSampler>(), created: GPUTexture[] = [];
    let bindingChanged = false;
    for (const source of prepared) {
      const previous = this.entries.get(source.id);
      if (previous && source.revision < previous.source.revision) throw new Error(`Stale texture revision: ${source.id}`);
      if (previous && source.revision === previous.source.revision && !sameTextureContent(source, previous.source)) throw new Error(`Texture content changed without a revision: ${source.id}`);
    }
    try {
      for (const source of prepared) {
        const previous = this.entries.get(source.id);
        let sampler = samplers.get(source.samplerKey) ?? this.samplers.get(source.samplerKey);
        if (!sampler) sampler = this.session.device.createSampler({ label: "Deep texture sampler", ...source.sampler, lodMinClamp: 0, lodMaxClamp: source.levels.length - 1 });
        samplers.set(source.samplerKey, sampler);
        if (omitStorage.has(source.id)) {
          if (previous && source.revision === previous.source.revision && previous.binding === undefined) entries.set(source.id, previous);
          else { entries.set(source.id, { source }); bindingChanged ||= previous?.binding !== undefined; }
          continue;
        }
        if (previous && source.revision === previous.source.revision && previous.binding) { entries.set(source.id, previous); continue; }
        if (previous && source.samplerKey !== previous.source.samplerKey
          && previous.binding && sameGpuTexturePayload(source, previous.source)) {
          // Sampler-only revisions need a new binding identity so material groups refresh, but immutable
          // texture storage and its view remain valid and avoid replaying every mip upload.
          const binding = Object.freeze({ ...previous.binding, sampler });
          bindingChanged = true;
          entries.set(source.id, { source, binding });
          continue;
        }
        const level = source.levels[0]!;
        const texture = createAdmittedTexture(this.session, { label: `Deep texture ${source.id}`,
          size: { width: level.width, height: level.height, depthOrArrayLayers: 1 }, format: source.format,
          mipLevelCount: source.levels.length, dimension: "2d", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        created.push(texture);
        for (let index = 0; index < source.levels.length; index++) {
          const mip = source.levels[index]!;
          // writeTexture 不要求 256-byte pitch；上传前已收紧 RGBA8 行或 GPU block 行。
          this.session.device.queue.writeTexture({ texture, mipLevel: index }, mip.data,
            { bytesPerRow: mip.bytesPerRow, rowsPerImage: Math.ceil(mip.height / (source.requiredFeature ? 4 : 1)) },
            { width: source.requiredFeature ? Math.ceil(mip.width / 4) * 4 : mip.width,
              height: source.requiredFeature ? Math.ceil(mip.height / 4) * 4 : mip.height, depthOrArrayLayers: 1 });
        }
        entries.set(source.id, { source, binding: Object.freeze({ texture, view: texture.createView(), sampler, format: source.format,
          width: level.width, height: level.height, mipLevelCount: source.levels.length }) });
      }
    } catch (error) {
      try { runResourceCleanup("Texture staging rollback failed.",
        created.map(texture => () => this.session.release(texture))); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Texture staging failed."); }
      throw error;
    }
    return { entries, samplers, created, settled: false,
      changed: bindingChanged || created.length > 0 || entries.size !== this.entries.size };
  }

  private rollback(staged: StagedTextureSet): void {
    if (staged.settled) return;
    staged.settled = true;
    runResourceCleanup("Texture stage rollback failed.",
      staged.created.map(texture => () => this.session.release(texture)));
  }

  private commit(staged: StagedTextureSet, generation: number): boolean {
    if (staged.settled || this.disposed || this.session.state !== "ready" || generation !== this.generation) {
      this.rollback(staged); throw cancelled();
    }
    return this.publish(staged);
  }

  private publish(staged: StagedTextureSet): boolean {
    if (staged.settled) throw cancelled();
    staged.settled = true;
    const previous = this.entries;
    this.entries = staged.entries; this.samplers = staged.samplers;
    // A sampler-only replacement borrows the active texture into the new entry; retire by GPU identity.
    const retainedTextures = new Set(Array.from(staged.entries.values(), value => value.binding?.texture).filter(Boolean));
    runResourceCleanup("Superseded texture retirement failed.", [...previous]
      .filter(([, value]) => value.binding && !retainedTextures.has(value.binding.texture))
      .map(([, value]) => () => this.session.release(value.binding!.texture)));
    return staged.changed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++;
    const pending = this.pending, entries = [...this.entries.values()];
    this.pending = undefined; this.entries = new Map(); this.samplers = new Map();
    runResourceCleanup("Texture resource disposal failed.", [() => pending?.cancel(),
      ...entries.filter(value => value.binding).map(value => () => this.session.release(value.binding!.texture))]);
  }
}

/** GPU texture identity excludes revision, author semantic and sampler state. */
function sameGpuTexturePayload(left: PreparedTexture, right: PreparedTexture): boolean {
  return left.format === right.format && left.requiredFeature === right.requiredFeature
    && left.levels.length === right.levels.length
    && left.levels.every((level, index) => {
      const other = right.levels[index]!;
      return level.width === other.width && level.height === other.height
        && level.bytesPerRow === other.bytesPerRow && level.data.length === other.data.length
        && level.data.every((value, offset) => value === other.data[offset]);
    });
}
