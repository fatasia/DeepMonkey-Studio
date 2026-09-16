import type { AlphaMode, PbrMaterial } from "../renderPacket.js";
import type { DecodedTexture } from "../textures/decodedTexture.js";
import { ThreeTextureProjector, type ProjectedTexture } from "./textures.js";
import { invalid, record, unsupported, type ThreeProjectionHooks } from "./types.js";

const THREE = { frontSide: 0, backSide: 1, doubleSide: 2, normalBlending: 1, tangentSpaceNormalMap: 0 } as const;
const unsupportedTextureFields = ["alphaMap", "lightMap", "bumpMap", "displacementMap", "envMap"] as const;
const physicalTextureFields = ["anisotropyMap", "clearcoatMap", "clearcoatNormalMap", "clearcoatRoughnessMap",
  "iridescenceMap", "iridescenceThicknessMap", "sheenColorMap", "sheenRoughnessMap", "specularColorMap",
  "specularIntensityMap", "thicknessMap", "transmissionMap"] as const;

export function materialVisible(value: unknown): boolean { return record(value, "material").visible !== false; }

export interface ProjectedMaterial {
  readonly material: PbrMaterial;
  readonly textures: readonly DecodedTexture[];
  /** 作者请求的顶点色；接受的前提是几何携带颜色流，交叉校验由投影桥执行。 */
  readonly vertexColors: boolean;
  /** 作者请求的平面着色；不改 shader，由投影桥按派生合同展开非索引面法线几何。 */
  readonly flatShading: boolean;
}

export function projectMaterial(value: unknown, id: string, hooks: ThreeProjectionHooks,
  textures: ThreeTextureProjector): ProjectedMaterial {
  const m = record(value, "material"), physical = m.isMeshPhysicalMaterial === true;
  const basic = m.type === "MeshBasicMaterial" && m.isMeshBasicMaterial === true;
  const standard = m.type === "MeshStandardMaterial" && m.isMeshStandardMaterial === true && !physical;
  if (!basic && !standard && !(physical && m.type === "MeshPhysicalMaterial" && m.isMeshStandardMaterial === true)) unsupported("material type");
  if (m.onBeforeRender !== hooks.materialBeforeRender || m.onBeforeCompile !== hooks.materialBeforeCompile
    || m.customProgramCacheKey !== hooks.materialProgramCacheKey) unsupported("material render hooks");
  validateDefines(m, physical, basic);
  if (basic) for (const key of ["aoMap", "specularMap"] as const) if (m[key] != null) unsupported(`material.${key}`);
  if (physical) validateNeutralPhysical(m);
  for (const key of unsupportedTextureFields) if (m[key] != null) unsupported(`material.${key}`);
  if (m.alphaHash || m.alphaToCoverage) unsupported("material stochastic alpha");
  if (m.premultipliedAlpha) unsupported("material.premultipliedAlpha");
  if (m.blending !== THREE.normalBlending) unsupported("material.blending");

  const opacity = unit(m.opacity, "material.opacity"), alphaTest = nonnegative(m.alphaTest, "material.alphaTest");
  if (m.transparent !== true && m.transparent !== false) invalid("material.transparent");
  if (typeof m.fog !== "boolean") invalid("material.fog");
  const alphaMode: AlphaMode = m.transparent ? "BLEND" : alphaTest > 0 ? "MASK" : "OPAQUE";
  if (alphaMode === "OPAQUE" && opacity !== 1) unsupported("material opacity without alpha mode");

  const side = m.side;
  if (side !== THREE.frontSide && side !== THREE.backSide && side !== THREE.doubleSide) invalid("material.side");
  if (side === THREE.backSide) unsupported("material.BackSide");
  if (alphaMode === "BLEND" && side === THREE.doubleSide && m.forceSinglePass !== true) {
    unsupported("material transparent DoubleSide two-pass rendering");
  }
  if (typeof m.forceSinglePass !== "boolean") invalid("material.forceSinglePass");
  if (m.wireframe) unsupported("material wireframe");
  // DE26/C02：vertexColors 要求几何颜色流（桥内交叉校验）；flatShading 走非索引面法线派生。
  // 两字段缺省（MeshBasicMaterial 无 flatShading）等价于未请求；提供时必须是布尔。
  if (m.flatShading !== undefined && typeof m.flatShading !== "boolean") invalid("material.flatShading");
  if (m.vertexColors !== undefined && typeof m.vertexColors !== "boolean") invalid("material.vertexColors");
  // Deep BLEND 固定关闭 depth write；Three 的默认 true 无法无损表达，调用侧需显式采用透明材质惯例。
  if (alphaMode === "BLEND" && m.depthWrite !== false) unsupported("material transparent depthWrite");
  if (m.depthTest !== true || alphaMode !== "BLEND" && m.depthWrite !== true
    || m.depthFunc !== 3 || m.colorWrite !== true || m.stencilWrite || m.polygonOffset || m.toneMapped !== true || m.dithering) {
    unsupported("material render state");
  }
  if (Array.isArray(m.clippingPlanes) && m.clippingPlanes.length || m.shadowSide != null) unsupported("material clipping or shadow side");

  const color = color3(m.color, "material.color"), emissive = basic ? [0, 0, 0] : color3(m.emissive, "material.emissive");
  const metallic = basic ? 0 : unit(m.metalness, "material.metalness"), roughness = basic ? 1 : unit(m.roughness, "material.roughness");
  const emissiveIntensity = basic ? 0 : nonnegative(m.emissiveIntensity, "material.emissiveIntensity");
  const emissiveFactor = emissive.map(component => component * emissiveIntensity) as [number, number, number];
  if (!emissiveFactor.every(component => component <= 1 && Number.isFinite(Math.fround(component)))) {
    unsupported("material emissive HDR factor");
  }

  const base = m.map == null ? undefined : textures.projectBaseColor(m.map);
  const metallicRoughness = basic ? undefined : textures.projectMetallicRoughness(m.metalnessMap, m.roughnessMap);
  const normal = basic ? undefined : projectNormal(m, textures), occlusion = basic ? undefined : projectOcclusion(m, textures);
  const emissiveMap = basic || m.emissiveMap == null ? undefined : textures.projectEmissive(m.emissiveMap);
  // THREE.Color 和 emissive 已经处于线性工作色彩空间；不能再次执行 sRGB 解码。
  const material: PbrMaterial = { id, baseColor: color, metallic, roughness,
    ...(basic ? { shadingModel: "unlit" as const } : {}),
    ...(m.fog === false ? { fog: false } : {}),
    ...(base ? { baseColorTexture: base.slot } : {}),
    ...(metallicRoughness ? { metallicRoughnessTexture: metallicRoughness.slot } : {}),
    ...(normal ? { normalTexture: { ...normal.texture.slot, normalScale: normal.scale } } : {}),
    ...(occlusion ? { occlusionTexture: { ...occlusion.texture.slot, strength: occlusion.strength } } : {}),
    ...(emissiveFactor.some(component => component !== 0) ? { emissiveFactor } : {}),
    ...(emissiveMap ? { emissiveTexture: emissiveMap.slot } : {}),
    ...(alphaMode === "OPAQUE" ? {} : { alphaMode, baseColorAlpha: opacity }),
    ...(alphaTest > 0 ? { alphaCutoff: alphaTest } : {}),
    ...(side === THREE.doubleSide ? { doubleSided: true } : {}) };
  return { material, textures: [base, metallicRoughness, normal?.texture, occlusion?.texture, emissiveMap]
    .filter((texture): texture is ProjectedTexture => texture !== undefined).map(texture => texture.resource),
    vertexColors: m.vertexColors === true, flatShading: m.flatShading === true };
}

