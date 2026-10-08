import type { SceneMaterialState } from "@bim-studio/contracts";
import type { DecodedTexture, TextureSemantic, TextureSlot } from "@bim-studio/deep-engine";
import { GltfImportError, generateTangents, validateTangentBasis,
  type GltfDecodedImage, type GltfImageDecoder, type GltfEncodedImage, type GltfTextureMimeType } from "@bim-studio/deep-engine/gltf";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { resolveMaterialTextureTransform } from "../viewer/materialTextureTransform";
import { capImageDimension, textureDimensionCap } from "./textureBudget";
import { appearanceUnsupportedError } from "./sceneNeutralAppearance";

/**
 * 场景级贴图覆盖(extended appearance)进入 Deep 原生链的编译桥。
 *
 * 作者状态中的 5 个贴图槽(baseColor/normal/AO/roughness/metalness)由本模块从项目
 * 资源 URL 解码为 RenderPacket 纹理并接线材质槽;roughness+metalness 按 Deep 既有
 * metallicRoughness 口径打包(g=roughness, b=metalness, 缺失通道 255 = 标量直通,与
 * threeBridge 投影桥 combineMetallicRoughness 逐位同规)。emissive/UV 动画/屏幕投影
 * 不在白名单,由 sceneMaterialOverrides 照旧按 SceneAppearanceUnsupported 降级。
 */

/**
 * 允许进入 Deep 原生链的作者材质键:*MapUrl/*MapName 为字符串(贴图与展示元数据),
 * UV 变换六字段为有限数值(与作者画布 applyMaterialTextureTransform 同一语义域)。
 * emissive/UV 动画/屏幕投影不在白名单,照旧按 SceneAppearanceUnsupported 降级。
 */
const TEXTURE_URL_FIELDS: ReadonlySet<string> = new Set([
  "baseColorMapUrl", "baseColorMapName", "normalMapUrl", "normalMapName",
  "ambientOcclusionMapUrl", "ambientOcclusionMapName",
  "roughnessMapUrl", "roughnessMapName", "metalnessMapUrl", "metalnessMapName",
]);
const TEXTURE_TRANSFORM_FIELDS: ReadonlySet<string> = new Set([
  "textureRepeat", "textureRepeatX", "textureRepeatY", "textureOffsetX", "textureOffsetY", "textureRotation",
]);

/** 白名单判定:键在列且值类型正确(URL 字符串 / 变换有限数值)。 */
export function isSupportedAuthorTextureField(key: string, value: unknown): boolean {
  if (TEXTURE_URL_FIELDS.has(key)) return typeof value === "string";
  if (TEXTURE_TRANSFORM_FIELDS.has(key)) return typeof value === "number" && Number.isFinite(value);
  return false;
}

/** 未设引擎解码预算时的作者贴图兜底预算;与 prepareTextures 的全局 128MB 顶一致。 */
const DEFAULT_TEXTURE_BUDGET_BYTES = 128 * 1024 * 1024;

/** 字段级合并全局与槽级覆盖(槽优先,与 applyStaticMaterialOverrides 的合并次序一致)。 */
export function effectiveTextureState(global: SceneMaterialState | undefined,
  slot: SceneMaterialState | undefined): SceneMaterialState | undefined {
  if (!global && !slot) return undefined;
  return { ...(global ?? {}), ...(slot ?? {}) };
}

/** 场景是否存在作者贴图覆盖(全局或槽级,URL 非空);决定解码是否保留无源纹理基元的 UV 流。 */
export function sceneHasAuthorTextureOverrides(
  models: readonly { readonly material?: SceneMaterialState }[]): boolean {
  return models.some(model => [model.material, ...Object.values(model.material?.slotOverrides ?? {})]
    .some(state => [state?.baseColorMapUrl, state?.normalMapUrl, state?.ambientOcclusionMapUrl,
      state?.roughnessMapUrl, state?.metalnessMapUrl].some(url => typeof url === "string" && url.trim() !== "")));
}

export function authorTextureId(url: string, semantic: TextureSemantic): string {
  return `author-${runtimeContentSha256([url, semantic])}-${semantic}`;
}

/** 单张解码图像按 RGBA8 计入预算;与 GLB 内嵌纹理同口径。 */
function decodedBytes(image: { readonly width: number; readonly height: number }): number {
  return image.width * image.height * 4;
}

/** TextureLoader author maps use flipY=true; packet textures use top-down UV upload. */
function authorImageOrientation(image: GltfDecodedImage): GltfDecodedImage {
  const stride = image.bytesPerRow ?? image.width * 4;
  const data = new Uint8Array(stride * image.height);
  for (let row = 0; row < image.height; row++) {
    data.set(image.data.subarray(row * stride, (row + 1) * stride), (image.height - row - 1) * stride);
  }
  return { ...image, data };
}

function sniffTextureMime(bytes: Uint8Array): GltfTextureMimeType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return undefined;
}

