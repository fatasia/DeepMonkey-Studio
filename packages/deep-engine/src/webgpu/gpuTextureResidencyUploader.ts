import type {
  GpuResidencyUploader, GpuResidencyUploadRequest, GpuResidencyUploadResult,
} from "../streaming/index.js";
import {
  prepareTextures, type DecodedTexture, type PreparedTexture, type PreparedTextureFormat,
  type TextureCompressionFeature, type TextureSemantic,
} from "../textures/decodedTexture.js";
import type { DeviceSession } from "./deviceSession.js";
import { bindGpuResidencyHandleDevice } from "./gpuResidencyDeviceAffinity.js";

export type GpuTextureResidencyTexture = PreparedTexture | DecodedTexture;
/** Provider 必须声明返回内容对应的外部 LOD，不能只靠相同字节数猜测。 */
export interface GpuTextureResidencySource {
  readonly level: number;
  readonly texture: GpuTextureResidencyTexture;
}
export type GpuTextureResidencySourceProvider = (request: GpuResidencyUploadRequest) =>
  GpuTextureResidencySource | Promise<GpuTextureResidencySource>;

/** 由 residency executor 独占；GPUTexture 的实际所有权始终归 DeviceSession。 */
export interface GpuTextureResidencyHandle {
  readonly kind: "texture";
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
  readonly id: string;
  readonly revision: number;
  readonly level: number;
  readonly byteLength: number;
  readonly semantic: TextureSemantic;
  readonly format: PreparedTextureFormat;
  readonly width: number;
  readonly height: number;
  readonly mipLevelCount: number;
  readonly requiredFeature?: TextureCompressionFeature;
}

interface FormatLayout {
  readonly blockWidth: 1 | 4;
  readonly blockBytes: 4 | 8 | 16;
  readonly feature?: TextureCompressionFeature;
}

const FORMAT_LAYOUT = Object.freeze({
  "rgba8unorm": { blockWidth: 1, blockBytes: 4 },
  "rgba8unorm-srgb": { blockWidth: 1, blockBytes: 4 },
  "bc1-rgba-unorm": { blockWidth: 4, blockBytes: 8, feature: "texture-compression-bc" },
  "bc1-rgba-unorm-srgb": { blockWidth: 4, blockBytes: 8, feature: "texture-compression-bc" },
  "bc7-rgba-unorm": { blockWidth: 4, blockBytes: 16, feature: "texture-compression-bc" },
  "bc7-rgba-unorm-srgb": { blockWidth: 4, blockBytes: 16, feature: "texture-compression-bc" },
  "etc2-rgba8unorm": { blockWidth: 4, blockBytes: 16, feature: "texture-compression-etc2" },
  "etc2-rgba8unorm-srgb": { blockWidth: 4, blockBytes: 16, feature: "texture-compression-etc2" },
  "astc-4x4-unorm": { blockWidth: 4, blockBytes: 16, feature: "texture-compression-astc" },
  "astc-4x4-unorm-srgb": { blockWidth: 4, blockBytes: 16, feature: "texture-compression-astc" },
} as const satisfies Record<PreparedTextureFormat, FormatLayout>);

/** 将一个纹理 LOD/修订上传为可独立替换的 session-owned GPUTexture。 */
export class GpuTextureResidencyUploader implements GpuResidencyUploader<GpuTextureResidencyHandle> {
  constructor(private readonly session: DeviceSession,
    private readonly sourceFor: GpuTextureResidencySourceProvider,
    private readonly usage: GPUTextureUsageFlags = GPUTextureUsage.TEXTURE_BINDING) {}

