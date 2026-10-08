import type { TextureSemantic } from "./textures/decodedTexture.js";
import type {
  NormalTextureSlot,
  OcclusionTextureSlot,
  PbrMaterial,
  PreparedMaterialTextures,
  PreparedTextureSlot,
  TextureSlot,
} from "./renderPacketTypes.js";
import { finiteFloat32, unitFloat } from "./renderPacketValidation.js";
import { packMaterialIor, STOCK_MATERIAL_INSTANCE_OPTIONS } from "./materialInstanceAbi.js";
import { normalizeExtendedMaterialParameters } from "./shader/materialParameters.js";
import { normalizeLayeredSurfaceParameters } from "./shader/materialLayeredSurface.js";
import { hasAdvancedMaterialFeatures, normalizeAdvancedMaterialParameters } from "./shader/materialAdvancedParameters.js";

/** HDR 上限对应 8 EV 发光增益；避免任意作者数值污染 rgba16float 中间目标。 */
export const MAX_EMISSIVE_STRENGTH = 256;

export function prepareMaterialTextures(
  materials: ReadonlyMap<string, PbrMaterial>,
  textureSemantics: ReadonlyMap<string, TextureSemantic>,
): ReadonlyMap<string, PreparedMaterialTextures | undefined> {
  const result = new Map<string, PreparedMaterialTextures | undefined>();
  for (const material of materials.values()) {
    const emissiveStrength = validateMaterial(material);
    const baseColor = prepareTextureSlot(material.baseColorTexture, "baseColor", textureSemantics);
    const metallicRoughness = prepareTextureSlot(
      material.metallicRoughnessTexture,
      "metallicRoughness",
      textureSemantics,
    );
    const normal = prepareNormalTextureSlot(material.normalTexture, textureSemantics);
    const occlusion = prepareOcclusionTextureSlot(material.occlusionTexture, textureSemantics);
    const emissive = prepareTextureSlot(material.emissiveTexture, "emissive", textureSemantics);
    const specular = prepareTextureSlot(material.specularTexture, "specular", textureSemantics);
    const specularColor = prepareTextureSlot(material.specularColorTexture, "specularColor", textureSemantics);
    const specularFactor = material.specularFactor ?? 1, specularColorFactor = material.specularColorFactor ?? [1, 1, 1] as const;
    const hasSpecular = specular !== undefined || specularColor !== undefined || specularFactor !== 1
      || specularColorFactor.some(value => value !== 1);
    const layerParameters = material.layered === undefined ? undefined
      : normalizeLayeredSurfaceParameters({ ...material.layered, base: material.layered.base ?? material.extendedParameters });
    if (layerParameters && material.shadingModel === "unlit") throw new Error("Unlit materials cannot consume response layers.");
    if (hasSpecular && (layerParameters || material.shadingModel === "unlit")) {
      throw new Error("Specular materials cannot consume response layers or unlit shading.");
    }
    if (layerParameters && layerParameters.base.ior !== Math.fround(material.ior ?? 1.5))
      throw new Error("Layer base IOR must match the material instance IOR field.");
    const layered = layerParameters?.layers.some(layer => layer.coverage > 0) ? {
      parameters: layerParameters,
      textures: layerParameters.surfaces.map((surface, index) => layerParameters.layers[index]!.coverage === 0 ? {} : {
        ...(surface?.baseColorTexture ? { baseColor: prepareTextureSlot(surface.baseColorTexture, "baseColor", textureSemantics)! } : {}),
        ...(surface?.metallicRoughnessTexture ? { metallicRoughness: prepareTextureSlot(surface.metallicRoughnessTexture, "metallicRoughness", textureSemantics)! } : {}),
      }),
    } : undefined;
    const extendedParameters = layered ? layerParameters!.base : (material.extendedParameters === undefined ? undefined
      : normalizeExtendedMaterialParameters(material.extendedParameters));
    const advancedNormalized = material.advancedParameters === undefined ? undefined
      : normalizeAdvancedMaterialParameters(material.advancedParameters);
    const advanced = advancedNormalized && hasAdvancedMaterialFeatures(advancedNormalized) ? advancedNormalized : undefined;
    // 无纹理的扩展/advanced 材质由 advancedMaterials 变体用中性纹理承载;未启用变体时在绑定阶段 fail-closed。
    const untexturedLobes = (extendedParameters !== undefined || advanced !== undefined || hasSpecular) && !layered
      && !baseColor && !metallicRoughness && !normal && !occlusion && !emissive;
    result.set(material.id, baseColor || metallicRoughness || normal || occlusion || emissive || specular || specularColor || layered || untexturedLobes ? {
      ...(hasSpecular ? { specularFactor: Math.fround(specularFactor), specularColorFactor: specularColorFactor.map(Math.fround) as [number, number, number] } : {}),
      ...(specular ? { specular } : {}), ...(specularColor ? { specularColor } : {}),
      ...(layered ? { layered } : {}),
      ...(advanced ? { advanced } : {}),
      emissiveStrength: Math.fround(emissiveStrength),
      ...(extendedParameters ? { extendedParameters } : {}),
      ...(baseColor ? { baseColor } : {}),
      ...(metallicRoughness ? { metallicRoughness } : {}),
      ...(normal ? { normal } : {}),
      ...(occlusion ? { occlusion } : {}),
      ...(emissive ? { emissive } : {}),
    } : undefined);
  }
  return result;
}