/**
 * 作者贴图槽的 UV 变换。作者画布经 applyMaterialTextureTransform 固定 center(0.5,0.5)
 * 的 three 旋转语义;这里按 three r186 setUvTransform 重建矩阵,再以 ThreeTextureProjector
 * 同一分解式拆成 Deep 槽参数,保证重建矩阵与作者画布逐位一致。各向异性重复 + 旋转的组合
 * 无法分解(投影桥同样拒绝)→ fail-closed 回退投影路径。
 */
export function authorTextureTransform(state: SceneMaterialState): Required<Pick<TextureSlot, "offset" | "scale" | "rotation">> {
  const transform = resolveMaterialTextureTransform(state);
  const c = Math.cos(transform.rotation), s = Math.sin(transform.rotation);
  // three Matrix3.setUvTransform 精确展开(center 固定 0.5):
  const a = transform.repeatX * c, b = transform.repeatX * s;
  const tx = -transform.repeatX * (c * 0.5 + s * 0.5) + 0.5 + transform.offsetX;
  const d = transform.repeatY * c, e = -transform.repeatY * s;
  const ty = -transform.repeatY * (-s * 0.5 + c * 0.5) + 0.5 + transform.offsetY;
  const sx = Math.hypot(a, e), sy = Math.hypot(b, d), rotation = Math.atan2(e, a);
  const expected = [Math.cos(rotation) * sx, -Math.sin(rotation) * sy, Math.sin(rotation) * sx, Math.cos(rotation) * sy];
  const tolerance = 1e-6 * Math.max(1, sx, sy);
  if ([a, b, e, d].some((value, index) => Math.abs(value - expected[index]!) > tolerance)
    || ![sx, sy, rotation, tx, ty].every(Number.isFinite)) {
    throw appearanceUnsupportedError("贴图 UV 变换(各向异性重复 + 旋转)超出 Deep 贴图槽表达能力");
  }
  // 与引擎 prepareTextureSlot 的 -0 归零惯例一致,保证包内容确定。
  const clean = (value: number): number => Object.is(Math.fround(value), -0) ? 0 : Math.fround(value);
  return { offset: [clean(tx), clean(ty)], scale: [clean(sx), clean(sy)], rotation: clean(rotation) };
}

/**
 * roughness+metalness → metallicRoughness 打包;缺失图对应通道 255(标量直通)。
 * 双图尺寸不一致无法共享 UV 变换,fail-closed 交给投影路径。
 */
export function packAuthorMetallicRoughness(roughness: GltfDecodedImage | undefined,
  metalness: GltfDecodedImage | undefined): GltfDecodedImage | undefined {
  const source = roughness ?? metalness;
  if (!source) return undefined;
  if (roughness && metalness && (roughness.width !== metalness.width || roughness.height !== metalness.height)) {
    throw appearanceUnsupportedError("粗糙度与金属度贴图尺寸不一致,Deep 单贴图槽无法合成");
  }
  const output = new Uint8Array(source.width * source.height * 4);
  for (let index = 0; index < output.length; index += 4) {
    output[index] = 255;
    output[index + 1] = roughness ? roughness.data[index + 1]! : 255;
    output[index + 2] = metalness ? metalness.data[index + 2]! : 255;
    output[index + 3] = 255;
  }
  return { width: source.width, height: source.height, data: output };
}

/** 编译期的作者贴图解析器:同 URL 去重加载/解码,同 (URL, 语义) 去重登记。 */
export class AuthorTextureResolver {
  private readonly bytes = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  private readonly images = new Map<string, Promise<GltfDecodedImage>>();
  private readonly entries = new Map<string, DecodedTexture>();
  private readonly registeredTextures: DecodedTexture[] = [];
  private usedBytes = 0;