  async upload(request: GpuResidencyUploadRequest): Promise<GpuResidencyUploadResult<GpuTextureResidencyHandle>> {
    if (request.kind !== "texture") throw new Error(`Texture uploader received non-texture resource: ${request.id}.`);
    if (request.signal.aborted) throw cancellation(request.signal);
    const provided = await this.sourceFor(request);
    if (request.signal.aborted) throw cancellation(request.signal);
    validateProvidedSource(provided, request);
    const source = prepareSource(provided.texture, textureLimit(this.session));
    if (request.signal.aborted) throw cancellation(request.signal);
    const layout = validateSource(source, request, this.session);
    const device = this.session.device, checks: Promise<GPUError | null>[] = [];
    let texture: GPUTexture | undefined, view: GPUTextureView | undefined, sampler: GPUSampler | undefined;
    let depth = 0, workError: unknown;
    try {
      for (const filter of ["validation", "out-of-memory", "internal"] as const) {
        device.pushErrorScope(filter); depth += 1;
      }
      texture = this.session.own(device.createTexture({
        label: `Deep streamed texture ${request.id} LOD ${request.level}`,
        size: { width: source.levels[0]!.width, height: source.levels[0]!.height, depthOrArrayLayers: 1 },
        format: source.format, mipLevelCount: source.levels.length, dimension: "2d",
        usage: this.usage | GPUTextureUsage.COPY_DST,
      }));
      for (let index = 0; index < source.levels.length; index += 1) {
        const mip = source.levels[index]!;
        this.session.device.queue.writeTexture({ texture, mipLevel: index }, mip.data,
          { bytesPerRow: mip.bytesPerRow, rowsPerImage: Math.ceil(mip.height / layout.blockWidth) },
          { width: alignedCopyDimension(mip.width, layout.blockWidth),
            height: alignedCopyDimension(mip.height, layout.blockWidth), depthOrArrayLayers: 1 });
        if (request.signal.aborted) throw cancellation(request.signal);
      }
      view = texture.createView();
      sampler = device.createSampler({ label: `Deep streamed sampler ${request.id}`,
        ...source.sampler, lodMinClamp: 0, lodMaxClamp: source.levels.length - 1 });
      if (request.signal.aborted) throw cancellation(request.signal);
    } catch (error) { workError = error; }
    finally {
      // 在首次等待前关闭本次上传的全部作用域，避免捕获并行帧中的无关 GPU 工作。
      while (depth-- > 0) {
        try { checks.push(device.popErrorScope()); }
        catch (error) { checks.push(Promise.reject(error)); }
      }
    }
    try {
      let validationError: unknown;
      try { await waitForValidation(checks, request.signal); }
      catch (error) { validationError = error; }
      if (workError !== undefined) throw workError;
      if (validationError !== undefined) throw validationError;
      if (request.signal.aborted) throw cancellation(request.signal);
      const base = source.levels[0]!;
      const handle = bindGpuResidencyHandleDevice(Object.freeze({ kind: "texture" as const,
        texture: texture!, view: view!, sampler: sampler!,
        id: request.id, revision: request.revision,
        level: request.level, byteLength: source.byteLength, semantic: source.semantic, format: source.format,
        width: base.width, height: base.height, mipLevelCount: source.levels.length,
        ...(source.requiredFeature ? { requiredFeature: source.requiredFeature } : {}) }), device);
      return Object.freeze({ handle, byteLength: source.byteLength });
    } catch (error) {
      if (texture) this.session.release(texture);
      throw error;
    }
  }

  release(handle: GpuTextureResidencyHandle): void { this.session.release(handle.texture); }
}

function validateProvidedSource(source: GpuTextureResidencySource, request: GpuResidencyUploadRequest): void {
  if (!source || typeof source !== "object" || !Number.isSafeInteger(source.level) || source.level < 0) {
    throw new Error("Invalid texture residency source level.");
  }
  if (!Number.isSafeInteger(request.level) || request.level < 0) throw new Error("Invalid texture residency level.");
  if (source.level !== request.level) {
    throw new Error(`Texture residency source level differs from request: ${request.id}.`);
  }
}

function prepareSource(source: GpuTextureResidencyTexture, maxDimension: number): PreparedTexture {
  if (!source || typeof source !== "object") throw new TypeError("Texture residency source is invalid.");
  if ("format" in source) return source;
  return prepareTextures([source], { maxDimension })[0]!;
}

