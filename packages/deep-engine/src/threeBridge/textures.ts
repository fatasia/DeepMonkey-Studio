import type { DecodedTexture, TextureSampler, TextureSemantic } from "../textures/decodedTexture.js";
import type { TextureSlot } from "../renderPacket.js";
import { invalid, limit, record, unsupported } from "./types.js";

const THREE = {
  uvMapping: 300,
  repeat: 1000,
  clamp: 1001,
  mirror: 1002,
  nearest: 1003,
  linear: 1006,
  unsignedByte: 1009,
  rgba: 1023,
} as const;

interface ReadableTexture {
  readonly source: object;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly colorSpace: string;
  readonly sampler: TextureSampler;
  readonly slot: Omit<TextureSlot, "texture">;
  readonly stamp: readonly unknown[];
  readonly authorRevision: number;
}

interface CachedTexture {
  readonly stamp: readonly unknown[];
  readonly resource: DecodedTexture;
}

export interface ProjectedTexture {
  readonly resource: DecodedTexture;
  readonly slot: TextureSlot;
}

/**
 * Three 纹理的同步快照器。只接受 CPU 可读的 RGBA8 DataTexture；缓存仅持有
 * Deep 自有像素，绝不调用 dispose、updateMatrix 或修改 needsUpdate。
 */
export class ThreeTextureProjector {
  private readonly cache = new Map<string, CachedTexture>();
  private acceptedIds = new Set<string>();
  private projectedIds = new Set<string>();
  private projectedBytes = 0;

  constructor(private readonly identity: (source: object) => string) {}

  beginProjection(): void {
    for (const id of this.cache.keys()) if (!this.acceptedIds.has(id)) this.cache.delete(id);
    this.projectedIds = new Set(); this.projectedBytes = 0;
  }

  acceptProjection(): void {
    this.acceptedIds = new Set(this.projectedIds);
    for (const id of this.cache.keys()) if (!this.acceptedIds.has(id)) this.cache.delete(id);
  }

  projectBaseColor(value: unknown): ProjectedTexture {
    return this.projectSingle(value, "material.map", "baseColor", convertSrgbSample);
  }

  projectEmissive(value: unknown): ProjectedTexture {
    return this.projectSingle(value, "material.emissiveMap", "emissive", convertSrgbSample);
  }

  projectNormal(value: unknown): ProjectedTexture {
    return this.projectSingle(value, "material.normalMap", "normal", convertLinearSample);
  }

  projectOcclusion(value: unknown): ProjectedTexture {
    return this.projectSingle(value, "material.aoMap", "occlusion", convertLinearSample);
  }

  projectMetallicRoughness(metalness: unknown, roughness: unknown): ProjectedTexture | undefined {
    if (metalness == null && roughness == null) return undefined;
    const metal = metalness == null ? undefined : readDataTexture(metalness, "material.metalnessMap");
    const rough = roughness == null ? undefined : readDataTexture(roughness, "material.roughnessMap");
    if (metal && rough) assertComposable(metal, rough);
    const source = metal ?? rough!;
    const metalId = metal ? this.identity(metal.source) : "neutral";
    const roughId = rough ? this.identity(rough.source) : "neutral";
    const id = `${metalId}+${roughId}/metallicRoughness`;
    this.reserve(id, source.data.byteLength);
    const stamp = [...(metal?.stamp ?? [null]), "roughness", ...(rough?.stamp ?? [null])];
    const authorRevision = Math.max(metal?.authorRevision ?? 0, rough?.authorRevision ?? 0);
    const resource = this.snapshot(id, "metallicRoughness", source.width, source.height, source.sampler,
      stamp, authorRevision,
      () => combineMetallicRoughness(metal, rough));
    return { resource, slot: { texture: id, ...source.slot } };
  }

  clear(): void { this.cache.clear(); this.acceptedIds.clear(); this.projectedIds.clear(); this.projectedBytes = 0; }

  private projectSingle(value: unknown, feature: string, semantic: TextureSemantic,
    pixels: (source: ReadableTexture) => Uint8Array): ProjectedTexture {
    const source = readDataTexture(value, feature), id = `${this.identity(source.source)}/${semantic}`;
    this.reserve(id, source.data.byteLength);
    const resource = this.snapshot(id, semantic, source.width, source.height, source.sampler,
      source.stamp, source.authorRevision, () => pixels(source));
    return { resource, slot: { texture: id, ...source.slot } };
  }

  private reserve(id: string, bytes: number): void {
    if (this.projectedIds.has(id)) return;
    this.projectedIds.add(id); this.projectedBytes += bytes;
    if (this.projectedIds.size > 4096 || this.projectedBytes > 128 * 1024 * 1024) limit("texture packet budget");
  }