function validateMaterial(material: PbrMaterial): number {
  if (material.specularFactor !== undefined && !unitFloat(material.specularFactor)) {
    throw new Error("PBR material specularFactor must be in 0..1.");
  }
  if (material.specularColorFactor !== undefined && (!Array.isArray(material.specularColorFactor)
    || material.specularColorFactor.length !== 3
    || !material.specularColorFactor.every(value => finiteFloat32(value) && value >= 0))) {
    throw new Error("PBR material specularColorFactor must be nonnegative finite float32 RGB.");
  }
  packMaterialIor(material.ior, STOCK_MATERIAL_INSTANCE_OPTIONS);
  if (material.advancedParameters !== undefined && material.shadingModel === "unlit") {
    throw new Error("Unlit materials cannot consume PBR extension lobes.");
  }
  if (material.extendedParameters !== undefined) {
    const extended = normalizeExtendedMaterialParameters(material.extendedParameters);
    if (Math.fround(material.ior ?? 1.5) !== extended.ior) {
      throw new Error("Extended material IOR must match the v5 instance IOR field.");
    }
    if (material.shadingModel === "unlit") throw new Error("Unlit materials cannot consume PBR extension lobes.");
  }
  if (material.shadingModel !== undefined && material.shadingModel !== "unlit") {
    throw new Error("Invalid material shadingModel.");
  }
  if (material.fog !== undefined && typeof material.fog !== "boolean") {
    throw new Error("PBR material fog must be boolean.");
  }
  if (material.baseColor.length !== 3
    || !unitFloat(material.baseColor[0])
    || !unitFloat(material.baseColor[1])
    || !unitFloat(material.baseColor[2])
    || !unitFloat(material.metallic)
    || !unitFloat(material.roughness)) {
    throw new Error("PBR material components must be in 0..1.");
  }
  if (material.doubleSided !== undefined && typeof material.doubleSided !== "boolean") {
    throw new Error("PBR material doubleSided must be boolean.");
  }
  const alphaMode = material.alphaMode ?? "OPAQUE";
  if (alphaMode !== "OPAQUE" && alphaMode !== "MASK" && alphaMode !== "BLEND") {
    throw new Error("Invalid PBR material alphaMode.");
  }
  // DE26/C03：premultiplied 只描述 BLEND 的混合公式；OPAQUE/MASK 声明它是无效组合而非可忽略细节。
  if (material.premultipliedAlpha !== undefined) {
    if (typeof material.premultipliedAlpha !== "boolean") {
      throw new Error("PBR material premultipliedAlpha must be boolean.");
    }
    if (alphaMode !== "BLEND") {
      throw new Error("PBR material premultipliedAlpha is only valid with alphaMode BLEND.");
    }
  }
  if (material.baseColorAlpha !== undefined && !unitFloat(material.baseColorAlpha)) {
    throw new Error("PBR material alpha must be in 0..1.");
  }
  if (material.alphaCutoff !== undefined
    && (!finiteFloat32(material.alphaCutoff) || material.alphaCutoff < 0)) {
    throw new Error("PBR material alphaCutoff must be a nonnegative finite float32 value.");
  }
  const emissiveFactor = material.emissiveFactor ?? [0, 0, 0];
  if (!Array.isArray(emissiveFactor) || emissiveFactor.length !== 3 || !emissiveFactor.every(unitFloat)) {
    throw new Error("PBR material emissiveFactor components must be in 0..1.");
  }
  const emissiveStrength = material.emissiveStrength ?? 1;
  if (!finiteFloat32(emissiveStrength)
    || emissiveStrength < 0
    || emissiveStrength > MAX_EMISSIVE_STRENGTH) {
    throw new Error(
      `PBR material emissiveStrength must be a finite value in 0..${MAX_EMISSIVE_STRENGTH}.`,
    );
  }
  return emissiveStrength;
}

