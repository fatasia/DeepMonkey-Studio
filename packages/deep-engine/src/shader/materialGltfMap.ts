/** T08 材质覆盖切片 1 · glTF KHR_materials_* → 扩展材质参数的导入映射与显式回退。
 * 只消费已解码的 glTF material JSON 对象,不修改 packages/deep-engine/src/gltf/**;
 * 与 gltf 层的联调对接清单见 docs/reports/deep-core/T08-implementation.md。
 * loss 记录复用既有 CapabilityFailure 合同(DE26/C01),未知扩展不得静默丢弃。 */

import type { CapabilityFailure } from "../gltf/capabilityInventory.js";
import type { AdvancedMaterialParameters, Rgb } from "./materialAdvancedParameters.js";
import { normalizeExtendedMaterialParameters, serializeMaterialParameters,
  type ExtendedMaterialParameters, type MaterialParameterOverrides, type SerializedMaterialParameters } from "./materialParameters.js";

/** 本切片直接映射的扩展。 */
export const MAPPED_MATERIAL_EXTENSIONS = Object.freeze([
  "KHR_materials_clearcoat", "KHR_materials_anisotropy", "KHR_materials_transmission", "KHR_materials_ior",
] as const);

/** 引擎已知但本切片不求值、走显式回退的扩展(语义记录进 losses,绝不静默丢弃)。 */
export const FALLBACK_MATERIAL_EXTENSIONS = Object.freeze([
  "KHR_materials_volume", "KHR_materials_dispersion", "KHR_materials_sheen",
  "KHR_materials_iridescence", "KHR_materials_specular", "KHR_materials_emissive_strength", "KHR_materials_unlit",
] as const);

export interface MaterialExtensionMapping {
  /** 归一化后的全量参数(默认值 + 映射结果)。 */
  readonly params: ExtendedMaterialParameters;
  /** 打包形态,与 packMaterialParameterArray 一致,供联测对齐 GPU 实例布局。 */
  readonly packed: SerializedMaterialParameters;
  /** 已映射扩展名(按声明顺序)。 */
  readonly mapped: readonly string[];
  /** 显式回退扩展名(按声明顺序)。 */
  readonly fallback: readonly string[];
  /** 逐字段 loss 账本;结构兼容 CapabilityFailure(stage∈{material,extension})。 */
  readonly losses: readonly CapabilityFailure[];
}

export interface MapMaterialOptions {
  /** 非法数值策略:false(默认)= loss + 字段回退默认;true = 直接抛错(联调 gltf fail-closed 层用)。 */
  readonly failClosed?: boolean;
}

const UNIT = /^[a-z0-9-]{3,64}$/;