  private snapshot(id: string, semantic: TextureSemantic, width: number, height: number, sampler: TextureSampler,
    stamp: readonly unknown[], authorRevision: number, pixels: () => Uint8Array): DecodedTexture {
    const previous = this.cache.get(id);
    if (previous && sameStamp(previous.stamp, stamp)) return previous.resource;
    const revision = previous ? Math.max(previous.resource.revision + 1, authorRevision) : authorRevision;
    const resource: DecodedTexture = { id, revision, semantic, width, height, data: pixels(), sampler };
    this.cache.set(id, { stamp: [...stamp], resource });
    return resource;
  }
}

function readDataTexture(value: unknown, feature: string): ReadableTexture {
  const texture = record(value, feature);
  if (texture.isTexture !== true || texture.isDataTexture !== true) unsupported(`${feature} image source`);
  if (texture.mapping !== THREE.uvMapping || texture.channel !== 0 && texture.channel !== 1) unsupported(`${feature} UV channel or mapping`);
  if (texture.format !== THREE.rgba || texture.type !== THREE.unsignedByte || texture.internalFormat != null) unsupported(`${feature} pixel format`);
  if (texture.flipY !== false || texture.premultiplyAlpha !== false) unsupported(`${feature} pixel transform`);
  if (texture.generateMipmaps !== false || !Array.isArray(texture.mipmaps) || texture.mipmaps.length) unsupported(`${feature} mipmaps`);
  if (![1, 2, 4, 8].includes(texture.unpackAlignment as number)) invalid(`${feature} unpack alignment`);
  const version = texture.version as number;
  const sourceRecord = record(texture.source, `${feature} source`), sourceVersion = sourceRecord.version as number;
  if (!Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(sourceVersion) || sourceVersion < 1
    || sourceRecord.dataReady === false) invalid(`${feature} upload state`);
  const image = record(texture.image, `${feature} image`), width = image.width as number, height = image.height as number;
  if (!Number.isSafeInteger(width) || width < 1 || width > 16384 || !Number.isSafeInteger(height) || height < 1 || height > 16384) invalid(`${feature} dimensions`);
  const data = image.data;
  if (!(data instanceof Uint8Array)) unsupported(`${feature} RGBA8 storage`);
  if (!(data.buffer instanceof ArrayBuffer)) unsupported(`${feature} shared storage`);
  if (data.byteLength !== width * height * 4) invalid(`${feature} RGBA8 layout`);
  if (data.byteLength > 128 * 1024 * 1024) limit(`${feature} bytes`);
  const sampler = readSampler(texture, feature);
  const slot = readTextureTransform(texture, feature, texture.channel as 0 | 1);
  const colorSpace = texture.colorSpace;
  if (typeof colorSpace !== "string" || !["", "srgb", "srgb-linear"].includes(colorSpace)) unsupported(`${feature} color space`);
  return { source: texture, width, height, data, colorSpace, sampler, slot, authorRevision: Math.max(version, sourceVersion),
    stamp: [texture, width, height, image, data, data.buffer, data.byteOffset, data.byteLength, version, texture.source,
      sourceVersion, texture.mapping, texture.channel, texture.format, texture.type, texture.internalFormat,
      texture.flipY, texture.premultiplyAlpha, texture.generateMipmaps, texture.unpackAlignment, colorSpace,
      sampler.addressModeU, sampler.addressModeV, sampler.magFilter, sampler.minFilter, sampler.mipmapFilter,
      sampler.maxAnisotropy] };
}

function readSampler(texture: Record<string, unknown>, feature: string): TextureSampler {
  const address = (value: unknown): "repeat" | "clamp-to-edge" | "mirror-repeat" => {
    if (value === THREE.repeat) return "repeat";
    if (value === THREE.clamp) return "clamp-to-edge";
    if (value === THREE.mirror) return "mirror-repeat";
    unsupported(`${feature} wrapping`);
  };
  const filter = (value: unknown): "nearest" | "linear" => {
    if (value === THREE.nearest) return "nearest";
    if (value === THREE.linear) return "linear";
    unsupported(`${feature} mip filter`);
  };
  const anisotropy = texture.anisotropy as number;
  if (!Number.isSafeInteger(anisotropy) || anisotropy < 1) invalid(`${feature} anisotropy`);
  if (anisotropy > 16) limit(`${feature} anisotropy`);
  const magFilter = filter(texture.magFilter), minFilter = filter(texture.minFilter);
  if (anisotropy > 1 && (magFilter !== "linear" || minFilter !== "linear")) unsupported(`${feature} anisotropic filtering`);
  return { addressModeU: address(texture.wrapS), addressModeV: address(texture.wrapT), magFilter, minFilter,
    mipmapFilter: "nearest", maxAnisotropy: anisotropy };
}