function prepareNormalTextureSlot(
  slot: NormalTextureSlot | undefined,
  textures: ReadonlyMap<string, TextureSemantic>,
): PreparedMaterialTextures["normal"] {
  const prepared = prepareTextureSlot(slot, "normal", textures);
  if (!prepared || !slot) return undefined;
  const normalScale = slot.normalScale ?? 1;
  if (!finiteFloat32(normalScale)) throw new Error("Invalid normal texture scale.");
  const [m00, m01, , m10, m11] = prepared.uvTransform;
  const determinant = m00 * m11 - m01 * m10;
  const conditioning = Math.hypot(m00, m01) * Math.hypot(m10, m11);
  if (!conditioning || Math.abs(determinant) / conditioning < 1e-8) {
    throw new Error("Normal texture transform is singular or ill-conditioned.");
  }
  return { ...prepared, normalScale: Math.fround(normalScale) };
}

function prepareOcclusionTextureSlot(
  slot: OcclusionTextureSlot | undefined,
  textures: ReadonlyMap<string, TextureSemantic>,
): PreparedMaterialTextures["occlusion"] {
  const prepared = prepareTextureSlot(slot, "occlusion", textures);
  if (!prepared || !slot) return undefined;
  const strength = slot.strength ?? 1;
  if (!unitFloat(strength)) throw new Error("Occlusion texture strength must be in 0..1.");
  return { ...prepared, strength: Math.fround(strength) };
}

function prepareTextureSlot(
  slot: TextureSlot | undefined,
  semantic: TextureSemantic,
  textures: ReadonlyMap<string, TextureSemantic>,
): PreparedTextureSlot | undefined {
  if (slot === undefined) return undefined;
  if (!slot || typeof slot !== "object" || Array.isArray(slot)
    || typeof slot.texture !== "string" || !slot.texture.length) {
    throw new Error("Invalid material texture slot.");
  }
  if (slot.texCoord !== undefined && slot.texCoord !== 0 && slot.texCoord !== 1) {
    throw new Error("Only texture coordinate sets 0 and 1 are supported.");
  }
  if (textures.get(slot.texture) !== semantic) {
    throw new Error(`Missing ${semantic} texture or semantic mismatch: ${slot.texture}.`);
  }
  const offset = pair(slot.offset, [0, 0], "offset"), scale = pair(slot.scale, [1, 1], "scale");
  const rotation = slot.rotation ?? 0;
  if (!finiteFloat32(rotation)) throw new Error("Invalid texture rotation.");
  const c = Math.cos(rotation), s = Math.sin(rotation);
  const values = [c * scale[0], -s * scale[1], offset[0], s * scale[0], c * scale[1], offset[1]] as const;
  if (!values.every(finiteFloat32)) throw new Error("Texture transform exceeds float32 range.");
  return {
    texture: slot.texture,
    texCoord: slot.texCoord ?? 0,
    uvTransform: values.map(value => {
      const result = Math.fround(value);
      return Object.is(result, -0) ? 0 : result;
    }) as unknown as PreparedTextureSlot["uvTransform"],
  };
}

function pair(
  value: readonly [number, number] | undefined,
  fallback: readonly [number, number],
  label: string,
): readonly [number, number] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length !== 2 || !value.every(finiteFloat32)) {
    throw new Error(`Invalid texture ${label}.`);
  }
  return value;
}