function validateSource(source: PreparedTexture, request: GpuResidencyUploadRequest,
  session: DeviceSession): FormatLayout {
  if (source.id !== request.id || source.revision !== request.revision) {
    throw new Error(`Texture residency source identity differs from request: ${request.id}.`);
  }
  if (typeof source.id !== "string" || !source.id.trim() || source.id.length > 256
    || !Number.isSafeInteger(source.revision) || source.revision < 0) throw new Error("Invalid texture residency identity.");
  if (!["baseColor", "metallicRoughness", "normal", "occlusion", "emissive"].includes(source.semantic)) {
    throw new Error("Invalid texture residency semantic.");
  }
  const layout = FORMAT_LAYOUT[source.format] as FormatLayout | undefined;
  if (!layout) throw new Error(`Unsupported texture residency format: ${String(source.format)}.`);
  if (source.requiredFeature !== layout.feature) throw new Error("Texture format feature declaration is invalid.");
  if (layout.feature && !session.device.features.has(layout.feature)) {
    throw new Error(`Texture format ${source.format} requires unavailable device feature ${layout.feature}.`);
  }
  if (!Array.isArray(source.levels) || source.levels.length < 1) throw new Error("Texture residency source has no mip levels.");
  validateSampler(source);
  const limit = textureLimit(session);
  let total = 0, previousWidth = 0, previousHeight = 0;
  for (let index = 0; index < source.levels.length; index += 1) {
    const mip = source.levels[index]!;
    assertDimension(mip.width, limit); assertDimension(mip.height, limit);
    if (index > 0 && (mip.width !== Math.max(1, Math.floor(previousWidth / 2))
      || mip.height !== Math.max(1, Math.floor(previousHeight / 2)))) throw new Error("Invalid texture mip dimensions.");
    if (index === 0 && layout.blockWidth === 4 && (mip.width % 4 !== 0 || mip.height % 4 !== 0)) {
      throw new Error("Compressed texture base dimensions must be multiples of four.");
    }
    const bytesPerRow = Math.ceil(mip.width / layout.blockWidth) * layout.blockBytes;
    const byteLength = bytesPerRow * Math.ceil(mip.height / layout.blockWidth);
    if (!(mip.data instanceof Uint8Array) || !(mip.data.buffer instanceof ArrayBuffer)
      || mip.bytesPerRow !== bytesPerRow || mip.byteLength !== byteLength || mip.data.byteLength !== byteLength) {
      throw new Error("Texture residency byte layout is invalid.");
    }
    total += byteLength; previousWidth = mip.width; previousHeight = mip.height;
    if (!Number.isSafeInteger(total)) throw new Error("Texture residency byte length is invalid.");
  }
  const finalMip = source.levels[source.levels.length - 1]!;
  if (source.levels.length > 1 && (finalMip.width !== 1 || finalMip.height !== 1)) {
    throw new Error("Texture residency mip chain must end at 1x1.");
  }
  if (source.byteLength !== total || total !== request.expectedByteLength) {
    throw new Error(`Texture residency byte count differs from plan: ${request.id}.`);
  }
  return layout;
}

function validateSampler(source: PreparedTexture): void {
  const value = source.sampler;
  if (!value || typeof value !== "object") throw new Error("Invalid texture residency sampler.");
  if (!["repeat", "mirror-repeat", "clamp-to-edge"].includes(value.addressModeU)
    || !["repeat", "mirror-repeat", "clamp-to-edge"].includes(value.addressModeV)
    || ![value.magFilter, value.minFilter, value.mipmapFilter].every(filter => ["nearest", "linear"].includes(filter))
    || !Number.isSafeInteger(value.maxAnisotropy) || value.maxAnisotropy < 1 || value.maxAnisotropy > 16
    || (value.maxAnisotropy > 1 && [value.magFilter, value.minFilter, value.mipmapFilter].some(filter => filter !== "linear"))) {
    throw new Error("Invalid texture residency sampler.");
  }
}

async function waitForValidation(checks: readonly Promise<GPUError | null>[], signal: AbortSignal): Promise<void> {
  const checked = Promise.all(checks).then(errors => {
    const error = errors.find(value => value !== null);
    if (error) throw new Error(`GPU texture residency upload failed: ${error.message}`);
  });
  if (signal.aborted) { void checked.catch(() => {}); throw cancellation(signal); }
  let rejectCancellation!: (reason: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  const onAbort = (): void => rejectCancellation(cancellation(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try { await Promise.race([checked, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

function textureLimit(session: DeviceSession): number {
  const value = Math.min(16384, session.device.limits.maxTextureDimension2D);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid GPU texture dimension limit.");
  return value;
}
function assertDimension(value: number, limit: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > limit) throw new Error("Texture exceeds device dimension limit.");
}
function alignedCopyDimension(value: number, blockWidth: number): number {
  return Math.ceil(value / blockWidth) * blockWidth;
}
function cancellation(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("GPU texture residency upload cancelled."); error.name = "AbortError"; return error;
}