function readTextureTransform(texture: Record<string, unknown>, feature: string, texCoord: 0 | 1): Omit<TextureSlot, "texture"> {
  const matrix = texture.matrixAutoUpdate === true ? automaticMatrix(texture, feature)
    : manualMatrix(texture.matrix, feature);
  const [a, b, tx, c, d, ty] = matrix;
  const sx = Math.hypot(a, c), sy = Math.hypot(b, d);
  if (sx < 1e-12 || sy < 1e-12) unsupported(`${feature} singular UV transform`);
  const rotation = Math.atan2(c, a), expected = [Math.cos(rotation) * sx, -Math.sin(rotation) * sy,
    Math.sin(rotation) * sx, Math.cos(rotation) * sy];
  const actual = [a, b, c, d], tolerance = 1e-6 * Math.max(1, sx, sy);
  if (actual.some((value, index) => Math.abs(value - expected[index]!) > tolerance)) unsupported(`${feature} non-decomposable UV transform`);
  const values = [tx, ty, sx, sy, rotation];
  if (!values.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value)))) invalid(`${feature} UV transform`);
  const clean = (value: number) => Object.is(Math.fround(value), -0) ? 0 : Math.fround(value);
  return { texCoord, offset: [clean(tx), clean(ty)], scale: [clean(sx), clean(sy)], rotation: clean(rotation) };
}

function automaticMatrix(texture: Record<string, unknown>, feature: string): readonly [number, number, number, number, number, number] {
  const offset = vector(texture.offset, `${feature} offset`), repeat = vector(texture.repeat, `${feature} repeat`), center = vector(texture.center, `${feature} center`);
  const rotation = texture.rotation as number;
  if (!Number.isFinite(rotation)) invalid(`${feature} rotation`);
  const c = Math.cos(rotation), s = Math.sin(rotation);
  return [repeat[0] * c, repeat[0] * s, -repeat[0] * (c * center[0] + s * center[1]) + center[0] + offset[0],
    -repeat[1] * s, repeat[1] * c, -repeat[1] * (-s * center[0] + c * center[1]) + center[1] + offset[1]];
}

function manualMatrix(value: unknown, feature: string): readonly [number, number, number, number, number, number] {
  const matrix = record(value, `${feature} matrix`), elements = matrix.elements;
  if (!elements || typeof elements !== "object" || !("length" in elements) || (elements as ArrayLike<number>).length !== 9) invalid(`${feature} matrix`);
  const e = elements as ArrayLike<number>, values = [e[0], e[3], e[6], e[1], e[4], e[7], e[2], e[5], e[8]];
  if (!values.every(value => typeof value === "number" && Number.isFinite(value))) invalid(`${feature} matrix`);
  if (Math.abs(values[6]!) > 1e-7 || Math.abs(values[7]!) > 1e-7 || Math.abs(values[8]! - 1) > 1e-7) unsupported(`${feature} projective UV transform`);
  return values.slice(0, 6) as unknown as readonly [number, number, number, number, number, number];
}

function vector(value: unknown, feature: string): readonly [number, number] {
  const v = record(value, feature);
  if (typeof v.x !== "number" || typeof v.y !== "number" || !Number.isFinite(v.x) || !Number.isFinite(v.y)) invalid(feature);
  return [v.x, v.y];
}

function assertComposable(a: ReadableTexture, b: ReadableTexture): void {
  if (a.width !== b.width || a.height !== b.height || JSON.stringify(a.sampler) !== JSON.stringify(b.sampler)
    || JSON.stringify(a.slot) !== JSON.stringify(b.slot)) unsupported("material.metalnessMap/roughnessMap combination");
}

/** Deep 的颜色纹理使用 sRGB view；把 Three 线性/无标记字节转成等价的 sRGB 存储。 */
function convertSrgbSample(source: ReadableTexture): Uint8Array {
  const output = source.data.slice();
  if (source.colorSpace !== "srgb") for (let i = 0; i < output.length; i += 4) {
    output[i] = linearToSrgb(output[i]!); output[i + 1] = linearToSrgb(output[i + 1]!); output[i + 2] = linearToSrgb(output[i + 2]!);
  }
  return output;
}

/** Deep 的数据纹理使用线性 view；若 Three 的源纹理声明为 sRGB，固化其采样时传递函数。 */
function convertLinearSample(source: ReadableTexture): Uint8Array {
  const output = source.data.slice();
  if (source.colorSpace === "srgb") for (let i = 0; i < output.length; i += 4) {
    output[i] = linearChannel(output[i]!, source.colorSpace);
    output[i + 1] = linearChannel(output[i + 1]!, source.colorSpace);
    output[i + 2] = linearChannel(output[i + 2]!, source.colorSpace);
  }
  return output;
}

function combineMetallicRoughness(metal: ReadableTexture | undefined, rough: ReadableTexture | undefined): Uint8Array {
  const source = metal ?? rough!, output = new Uint8Array(source.width * source.height * 4);
  for (let i = 0; i < output.length; i += 4) {
    output[i] = 255;
    output[i + 1] = rough ? linearChannel(rough.data[i + 1]!, rough.colorSpace) : 255;
    output[i + 2] = metal ? linearChannel(metal.data[i + 2]!, metal.colorSpace) : 255;
    output[i + 3] = 255;
  }
  return output;
}

function linearChannel(value: number, colorSpace: string): number {
  if (colorSpace !== "srgb") return value;
  const c = value / 255;
  return Math.round(255 * (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
}

function linearToSrgb(value: number): number {
  const c = value / 255;
  return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
}

function sameStamp(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