  constructor(private readonly source: {
    readonly loadTexture: (url: string, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
    readonly imageDecoder: GltfImageDecoder;
  }, budgetBytes: number | undefined, private readonly signal: AbortSignal) {
    this.budgetBytes = budgetBytes ?? DEFAULT_TEXTURE_BUDGET_BYTES;
  }

  private readonly budgetBytes: number;

  /**
   * 解码并登记一张作者贴图,返回包内纹理 id。格式仅支持 PNG/JPEG(与 GLB 解码子集
   * 一致);超预算先按 GLB 同一梯子降边长,仍超则抛 SceneAppearanceUnsupported。
   */
  async resolve(url: string, semantic: TextureSemantic): Promise<string> {
    const key = `${semantic}\n${url}`;
    const cached = this.entries.get(key);
    if (cached) return cached.id;
    const texture = await this.registerEntry(url, semantic);
    this.entries.set(key, texture);
    this.registeredTextures.push(texture);
    return texture.id;
  }

  /** 本次编译登记的全部作者纹理(未被任何材质消费的会被 prepareRenderPacket 过滤)。 */
  registered(): readonly DecodedTexture[] { return this.registeredTextures; }

  /**
   * roughness+metalness → metallicRoughness 打包登记(至少一个 URL)。打包图不降采样:
   * 超预算直接 SceneAppearanceUnsupported(与单图梯子降采样不同,这里如实失败)。
   */
  async resolveMetallicRoughness(roughUrl: string | undefined, metalUrl: string | undefined): Promise<string> {
    if (!roughUrl && !metalUrl) throw new Error("金属粗糙度打包需要至少一个贴图 URL");
    const key = `metallicRoughness\n${roughUrl ?? ""}|${metalUrl ?? ""}`;
    const cached = this.entries.get(key);
    if (cached) return cached.id;
    const [rough, metal] = await Promise.all([roughUrl ? this.loadImage(roughUrl) : undefined,
      metalUrl ? this.loadImage(metalUrl) : undefined]);
    const packed = packAuthorMetallicRoughness(rough, metal);
    if (!packed) throw new Error("金属粗糙度打包需要至少一个贴图 URL");
    const remaining = this.budgetBytes - this.usedBytes;
    if (decodedBytes(packed) > remaining) {
      throw appearanceUnsupportedError(`作者贴图 ${roughUrl ?? metalUrl} 超出 Deep 纹理解码预算`);
    }
    this.usedBytes += decodedBytes(packed);
    const texture: DecodedTexture = { id: authorTextureId(key, "metallicRoughness"), revision: 0,
      semantic: "metallicRoughness", width: packed.width, height: packed.height, data: packed.data };
    this.entries.set(key, texture);
    this.registeredTextures.push(texture);
    return texture.id;
  }

  private loadBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
    const cached = this.bytes.get(url);
    if (cached) return cached;
    const task = this.source.loadTexture(url, this.signal).then((value) => {
      this.signal.throwIfAborted();
      return value;
    });
    this.bytes.set(url, task);
    return task;
  }

  private loadImage(url: string): Promise<GltfDecodedImage> {
    const cached = this.images.get(url);
    if (cached) return cached;
    const task = this.loadBytes(url).then(async (bytes) => {
      const mimeType = sniffTextureMime(bytes);
      if (!mimeType) throw appearanceUnsupportedError(`作者贴图 ${url} 的格式 Deep 编译仅支持 PNG/JPEG`);
      const encoded: GltfEncodedImage = { id: url, imageIndex: 0, mimeType, data: bytes };
      const decoded = await this.source.imageDecoder.decode(encoded, this.signal);
      this.signal.throwIfAborted();
      return authorImageOrientation(decoded);
    });
    this.images.set(url, task);
    return task;
  }

  private async registerEntry(url: string, semantic: TextureSemantic): Promise<DecodedTexture> {
    let image = await this.loadImage(url);
    const remaining = this.budgetBytes - this.usedBytes;
    if (decodedBytes(image) > remaining) {
      // 与 GLB 路径同一梯子降边长(capImageDimension 解码后盒式减半),给同场其余贴图留预算;
      // textureDimensionCap 超预算时返回最低档而非 undefined,降采样后仍超则 fail-closed。
      const cap = textureDimensionCap([[image.width, image.height]], Math.max(1, remaining)) ?? 256;
      const mimeType = sniffTextureMime(await this.loadBytes(url))!;
      image = authorImageOrientation(await capImageDimension(this.source.imageDecoder, cap)
        .decode({ id: url, imageIndex: 0, mimeType, data: await this.loadBytes(url) }, this.signal));
      this.signal.throwIfAborted();
      if (decodedBytes(image) > remaining) throw appearanceUnsupportedError(`作者贴图 ${url} 超出 Deep 纹理解码预算`);
    }
    this.usedBytes += decodedBytes(image);
    return { id: authorTextureId(url, semantic), revision: 0, semantic, width: image.width, height: image.height,
      data: image.data, ...(image.bytesPerRow === undefined ? {} : { bytesPerRow: image.bytesPerRow }) };
  }
}

/** 几何无切线时为作者法线贴图生成切线基;镜像 UV/退化几何抛 GltfImportError(按槽降级)。 */
export function ensureGeometryTangents<G extends { readonly vertices: Float32Array<ArrayBuffer>;
  readonly uv0?: Float32Array<ArrayBuffer>; readonly indices: Uint32Array<ArrayBuffer>;
  readonly tangents?: Float32Array<ArrayBuffer>; }>(geometry: G, path: string):
  G & { readonly tangents: Float32Array<ArrayBuffer> } {
  if (geometry.tangents) return geometry as G & { readonly tangents: Float32Array<ArrayBuffer> };
  if (!geometry.uv0) throw new GltfImportError("unsupported", path, "缺少 TEXCOORD_0,法线贴图切线基不可生成");
  const tangents = generateTangents(geometry.vertices, geometry.uv0, geometry.indices, path);
  validateTangentBasis(geometry.vertices, tangents, geometry.indices, path);
  return { ...geometry, tangents };
}
