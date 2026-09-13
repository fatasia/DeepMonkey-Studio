import {
  prepareTextures,
  type DecodedTexture,
  type PixelLevel,
  type TextureCompression,
  type TextureCompressionFeature,
  type TextureSampler,
  type TextureSemantic,
} from "./decodedTexture.js";

export type Ktx2SourceProfile = "etc1s" | "uastc" | "unknown";
export type Ktx2TranscodeTarget = TextureCompression | "rgba8";
export type Ktx2TranscodePreference = "quality" | "memory";

export interface EncodedKtx2Texture {
  readonly id: string;
  readonly revision: number;
  readonly semantic: TextureSemantic;
  readonly data: Uint8Array;
  readonly hasAlpha: boolean;
  readonly sourceProfile?: Ktx2SourceProfile;
  readonly sampler?: TextureSampler;
}

export interface Ktx2TranscodeRequest {
  readonly target: Ktx2TranscodeTarget;
  readonly sourceProfile: Ktx2SourceProfile;
  readonly hasAlpha: boolean;
  readonly colorSpace: "srgb" | "linear";
}

export interface Ktx2TranscodeResult {
  readonly target: Ktx2TranscodeTarget;
  readonly levels: readonly PixelLevel[];
}

export interface Ktx2ContainerInfo {
  readonly width: number;
  readonly height: number;
  readonly levelCount: number;
  readonly sourceProfile: Ktx2SourceProfile;
  /** True when transcoding needs an alpha-capable target, including UASTC RRRG data. */
  readonly hasAlpha: boolean;
}

/** Host adapter for Basis Universal/KTX2 WASM, native BasisU, or an equivalent isolated worker. */
export interface Ktx2Transcoder {
  transcode(data: Uint8Array<ArrayBuffer>, request: Readonly<Ktx2TranscodeRequest>, signal?: AbortSignal): Promise<Ktx2TranscodeResult>;
}

export interface Ktx2TranscodeOptions {
  readonly supportedFeatures?: Iterable<TextureCompressionFeature>;
  readonly preference?: Ktx2TranscodePreference;
  readonly maxDimension?: number;
  readonly maxSourceBytes?: number;
  readonly maxDecodedBytes?: number;
  readonly signal?: AbortSignal;
}