function loss(code: string, stage: "material" | "extension", assetPath: string, detail: string): CapabilityFailure {
  if (!UNIT.test(code)) throw new Error(`material mapping loss code is invalid: ${code}`);
  return Object.freeze({ code, stage, assetPath, detail, count: 1 });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(
  source: Record<string, unknown>, key: string, assetPath: string,
  losses: CapabilityFailure[], options: MapMaterialOptions,
  range: { readonly min: number; readonly max?: number },
): number | undefined {
  const raw = source[key];
  if (raw === undefined) return undefined;
  const value = typeof raw === "number" ? raw : Number.NaN;
  const finite = Number.isFinite(value) && Number.isFinite(Math.fround(value));
  const inRange = finite && value >= range.min && (range.max === undefined || value <= range.max);
  if (!inRange) {
    const detail = `${key} 期望有限数值 [${range.min}..${range.max ?? "∞"}],实际 ${String(raw)};回退默认值。`;
    if (options.failClosed) throw new RangeError(`${assetPath}: ${detail}`);
    losses.push(loss("material-value-invalid", "material", assetPath, detail));
    return undefined;
  }
  return Math.fround(value);
}

function readTextureLoss(
  source: Record<string, unknown>, key: string, assetPath: string, losses: CapabilityFailure[],
): void {
  if (source[key] !== undefined) {
    losses.push(loss("material-texture-unsupported", "material", `${assetPath}.${key}`,
      `${key} 纹理本切片不求值;已回退标量/默认参数,语义保留待联测切片接入。`));
  }
}

type MaterialExtensionDraft = {
  ior?: number | undefined; clearcoatFactor?: number | undefined; clearcoatRoughness?: number | undefined;
  anisotropyStrength?: number | undefined; anisotropyRotation?: number | undefined; transmissionFactor?: number | undefined;
};

function mapExtension(
  name: string, extension: Record<string, unknown>, assetPath: string,
  draft: MaterialExtensionDraft,
  losses: CapabilityFailure[], options: MapMaterialOptions,
): void {
  const path = `${assetPath}.extensions.${name}`;
  if (name === "KHR_materials_clearcoat") {
    draft.clearcoatFactor = readNumber(extension, "clearcoatFactor", path, losses, options, { min: 0, max: 1 })
      ?? draft.clearcoatFactor;
    draft.clearcoatRoughness = readNumber(extension, "clearcoatRoughnessFactor", path, losses, options, { min: 0, max: 1 })
      ?? draft.clearcoatRoughness;
    readTextureLoss(extension, "clearcoatTexture", path, losses);
    readTextureLoss(extension, "clearcoatNormalTexture", path, losses);
    readTextureLoss(extension, "clearcoatRoughnessTexture", path, losses);
    return;
  }
  if (name === "KHR_materials_anisotropy") {
    draft.anisotropyStrength = readNumber(extension, "anisotropyStrength", path, losses, options, { min: 0, max: 1 })
      ?? draft.anisotropyStrength;
    draft.anisotropyRotation = readNumber(extension, "anisotropyRotation", path, losses, options, { min: -Math.PI, max: Math.PI })
      ?? draft.anisotropyRotation;
    readTextureLoss(extension, "anisotropyTexture", path, losses);
    return;
  }
  if (name === "KHR_materials_transmission") {
    draft.transmissionFactor = readNumber(extension, "transmissionFactor", path, losses, options, { min: 0, max: 1 })
      ?? draft.transmissionFactor;
    readTextureLoss(extension, "transmissionTexture", path, losses);
    return;
  }
  if (name === "KHR_materials_ior") {
    draft.ior = readNumber(extension, "ior", path, losses, options, { min: 1 }) ?? draft.ior;
    return;
  }
  throw new Error(`unreachable material extension mapping: ${name}`);
}

/** glTF material JSON → 参数 + loss 账本。material 非 JSON 对象时整体记 loss 并返回默认参数。 */
export function mapGltfMaterialExtensions(
  material: unknown, assetPath: string, options: MapMaterialOptions = {},
): MaterialExtensionMapping {
  const losses: CapabilityFailure[] = [];
  if (!isObject(material)) {
    const detail = "material 不是 JSON 对象;全部扩展参数回退默认。";
    if (options.failClosed) throw new TypeError(`${assetPath}: ${detail}`);
    losses.push(loss("material-invalid", "material", assetPath, detail));
    const params = normalizeExtendedMaterialParameters({});
    return freezeMapping(params, [], [], losses);
  }
  const draft: MaterialExtensionDraft = {};
  const mapped: string[] = [], fallback: string[] = [];
  const extensions = material.extensions;
  if (extensions !== undefined && !isObject(extensions)) {
    const detail = "extensions 不是 JSON 对象;全部扩展按未知扩展记录。";
    if (options.failClosed) throw new TypeError(`${assetPath}: ${detail}`);
    losses.push(loss("material-invalid", "material", `${assetPath}.extensions`, detail));
  } else if (isObject(extensions)) {
    for (const name of Object.keys(extensions)) {
      const extension = extensions[name];
      if (extension !== undefined && !isObject(extension)) {
        losses.push(loss("material-value-invalid", "extension", `${assetPath}.extensions.${name}`,
          "扩展对象不是 JSON 对象;按默认参数回退。"));
        continue;
      }
      if ((MAPPED_MATERIAL_EXTENSIONS as readonly string[]).includes(name)) {
        mapped.push(name);
        mapExtension(name, extension as Record<string, unknown>, assetPath, draft, losses, options);
      } else if ((FALLBACK_MATERIAL_EXTENSIONS as readonly string[]).includes(name)) {
        fallback.push(name);
        losses.push(loss("extension-fallback", "extension", `${assetPath}.extensions.${name}`,
          `${name} 本切片不求值;显式回退(默认参数/既有路径),语义不静默丢弃。`));
      } else {
        fallback.push(name);
        losses.push(loss("extension-unknown", "extension", `${assetPath}.extensions.${name}`,
          `${name} 不在引擎已知清单;显式回退并记录,待扩展清单评审。`));
      }
    }
  }
  const overrides: MaterialParameterOverrides = {
    ior: draft.ior,
    clearcoat: { factor: draft.clearcoatFactor, roughness: draft.clearcoatRoughness },
    anisotropy: { strength: draft.anisotropyStrength, rotation: draft.anisotropyRotation },
    transmission: { factor: draft.transmissionFactor },
  };
  const params = normalizeExtendedMaterialParameters(overrides);
  return freezeMapping(params, mapped, fallback, losses);
}

function freezeMapping(
  params: ExtendedMaterialParameters, mapped: readonly string[], fallback: readonly string[],
  losses: readonly CapabilityFailure[],
): MaterialExtensionMapping {
  return Object.freeze({
    params, packed: serializeMaterialParameters(params),
    mapped: Object.freeze([...mapped]), fallback: Object.freeze([...fallback]),
    losses: Object.freeze([...losses]),
  });
}

/** advancedMaterials 渲染器能力下额外映射的扩展(sheen / iridescence / volume);其余语义同 MAPPED。 */
export const ADVANCED_MATERIAL_EXTENSIONS = Object.freeze([
  "KHR_materials_sheen", "KHR_materials_iridescence", "KHR_materials_volume",
] as const);

export interface AdvancedExtensionMapping {
  /** 归一化前的 advanced 参数;全部缺省时为 undefined。 */
  readonly params: AdvancedMaterialParameters | undefined;
  /** 已映射的扩展名;调用方据此抑制对应的"回退"loss。 */
  readonly mapped: readonly string[];
  readonly losses: readonly CapabilityFailure[];
}

/** glTF KHR_materials_sheen / iridescence / volume → advanced 参数(three GLTFLoader 同语义:iridescence 厚度取上界)。 */
export function mapGltfAdvancedMaterialExtensions(
  material: unknown, assetPath: string, options: MapMaterialOptions = {},
): AdvancedExtensionMapping {
  const losses: CapabilityFailure[] = [];
  const extensions = isObject(material) && isObject(material.extensions) ? material.extensions : undefined;
  if (!extensions) return Object.freeze({ params: undefined, mapped: [], losses });
  const mapped: string[] = [];
  let sheen: AdvancedMaterialParameters["sheen"], iridescence: AdvancedMaterialParameters["iridescence"],
    volume: AdvancedMaterialParameters["volume"];
  const color = (source: Record<string, unknown>, key: string, path: string, fallback: Rgb, min: number): Rgb => {
    const raw = source[key];
    if (raw === undefined) return fallback;
    const valid = Array.isArray(raw) && raw.length === 3 && raw.every(v => typeof v === "number" && Number.isFinite(v) && v >= min && v <= 1);
    if (!valid) {
      const detail = `${key} 期望 3 个 [${min}..1] 有限数值;回退默认值。`;
      if (options.failClosed) throw new RangeError(`${path}: ${detail}`);
      losses.push(loss("material-value-invalid", "material", path, detail));
      return fallback;
    }
    return [Math.fround(raw[0] as number), Math.fround(raw[1] as number), Math.fround(raw[2] as number)];
  };
  const sheenSource = extensions.KHR_materials_sheen;
  if (isObject(sheenSource)) {
    const path = `${assetPath}.extensions.KHR_materials_sheen`;
    mapped.push("KHR_materials_sheen");
    sheen = { color: color(sheenSource, "sheenColorFactor", path, [0, 0, 0], 0),
      roughness: readNumber(sheenSource, "sheenRoughnessFactor", path, losses, options, { min: 0, max: 1 }) ?? 0 };
    readTextureLoss(sheenSource, "sheenColorTexture", path, losses);
    readTextureLoss(sheenSource, "sheenRoughnessTexture", path, losses);
  }
  const iridescenceSource = extensions.KHR_materials_iridescence;
  if (isObject(iridescenceSource)) {
    const path = `${assetPath}.extensions.KHR_materials_iridescence`;
    mapped.push("KHR_materials_iridescence");
    iridescence = {
      factor: readNumber(iridescenceSource, "iridescenceFactor", path, losses, options, { min: 0, max: 1 }) ?? 0,
      ior: readNumber(iridescenceSource, "iridescenceIor", path, losses, options, { min: 1, max: 3 }) ?? 1.3,
      thickness: readNumber(iridescenceSource, "iridescenceThicknessMaximum", path, losses, options, { min: 0, max: 10000 }) ?? 400 };
    readTextureLoss(iridescenceSource, "iridescenceTexture", path, losses);
    readTextureLoss(iridescenceSource, "iridescenceThicknessTexture", path, losses);
  }
  const volumeSource = extensions.KHR_materials_volume;
  if (isObject(volumeSource)) {
    const path = `${assetPath}.extensions.KHR_materials_volume`;
    mapped.push("KHR_materials_volume");
    volume = {
      thickness: readNumber(volumeSource, "thicknessFactor", path, losses, options, { min: 0 }) ?? 0,
      attenuationColor: color(volumeSource, "attenuationColor", path, [1, 1, 1], 1e-6),
      ...(() => { const distance = readNumber(volumeSource, "attenuationDistance", path, losses, options, { min: Number.MIN_VALUE });
        return distance === undefined ? {} : { attenuationDistance: distance }; })() };
    readTextureLoss(volumeSource, "thicknessTexture", path, losses);
  }
  const params: AdvancedMaterialParameters | undefined = mapped.length
    ? { ...(sheen ? { sheen } : {}), ...(iridescence ? { iridescence } : {}), ...(volume ? { volume } : {}) } : undefined;
  return Object.freeze({ params, mapped: Object.freeze(mapped), losses });
}