import type { AlphaMode, PbrMaterial } from "../renderPacket.js";
import type { AdvancedMaterialParameters } from "../shader/materialAdvancedParameters.js";
import type { ExtendedMaterialParameters } from "../shader/materialParameters.js";
import type { DecodedTexture } from "../textures/decodedTexture.js";
import { ThreeTextureProjector, type ProjectedTexture } from "./textures.js";
import { invalid, record, unsupported, type ThreeProjectionHooks } from "./types.js";

const THREE = { frontSide: 0, backSide: 1, doubleSide: 2, normalBlending: 1, tangentSpaceNormalMap: 0 } as const;
const unsupportedTextureFields = ["alphaMap", "lightMap", "bumpMap", "displacementMap", "envMap"] as const;
const physicalTextureFields = ["anisotropyMap", "clearcoatMap", "clearcoatNormalMap", "clearcoatRoughnessMap",
  "iridescenceMap", "iridescenceThicknessMap", "sheenColorMap", "sheenRoughnessMap", "specularColorMap",
  "specularIntensityMap", "thicknessMap", "transmissionMap"] as const;

export function materialVisible(value: unknown): boolean { return record(value, "material").visible !== false; }

/** A2C-P1 maskFallback 的降级截止值:取证已验证的 MASK 档(0.4)—— discard 先于 a2c,
 * 图案在本机正确;纯 a2c 的阶梯覆盖语义退化为硬切,但远好于掩码失效时的全画实心板。 */
export const A2C_MASK_FALLBACK_ALPHA_CUTOFF = 0.4;

export interface ProjectedMaterial {
  readonly material: PbrMaterial;
  readonly textures: readonly DecodedTexture[];
  /** 作者请求的顶点色；接受的前提是几何携带颜色流，交叉校验由投影桥执行。 */
  readonly vertexColors: boolean;
  /** 作者请求的平面着色；不改 shader，由投影桥按派生合同展开非索引面法线几何。 */
  readonly flatShading: boolean;
  /** 作者声明的面朝向；back 在 DE26/C03 支持矩阵外，桥内 fail-closed。 */
  readonly side: "front" | "back" | "double";
  /** 深度写开关；OPAQUE/MASK 恒 true，BLEND 恒 false（weighted OIT 与 Native sorted blend 均不写深度）。 */
  readonly depthWrite: boolean;
}