const FEATURES = new Set<TextureCompressionFeature>([
  "texture-compression-bc", "texture-compression-etc2", "texture-compression-astc",
]);
const KTX2_IDENTIFIER = Object.freeze([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
const KHR_DF_MODEL_ETC1S = 163, KHR_DF_MODEL_UASTC = 166;

/** Reads only the bounded KTX2 header and basic DFD fields needed before target selection. */
export function inspectKtx2Container(data: Uint8Array): Ktx2ContainerInfo {
  if (!(data instanceof Uint8Array) || !(data.buffer instanceof ArrayBuffer) || data.byteLength < 108) {
    throw new Error("KTX2 container is truncated.");
  }
  for (let index = 0; index < KTX2_IDENTIFIER.length; index++) {
    if (data[index] !== KTX2_IDENTIFIER[index]) throw new Error("KTX2 identifier is invalid.");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(20, true), height = view.getUint32(24, true);
  const depth = view.getUint32(28, true), layers = view.getUint32(32, true), faces = view.getUint32(36, true);
  const declaredLevels = view.getUint32(40, true), levelCount = Math.max(1, declaredLevels);
  if (!Number.isSafeInteger(width) || width < 1 || width > 16_384 || height < 1 || height > 16_384) {
    throw new Error("KTX2 dimensions are invalid.");
  }
  if (depth !== 0 || layers > 1 || faces !== 1 || levelCount > 32) {
    throw new Error("KTX2 container is not a supported 2D texture.");
  }
  const dfdOffset = view.getUint32(48, true), dfdLength = view.getUint32(52, true);
  const minimumDfdOffset = 80 + levelCount * 24;
  if (dfdOffset < minimumDfdOffset || dfdLength < 28 || dfdOffset > data.byteLength
    || dfdLength > data.byteLength - dfdOffset) throw new Error("KTX2 data format descriptor is invalid.");
  const totalSize = view.getUint32(dfdOffset, true), vendorId = view.getUint16(dfdOffset + 4, true);
  const descriptorType = view.getUint16(dfdOffset + 6, true), version = view.getUint16(dfdOffset + 8, true);
  const descriptorBlockSize = view.getUint16(dfdOffset + 10, true);
  if (totalSize < 28 || totalSize > dfdLength || vendorId !== 0 || descriptorType !== 0 || version !== 2
    || descriptorBlockSize < 24 || descriptorBlockSize > totalSize - 4) {
    throw new Error("KTX2 basic data format descriptor is invalid.");
  }
  const colorModel = view.getUint8(dfdOffset + 12);
  const sourceProfile: Ktx2SourceProfile = colorModel === KHR_DF_MODEL_ETC1S ? "etc1s"
    : colorModel === KHR_DF_MODEL_UASTC ? "uastc" : "unknown";
  const sampleBytes = descriptorBlockSize - 24;
  if (sourceProfile !== "unknown" && (sampleBytes < 16 || sampleBytes % 16 !== 0)) {
    throw new Error("KTX2 Basis data format samples are invalid.");
  }
  const sampleCount = sampleBytes / 16;
  let hasAlpha = true;
  if (sourceProfile === "etc1s") hasAlpha = sampleCount > 1;
  else if (sourceProfile === "uastc") {
    const channelId = view.getUint8(dfdOffset + 31) & 0x0f;
    hasAlpha = channelId === 3 || channelId === 5 || ![0, 4, 6].includes(channelId);
  }
  return Object.freeze({ width, height, levelCount, sourceProfile, hasAlpha });
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("KTX2 transcode aborted."); error.name = "AbortError"; return error;
}

function positiveLimit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) throw new Error(`Invalid ${name}.`);
  return resolved;
}

function featureSet(input: Iterable<TextureCompressionFeature> | undefined): ReadonlySet<TextureCompressionFeature> {
  const result = new Set<TextureCompressionFeature>();
  if (input === undefined) return result;
  if (input === null || typeof input[Symbol.iterator] !== "function") throw new Error("Invalid KTX2 compression capabilities.");
  for (const feature of input) {
    if (!FEATURES.has(feature)) throw new Error(`Unknown KTX2 compression capability: ${String(feature)}`);
    result.add(feature);
  }
  return result;
}

/** Chooses a deterministic GPU-native target and preserves alpha whenever the source declares it. */
export function selectKtx2TranscodeTarget(
  supportedFeatures: Iterable<TextureCompressionFeature> | undefined,
  hasAlpha: boolean,
  preference: Ktx2TranscodePreference = "quality",
  sourceProfile: Ktx2SourceProfile = "unknown",
): Ktx2TranscodeTarget {
  if (typeof hasAlpha !== "boolean") throw new Error("Invalid KTX2 alpha declaration.");
  if (preference !== "quality" && preference !== "memory") throw new Error("Invalid KTX2 transcode preference.");
  if (sourceProfile !== "etc1s" && sourceProfile !== "uastc" && sourceProfile !== "unknown") throw new Error("Invalid KTX2 source profile.");
  const features = featureSet(supportedFeatures);
  if (preference === "memory" && !hasAlpha && features.has("texture-compression-bc")) return "bc1-rgba";
  // Basis Universal can transcode ASTC only from UASTC. ETC1S and unknown profiles need a target valid for both families.
  if (sourceProfile === "uastc" && features.has("texture-compression-astc")) return "astc-4x4-rgba";
  if (sourceProfile !== "uastc" && features.has("texture-compression-etc2")) return "etc2-rgba8";
  if (features.has("texture-compression-bc")) return "bc7-rgba";
  if (features.has("texture-compression-etc2")) return "etc2-rgba8";
  return "rgba8";
}

async function transcodeCancelable(
  transcoder: Ktx2Transcoder,
  data: Uint8Array<ArrayBuffer>,
  request: Readonly<Ktx2TranscodeRequest>,
  signal?: AbortSignal,
): Promise<Ktx2TranscodeResult> {
  if (!signal) return transcoder.transcode(data, request);
  signal.throwIfAborted();
  let rejectAbort!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort(abortReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return transcoder.transcode(data, request, signal); });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

/**
 * Runs an injected KTX2 backend behind an owned-byte, exact-target and complete-mip boundary.
 * The returned texture can enter RenderPacket without Three.js or a DOM dependency.
 */
export async function transcodeKtx2Texture(
  source: EncodedKtx2Texture,
  transcoder: Ktx2Transcoder,
  options: Ktx2TranscodeOptions = {},
): Promise<DecodedTexture> {
  if (!source || typeof source !== "object") throw new Error("Invalid KTX2 texture source.");
  if (typeof source.id !== "string" || !source.id.trim() || source.id.length > 256) throw new Error("Invalid KTX2 texture id.");
  if (!Number.isSafeInteger(source.revision) || source.revision < 0) throw new Error("Invalid KTX2 texture revision.");
  if (!["baseColor", "metallicRoughness", "normal", "occlusion", "emissive"].includes(source.semantic)) {
    throw new Error("Invalid KTX2 texture semantic.");
  }
  if (typeof source.hasAlpha !== "boolean") throw new Error("Invalid KTX2 alpha declaration.");
  const declaredProfile = source.sourceProfile ?? "unknown";
  if (declaredProfile !== "etc1s" && declaredProfile !== "uastc" && declaredProfile !== "unknown") throw new Error("Invalid KTX2 source profile.");
  if (!(source.data instanceof Uint8Array) || !(source.data.buffer instanceof ArrayBuffer) || source.data.byteLength === 0) {
    throw new Error("KTX2 source requires owned nonempty bytes.");
  }
  if (!transcoder || (typeof transcoder !== "object" && typeof transcoder !== "function") || typeof transcoder.transcode !== "function") {
    throw new Error("Invalid KTX2 transcoder.");
  }
  if (!options || typeof options !== "object") throw new Error("Invalid KTX2 transcode options.");
  const maxSourceBytes = positiveLimit(options.maxSourceBytes, 128 * 1024 * 1024, 512 * 1024 * 1024, "KTX2 source byte limit");
  const maxDecodedBytes = positiveLimit(options.maxDecodedBytes, 128 * 1024 * 1024, 128 * 1024 * 1024, "KTX2 decoded byte limit");
  const maxDimension = positiveLimit(options.maxDimension, 16_384, 16_384, "KTX2 dimension limit");
  if (source.data.byteLength > maxSourceBytes) throw new Error("KTX2 source byte budget exceeded.");
  const container = inspectKtx2Container(source.data);
  if (container.width > maxDimension || container.height > maxDimension) throw new Error("KTX2 dimensions exceed limits.");
  if (declaredProfile !== "unknown" && container.sourceProfile !== "unknown" && declaredProfile !== container.sourceProfile) {
    throw new Error("KTX2 source profile does not match its container.");
  }
  const sourceProfile = declaredProfile === "unknown" ? container.sourceProfile : declaredProfile;
  if (!source.hasAlpha && container.hasAlpha) throw new Error("KTX2 alpha cannot be discarded by its declaration.");
  const hasAlpha = container.sourceProfile === "unknown" ? source.hasAlpha : container.hasAlpha;
  const signal = options.signal;
  signal?.throwIfAborted();
  const identity = Object.freeze({ id: source.id, revision: source.revision, semantic: source.semantic });
  let sampler: Readonly<TextureSampler> | undefined;
  if (source.sampler !== undefined) {
    if (!source.sampler || typeof source.sampler !== "object" || Array.isArray(source.sampler)) throw new Error("Invalid KTX2 sampler.");
    sampler = Object.freeze({ ...source.sampler });
  }
  let target = selectKtx2TranscodeTarget(options.supportedFeatures, hasAlpha, options.preference, sourceProfile);
  // Current WebGPU validation requires the base resource itself to be block aligned.
  if (target !== "rgba8" && (container.width % 4 !== 0 || container.height % 4 !== 0)) target = "rgba8";
  const request = Object.freeze<Ktx2TranscodeRequest>({
    target, sourceProfile, hasAlpha,
    colorSpace: identity.semantic === "baseColor" || identity.semantic === "emissive" ? "srgb" : "linear",
  });
  const result = await transcodeCancelable(transcoder, source.data.slice(), request, signal);
  signal?.throwIfAborted();
  if (!result || typeof result !== "object" || result.target !== target) throw new Error("KTX2 transcoder did not honor the requested target.");
  if (!Array.isArray(result.levels) || result.levels.length < 1) throw new Error("KTX2 transcoder returned no mip levels.");
  if (result.levels.length !== container.levelCount) throw new Error("KTX2 transcoder returned a different mip count than the container.");
  const [base, ...mipmaps] = result.levels;
  if (!base) throw new Error("KTX2 transcoder returned no base level.");
  if (base.width !== container.width || base.height !== container.height) {
    throw new Error("KTX2 transcoder returned base dimensions that differ from the container.");
  }
  const candidate: DecodedTexture = {
    ...identity,
    width: base.width, height: base.height, data: base.data, ...(base.bytesPerRow === undefined ? {} : { bytesPerRow: base.bytesPerRow }),
    ...(target === "rgba8" ? {} : { compression: target }),
    ...(mipmaps.length ? { mipmaps } : {}), ...(sampler === undefined ? {} : { sampler }),
  };
  const prepared = prepareTextures([candidate], { maxDimension, maxBytes: maxDecodedBytes, maxTextures: 1 })[0]!;
  signal?.throwIfAborted();
  return Object.freeze({
    ...identity,
    width: prepared.levels[0]!.width, height: prepared.levels[0]!.height,
    data: prepared.levels[0]!.data,
    bytesPerRow: prepared.levels[0]!.bytesPerRow,
    ...(target === "rgba8" ? {} : { compression: target }),
    ...(prepared.levels.length > 1 ? { mipmaps: Object.freeze(prepared.levels.slice(1).map(level => Object.freeze({
      width: level.width, height: level.height, data: level.data, bytesPerRow: level.bytesPerRow,
    }))) } : {}),
    sampler: prepared.sampler,
  });
}