function projectNormal(m: Record<string, unknown>, textures: ThreeTextureProjector): { texture: ProjectedTexture; scale: number } | undefined {
  if (m.normalMap == null) return undefined;
  if (m.normalMapType !== THREE.tangentSpaceNormalMap) unsupported("material.normalMapType");
  const scale = vector2(m.normalScale, "material.normalScale");
  if (scale[0] !== scale[1]) unsupported("material non-uniform normalScale");
  return { texture: textures.projectNormal(m.normalMap), scale: scale[0] };
}

function projectOcclusion(m: Record<string, unknown>, textures: ThreeTextureProjector): { texture: ProjectedTexture; strength: number } | undefined {
  if (m.aoMap == null) return undefined;
  return { texture: textures.projectOcclusion(m.aoMap), strength: unit(m.aoMapIntensity, "material.aoMapIntensity") };
}

function validateDefines(m: Record<string, unknown>, physical: boolean, basic: boolean): void {
  const defines = record(basic && m.defines === undefined ? {} : m.defines, "material.defines"),
    expected = basic ? [] : physical ? ["PHYSICAL", "STANDARD"] : ["STANDARD"];
  const actual = Object.keys(defines).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index] || defines[key] !== "")) {
    unsupported("material.defines");
  }
}

/** Physical 只有扩展 lobes 全部处于 r185 默认中性值时，才与当前 metallic-roughness 合同等价。 */
function validateNeutralPhysical(m: Record<string, unknown>): void {
  for (const key of physicalTextureFields) if (m[key] != null) unsupported(`material.${key}`);
  const defaults: Readonly<Record<string, number>> = { anisotropy: 0, anisotropyRotation: 0, clearcoat: 0,
    clearcoatRoughness: 0, dispersion: 0, ior: 1.5, iridescence: 0, iridescenceIOR: 1.3,
    sheen: 0, sheenRoughness: 1, specularIntensity: 1, thickness: 0, transmission: 0 };
  if (Object.entries(defaults).some(([key, expected]) => m[key] !== expected) || m.attenuationDistance !== Infinity
    || !same(color3(m.attenuationColor, "material.attenuationColor"), [1, 1, 1])
    || !same(color3(m.specularColor, "material.specularColor"), [1, 1, 1])
    || !same(color3(m.sheenColor, "material.sheenColor"), [0, 0, 0])
    || !same(vector2(m.clearcoatNormalScale, "material.clearcoatNormalScale"), [1, 1])
    || !Array.isArray(m.iridescenceThicknessRange) || !same(m.iridescenceThicknessRange as number[], [100, 400])) {
    unsupported("MeshPhysicalMaterial non-neutral extensions");
  }
}

function color3(value: unknown, feature: string): [number, number, number] {
  const c = record(value, feature), result = [c.r, c.g, c.b];
  if (!result.every(component => typeof component === "number" && Number.isFinite(component)
    && component >= 0 && component <= 1 && Number.isFinite(Math.fround(component)))) invalid(feature);
  return result as [number, number, number];
}
function vector2(value: unknown, feature: string): [number, number] {
  const v = record(value, feature), result = [v.x, v.y];
  if (!result.every(component => typeof component === "number" && Number.isFinite(component) && Number.isFinite(Math.fround(component)))) invalid(feature);
  return result as [number, number];
}
function unit(value: unknown, feature: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1 || !Number.isFinite(Math.fround(value))) invalid(feature);
  return value;
}
function nonnegative(value: unknown, feature: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isFinite(Math.fround(value))) invalid(feature);
  return value;
}
function same(a: readonly number[], b: readonly number[]): boolean { return a.length === b.length && a.every((value, index) => value === b[index]); }