/** advancedMaterials=true 表示渲染器带 advancedMaterials 变体:clearcoat / sheen / iridescence / 透射体积按 three r185 语义投影,否则维持"非中性即 fail-closed"。 */
export function projectMaterial(value: unknown, id: string, hooks: ThreeProjectionHooks,
  textures: ThreeTextureProjector, advancedMaterials = false, alphaToCoverageSupported = false,
  alphaToCoverageMaskFallback = false): ProjectedMaterial {
  const m = record(value, "material"), physical = m.isMeshPhysicalMaterial === true;
  const basic = m.type === "MeshBasicMaterial" && m.isMeshBasicMaterial === true;
  const standard = m.type === "MeshStandardMaterial" && m.isMeshStandardMaterial === true && !physical;
  if (!basic && !standard && !(physical && m.type === "MeshPhysicalMaterial" && m.isMeshStandardMaterial === true)) unsupported("material type");
  if (m.onBeforeRender !== hooks.materialBeforeRender || m.onBeforeCompile !== hooks.materialBeforeCompile
    || m.customProgramCacheKey !== hooks.materialProgramCacheKey) unsupported("material render hooks");
  validateDefines(m, physical, basic);
  if (basic) for (const key of ["aoMap", "specularMap"] as const) if (m[key] != null) unsupported(`material.${key}`);
  const lobes = physical ? validatePhysicalLobes(m, advancedMaterials) : undefined;
  for (const key of unsupportedTextureFields) if (m[key] != null) unsupported(`material.${key}`);
  // alphaHash(stochastic transparency)维持 fail-closed;alphaToCoverage(AA-M2)在
  // 渲染器声明 MSAA 主 pass 能力时按 three r185 语义投影(opt-in,见下)。
  if (m.alphaHash) unsupported("material alphaHash");
  if (m.alphaToCoverage !== undefined && typeof m.alphaToCoverage !== "boolean") invalid("material.alphaToCoverage");
  const alphaToCoverage = m.alphaToCoverage === true;
  // A2C-P1 降级门(maskFallback,渲染器探针判掩码未生效后由桥粘性开启):作者仍请求
  // a2c 时不再 fail-closed,而是把 a2c 语义降级为已验证的 MASK 档 —— 纯 a2c(OPAQUE,
  // 无 alphaTest)落到 alphaCutoff=0.4;作者已给 alphaTest>0 的 MASK 材质保留作者截止,
  // 仅丢弃 a2c 旗标。降级画质取舍如实:阶梯覆盖 → 硬切,边缘平滑损失换取图案正确。
  if (alphaToCoverage && !alphaToCoverageSupported && !alphaToCoverageMaskFallback) unsupported("material alphaToCoverage");
  // DE26/C03：premultipliedAlpha 缺省=未请求(straight)；true 仅在 BLEND 支持矩阵内，否则 fail-closed。
  if (m.premultipliedAlpha !== undefined && typeof m.premultipliedAlpha !== "boolean") invalid("material.premultipliedAlpha");
  if (m.blending !== THREE.normalBlending) unsupported("material.blending");

  const opacity = unit(m.opacity, "material.opacity"), alphaTest = nonnegative(m.alphaTest, "material.alphaTest");
  if (m.transparent !== true && m.transparent !== false) invalid("material.transparent");
  if (typeof m.fog !== "boolean") invalid("material.fog");
  const alphaMode: AlphaMode = m.transparent ? "BLEND" : alphaTest > 0 ? "MASK" : "OPAQUE";
  // AA-M2:a2c 的 sample-mask 语义只存在于多采样主 pass;BLEND 走 1x weighted OIT,
  // 组合无定义 → fail-closed(three 侧 a2c 与 transparent 共存时 a2c 实际不生效,这里显式拒绝;
  // maskFallback 档同样保留 —— 透明材质本就不吃 a2c 语义,拒绝的是无定义组合而不是能力缺失)。
  if (alphaToCoverage && alphaMode === "BLEND") unsupported("material alphaToCoverage with transparent");
  if (alphaMode === "OPAQUE" && opacity !== 1) unsupported("material opacity without alpha mode");
  // 透明语义矩阵(DE26/C03)：alphaMode 单值——transparent 压过 alphaTest，投影为 BLEND+alphaCutoff，
  // 不存在 MASK 与 BLEND 同时声明的表达；premultiplied 只描述 BLEND 的混合公式。
  if (alphaMode !== "BLEND" && m.premultipliedAlpha === true) unsupported("material.premultipliedAlpha");

  const side = m.side;
  if (side !== THREE.frontSide && side !== THREE.backSide && side !== THREE.doubleSide) invalid("material.side");
  if (side === THREE.backSide) unsupported("material.BackSide");
  // BLEND+DoubleSide 解除 two-pass 拒绝：weighted OIT 累积可交换，Three 的 two-pass 声明折叠为
  // 单 pass cull-none 数学等价；forceSinglePass 只要求布尔（缺省视为已声明单 pass 语义）。
  if (typeof m.forceSinglePass !== "boolean") invalid("material.forceSinglePass");
  if (m.wireframe) unsupported("material wireframe");
  // DE26/C02：vertexColors 要求几何颜色流（桥内交叉校验）；flatShading 走非索引面法线派生。
  // 两字段缺省（MeshBasicMaterial 无 flatShading）等价于未请求；提供时必须是布尔。
  if (m.flatShading !== undefined && typeof m.flatShading !== "boolean") invalid("material.flatShading");
  if (m.vertexColors !== undefined && typeof m.vertexColors !== "boolean") invalid("material.vertexColors");
  // BLEND 深度写固定 false：weighted OIT 与 Native sorted blend 都不写深度（见 alphaBlendSemantics）。
  // 作者请求 true 时 fail-closed，而不是静默丢设置；带截止的挖孔用 MASK。
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
  const specular = physical && advancedMaterials && m.specularIntensityMap != null ? textures.projectSpecular(m.specularIntensityMap) : undefined;
  const specularColor = physical && advancedMaterials && m.specularColorMap != null ? textures.projectSpecularColor(m.specularColorMap) : undefined;
  const specularFactor = physical && advancedMaterials ? unit(m.specularIntensity, "material.specularIntensity") : 1;
  const specularColorFactor = physical && advancedMaterials ? reflectanceColor3(m.specularColor) : [1, 1, 1] as const;
  // THREE.Color 和 emissive 已经处于线性工作色彩空间；不能再次执行 sRGB 解码。
  if (physical && (typeof m.ior !== "number" || m.ior < 1 || !Number.isFinite(Math.fround(m.ior)))) invalid("material.ior");
  // A2C-P1 降级投影(见上门注释):OPAQUE+a2c → MASK@A2C_MASK_FALLBACK_ALPHA_CUTOFF;
  // 作者已给截止的 MASK 保留作者 alphaTest,仅丢弃 a2c 旗标。alphaMode 校验(含
  // OPAQUE 要求 opacity=1)全部按作者原语义先行完成,这里只做投影端重映射。
  const maskFallbackActive = alphaToCoverage && alphaToCoverageMaskFallback;
  const projectedAlphaMode: AlphaMode = maskFallbackActive && alphaMode === "OPAQUE" ? "MASK" : alphaMode;
  const projectedCutoff = maskFallbackActive && alphaMode === "OPAQUE" ? A2C_MASK_FALLBACK_ALPHA_CUTOFF : alphaTest;
  const material: PbrMaterial = { id, baseColor: color, metallic, roughness,
    ...(specularFactor !== 1 ? { specularFactor } : {}),
    ...(specularColorFactor.some(value => value !== 1) ? { specularColorFactor } : {}),
    ...(specular ? { specularTexture: specular.slot } : {}),
    ...(specularColor ? { specularColorTexture: specularColor.slot } : {}),
    ...(physical ? { ior: m.ior as number } : {}),
    ...(lobes?.extended ? { extendedParameters: { ...lobes.extended, ior: m.ior as number } } : {}),
    ...(lobes?.advanced ? { advancedParameters: lobes.advanced } : {}),
    ...(basic ? { shadingModel: "unlit" as const } : {}),
    ...(m.fog === false ? { fog: false } : {}),
    ...(base ? { baseColorTexture: base.slot } : {}),
    ...(metallicRoughness ? { metallicRoughnessTexture: metallicRoughness.slot } : {}),
    ...(normal ? { normalTexture: { ...normal.texture.slot, normalScale: normal.scale } } : {}),
    ...(occlusion ? { occlusionTexture: { ...occlusion.texture.slot, strength: occlusion.strength } } : {}),
    ...(emissiveFactor.some(component => component !== 0) ? { emissiveFactor } : {}),
    ...(emissiveMap ? { emissiveTexture: emissiveMap.slot } : {}),
    ...(projectedAlphaMode === "OPAQUE" ? {} : { alphaMode: projectedAlphaMode, baseColorAlpha: opacity }),
    ...(projectedCutoff > 0 ? { alphaCutoff: projectedCutoff } : {}),
    ...(alphaToCoverage && !maskFallbackActive ? { alphaToCoverage: true } : {}),
    ...(m.premultipliedAlpha === true ? { premultipliedAlpha: true } : {}),
    ...(side === THREE.doubleSide ? { doubleSided: true } : {}) };
  return { material, textures: [base, metallicRoughness, normal?.texture, occlusion?.texture, emissiveMap, specular, specularColor]
    .filter((texture): texture is ProjectedTexture => texture !== undefined).map(texture => texture.resource),
    vertexColors: m.vertexColors === true, flatShading: m.flatShading === true,
    side: side === THREE.doubleSide ? "double" : "front", depthWrite: alphaMode !== "BLEND" };
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

/**
 * Physical 材质 lobes 校验与投影。未开启 advancedMaterials 时只有全部处于 r185 默认中性值才与
 * metallic-roughness 合同等价;开启后 clearcoat / sheen / iridescence / 透射体积(无贴图)投影为
 * 扩展参数,贴图、各向异性、色散、specular 扩展仍 fail-closed。
 */
function validatePhysicalLobes(m: Record<string, unknown>, advancedMaterials: boolean):
  { readonly extended?: ExtendedMaterialParameters; readonly advanced?: AdvancedMaterialParameters } | undefined {
  if (!advancedMaterials) { validateNeutralPhysical(m); return undefined; }
  for (const key of physicalTextureFields) if (m[key] != null && key !== "specularColorMap" && key !== "specularIntensityMap") unsupported(`material.${key}`);
  if (m.anisotropy !== 0 || m.anisotropyRotation !== 0 || m.dispersion !== 0
    || !same(vector2(m.clearcoatNormalScale, "material.clearcoatNormalScale"), [1, 1])) {
    unsupported("MeshPhysicalMaterial non-neutral extensions");
  }
  const clearcoat = unit(m.clearcoat, "material.clearcoat"), clearcoatRoughness = unit(m.clearcoatRoughness, "material.clearcoatRoughness");
  const sheen = unit(m.sheen, "material.sheen"), sheenRoughness = unit(m.sheenRoughness, "material.sheenRoughness");
  const sheenColor = color3(m.sheenColor, "material.sheenColor");
  const iridescence = unit(m.iridescence, "material.iridescence");
  const transmission = unit(m.transmission, "material.transmission"), thickness = nonnegative(m.thickness, "material.thickness");
  const iridescenceIor = m.iridescenceIOR, range = m.iridescenceThicknessRange;
  if (typeof iridescenceIor !== "number" || !Number.isFinite(iridescenceIor)) invalid("material.iridescenceIOR");
  if (!Array.isArray(range) || range.length !== 2 || !range.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)) {
    invalid("material.iridescenceThicknessRange");
  }
  const distance = m.attenuationDistance;
  if (typeof distance !== "number" || Number.isNaN(distance) || distance <= 0) invalid("material.attenuationDistance");
  const attenuationColor = color3(m.attenuationColor, "material.attenuationColor");
  // three 在 refreshUniformsPhysical 中按 >0 才装载各 lobe;其余字段值被忽略,这里同样忽略。
  const extended: ExtendedMaterialParameters | undefined = clearcoat > 0 || transmission > 0 ? {
    ior: m.ior as number, clearcoat: { factor: clearcoat > 0 ? clearcoat : 0, roughness: clearcoat > 0 ? clearcoatRoughness : 0 },
    anisotropy: { strength: 0, rotation: 0 }, transmission: { factor: transmission } } : undefined;
  const advanced: AdvancedMaterialParameters = {
    ...(sheen > 0 ? { sheen: { color: sheenColor.map(component => component * sheen) as [number, number, number], roughness: sheenRoughness } } : {}),
    ...(iridescence > 0 ? { iridescence: { factor: iridescence, ior: iridescenceIor as number, thickness: (range as number[])[1]! } } : {}),
    ...(transmission > 0 ? { volume: { thickness, attenuationColor,
      ...(Number.isFinite(distance) ? { attenuationDistance: distance as number } : {}) } } : {}),
  };
  return { ...(extended ? { extended } : {}), ...(Object.keys(advanced).length ? { advanced } : {}) };
}

function validateNeutralPhysical(m: Record<string, unknown>): void {
  for (const key of physicalTextureFields) if (m[key] != null) unsupported(`material.${key}`);
  const defaults: Readonly<Record<string, number>> = { anisotropy: 0, anisotropyRotation: 0, clearcoat: 0,
    clearcoatRoughness: 0, dispersion: 0, iridescence: 0, iridescenceIOR: 1.3,
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
function reflectanceColor3(value: unknown): [number, number, number] {
  const source = record(value, "material.specularColor"), result = [source.r, source.g, source.b];
  if (!result.every(component => typeof component === "number" && component >= 0 && Number.isFinite(Math.fround(component)))) invalid("material.specularColor");
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
