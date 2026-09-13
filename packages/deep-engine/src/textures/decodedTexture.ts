export type TextureSemantic = "baseColor" | "metallicRoughness" | "normal" | "occlusion" | "emissive";
export type TextureAddressMode = "clamp-to-edge" | "repeat" | "mirror-repeat";
export type TextureFilter = "nearest" | "linear";
export type TextureCompression = "bc1-rgba" | "bc7-rgba" | "etc2-rgba8" | "astc-4x4-rgba";
export type TextureCompressionFeature = "texture-compression-bc" | "texture-compression-etc2" | "texture-compression-astc";
export type PreparedTextureFormat = "rgba8unorm" | "rgba8unorm-srgb"
  | "bc1-rgba-unorm" | "bc1-rgba-unorm-srgb"
  | "bc7-rgba-unorm" | "bc7-rgba-unorm-srgb"
  | "etc2-rgba8unorm" | "etc2-rgba8unorm-srgb"
  | "astc-4x4-unorm" | "astc-4x4-unorm-srgb";

export interface TextureSampler {
  readonly addressModeU?: TextureAddressMode;
  readonly addressModeV?: TextureAddressMode;
  readonly magFilter?: TextureFilter;
  readonly minFilter?: TextureFilter;
  readonly mipmapFilter?: TextureFilter;
  readonly maxAnisotropy?: number;
}
export interface PixelLevel {
  readonly width: number;
  readonly height: number;
  /** RGBA8 texels, or GPU-native block rows when the owning texture declares compression. */
  readonly data: Uint8Array;
  readonly bytesPerRow?: number;
}
export interface DecodedTexture extends PixelLevel {
  readonly id: string;
  readonly revision: number;
  readonly semantic: TextureSemantic;
  /** GPU-native 4×4 RGBA block payload. Omit for ordinary RGBA8 pixels. */
  readonly compression?: TextureCompression;
  /** 不包含 level 0。省略表示单级；提供时必须完整直到 1×1。 */
  readonly mipmaps?: readonly PixelLevel[];
  readonly sampler?: TextureSampler;
}
export interface MipLayout {
  readonly width: number;
  readonly height: number;
  readonly bytesPerRow: number;
  readonly byteLength: number;
}
export interface PreparedTexture {
  readonly id: string;
  readonly revision: number;
  readonly semantic: TextureSemantic;
  readonly format: PreparedTextureFormat;
  readonly requiredFeature?: TextureCompressionFeature;
  readonly levels: readonly (MipLayout & { readonly data: Uint8Array<ArrayBuffer> })[];
  readonly sampler: Required<TextureSampler>;
  readonly samplerKey: string;
  readonly byteLength: number;
}
export interface TextureLimits { readonly maxDimension?: number; readonly maxBytes?: number; readonly maxTextures?: number }
const DEFAULT_BYTES = 128 * 1024 * 1024;
const COMPRESSION = Object.freeze({
  "bc1-rgba": { linear: "bc1-rgba-unorm", srgb: "bc1-rgba-unorm-srgb", feature: "texture-compression-bc", blockBytes: 8 },
  "bc7-rgba": { linear: "bc7-rgba-unorm", srgb: "bc7-rgba-unorm-srgb", feature: "texture-compression-bc", blockBytes: 16 },
  "etc2-rgba8": { linear: "etc2-rgba8unorm", srgb: "etc2-rgba8unorm-srgb", feature: "texture-compression-etc2", blockBytes: 16 },
  "astc-4x4-rgba": { linear: "astc-4x4-unorm", srgb: "astc-4x4-unorm-srgb", feature: "texture-compression-astc", blockBytes: 16 },
} as const satisfies Record<TextureCompression, {
  readonly linear: PreparedTextureFormat; readonly srgb: PreparedTextureFormat; readonly feature: TextureCompressionFeature;
  readonly blockBytes: 8 | 16;
}>);
const integer = (value: number, maximum: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid texture ${name}.`);
  return value;
};

/** 仅规划 RGBA8 mip 布局，不生成像素或分配 GPU 资源。 */
export function planTextureMips(width: number, height: number, maxDimension = 16384): readonly MipLayout[] {
  integer(maxDimension, 16384, "dimension limit");
  integer(width, maxDimension, "width"); integer(height, maxDimension, "height");
  const result: MipLayout[] = [];
  for (;;) {
    result.push({ width, height, bytesPerRow: width * 4, byteLength: width * height * 4 });
    if (width === 1 && height === 1) return result;
    width = Math.max(1, Math.floor(width / 2)); height = Math.max(1, Math.floor(height / 2));
  }
}

/** Plans tightly packed 4×4 GPU blocks; the WebGPU base resource stays block aligned. */
export function planCompressedTextureMips(width: number, height: number, compression: TextureCompression,
  maxDimension = 16384): readonly MipLayout[] {
  integer(maxDimension, 16384, "dimension limit");
  integer(width, maxDimension, "width"); integer(height, maxDimension, "height");
  const format = COMPRESSION[compression];
  if (!format) throw new Error("Invalid texture compression format.");
  if (width % 4 !== 0 || height % 4 !== 0) throw new Error("Compressed texture base dimensions must be multiples of four.");
  const result: MipLayout[] = [];
  for (;;) {
    const blockColumns = Math.ceil(width / 4), blockRows = Math.ceil(height / 4);
    result.push({ width, height, bytesPerRow: blockColumns * format.blockBytes,
      byteLength: blockColumns * blockRows * format.blockBytes });
    if (width === 1 && height === 1) return result;
    width = Math.max(1, Math.floor(width / 2)); height = Math.max(1, Math.floor(height / 2));
  }
}

function samplerSettings(input: TextureSampler | undefined): Required<TextureSampler> {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw new Error("Invalid texture sampler.");
  if (input && [input.addressModeU, input.addressModeV, input.magFilter, input.minFilter, input.mipmapFilter, input.maxAnisotropy].some(value => value === null)) throw new Error("Invalid null texture sampler field.");
  const value = { addressModeU: input?.addressModeU ?? "repeat", addressModeV: input?.addressModeV ?? "repeat",
    magFilter: input?.magFilter ?? "linear", minFilter: input?.minFilter ?? "linear",
    mipmapFilter: input?.mipmapFilter ?? "linear", maxAnisotropy: input?.maxAnisotropy ?? 1 };
  for (const address of [value.addressModeU, value.addressModeV]) if (!["repeat", "mirror-repeat", "clamp-to-edge"].includes(address)) throw new Error("Invalid texture address mode.");
  for (const filter of [value.magFilter, value.minFilter, value.mipmapFilter]) if (!["nearest", "linear"].includes(filter)) throw new Error("Invalid texture filter.");
  integer(value.maxAnisotropy, 16, "anisotropy");
  if (value.maxAnisotropy > 1 && [value.magFilter, value.minFilter, value.mipmapFilter].some(filter => filter !== "linear")) throw new Error("Anisotropic texture filtering requires linear filters.");
  return value;
}

function pixelLayout(input: PixelLevel, expected: MipLayout, rows: number, rowAlignment = 1): number {
  if (!input || input.width !== expected.width || input.height !== expected.height) throw new Error("Invalid texture mip dimensions.");
  if (!(input.data instanceof Uint8Array)) throw new Error("Texture payload must be Uint8Array.");
  if (!(input.data.buffer instanceof ArrayBuffer)) throw new Error("Texture pixels require an unshared ArrayBuffer.");
  const pitch = input.bytesPerRow ?? expected.bytesPerRow;
  integer(pitch, DEFAULT_BYTES, "row pitch");
  if (pitch < expected.bytesPerRow) throw new Error("Texture row pitch is smaller than a row.");
  if (pitch % rowAlignment !== 0) throw new Error("Texture row pitch is not aligned to its texel block.");
  const required = pitch * (rows - 1) + expected.bytesPerRow;
  if (input.data.byteLength < required || input.data.byteLength > pitch * rows) throw new Error("Texture pixel length does not match row layout.");
  return pitch;
}

/** 上传边界取得自有像素副本；预算检查先于所有像素复制。 */
export function prepareTextures(input: readonly DecodedTexture[], limits: TextureLimits = {}): readonly PreparedTexture[] {
  const maxDimension = integer(limits.maxDimension ?? 16384, 16384, "dimension limit");
  const maxBytes = integer(limits.maxBytes ?? DEFAULT_BYTES, DEFAULT_BYTES, "byte limit");
  const maxTextures = integer(limits.maxTextures ?? 4096, 4096, "count limit");
  if (!Array.isArray(input) || input.length > maxTextures) throw new Error("Texture resource count exceeds limit.");
  const ids = new Set<string>();
  let totalBytes = 0, totalSourceBytes = 0;
  const sources: readonly DecodedTexture[] = input;
  const checked = Array.from(sources, (source: DecodedTexture) => {
    if (!source || typeof source.id !== "string" || !source.id.trim() || source.id.length > 256 || ids.has(source.id)) throw new Error("Invalid or duplicate texture id.");
    ids.add(source.id);
    if (!Number.isSafeInteger(source.revision) || source.revision < 0) throw new Error("Invalid texture revision.");
    if (!["baseColor", "metallicRoughness", "normal", "occlusion", "emissive"].includes(source.semantic)) throw new Error("Invalid texture semantic.");
    if (source.compression !== undefined && !(source.compression in COMPRESSION)) throw new Error("Invalid texture compression format.");
    const compression = source.compression === undefined ? undefined : COMPRESSION[source.compression];
    const plan = compression ? planCompressedTextureMips(source.width, source.height, source.compression!, maxDimension)
      : planTextureMips(source.width, source.height, maxDimension);
    if (source.mipmaps !== undefined && !Array.isArray(source.mipmaps)) throw new Error("Invalid texture mip chain.");
    const extra = source.mipmaps ?? [];
    if (extra.length !== 0 && extra.length !== plan.length - 1) throw new Error("Texture mip chain must be complete.");
    const levels = [source, ...extra].map((level, index) => {
      const layout = plan[index]!, rows = compression ? Math.ceil(layout.height / 4) : layout.height;
      const pitch = pixelLayout(level, layout, rows, compression?.blockBytes ?? 1);
      totalBytes += layout.byteLength; totalSourceBytes += level.data.byteLength;
      if (totalBytes > maxBytes || totalSourceBytes > maxBytes) throw new Error("Texture byte budget exceeded.");
      return { source: level, layout, pitch, rows };
    });
    const sampler = samplerSettings(source.sampler);
    return { source, levels, sampler, compression };
  });
  return checked.map(({ source, levels, sampler, compression }) => ({
    id: source.id, revision: source.revision, semantic: source.semantic,
    format: source.semantic === "baseColor" || source.semantic === "emissive"
      ? (compression?.srgb ?? "rgba8unorm-srgb")
      : (compression?.linear ?? "rgba8unorm"),
    ...(compression ? { requiredFeature: compression.feature } : {}), sampler,
    samplerKey: JSON.stringify([sampler, levels.length]), byteLength: levels.reduce((sum, level) => sum + level.layout.byteLength, 0),
    levels: levels.map(({ source: pixels, layout, pitch, rows }) => {
      const data = new Uint8Array(layout.byteLength);
      for (let row = 0; row < rows; row++) data.set(pixels.data.subarray(row * pitch, row * pitch + layout.bytesPerRow), row * layout.bytesPerRow);
      return { ...layout, data };
    }),
  }));
}

export function sameTextureContent(a: PreparedTexture, b: PreparedTexture): boolean {
  return a.semantic === b.semantic && a.format === b.format && a.samplerKey === b.samplerKey && a.levels.length === b.levels.length
    && a.levels.every((level, index) => {
      const other = b.levels[index]!;
      return level.width === other.width && level.height === other.height && level.data.length === other.data.length
        && level.data.every((value, offset) => value === other.data[offset]);
    });
}
