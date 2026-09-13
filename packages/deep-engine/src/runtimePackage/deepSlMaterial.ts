import type { PbrMaterial, TextureSlot } from "../renderPacketTypes.js";
import type { DeepPbrMeshV1TextureSemantic, DeepSlPackageAdapterResult } from "../shaderAuthoring/packageAdapterTypes.js";
import { record, requireValue, snapshotJson } from "./primitives.js";
import type { RuntimeMaterialShaderBinding } from "./types.js";

export interface RuntimeShaderMaterial {
  readonly material: PbrMaterial;
  readonly binding: RuntimeMaterialShaderBinding;
}

/** Transfers authored defaults into the RenderPacket; WGSL alone does not contain instance/material values. */
export function createRuntimeDeepSlMaterial(id: string, compiled: DeepSlPackageAdapterResult,
  textureReferences: Readonly<Partial<Record<DeepPbrMeshV1TextureSemantic, string>>> = {}): RuntimeShaderMaterial {
  requireValue(compiled.success, "$.shader", "Cannot bind a rejected DeepSL compilation.");
  requireValue(String(compiled.package.shaderAbi.id) === "deep.pbr.mesh.v2", "$.shader", "Runtime materials require CSM shader ABI v2.");
  const defaults = compiled.report.materialDefaults, textures = compiled.report.materialTextureDefaults;
  requireValue(defaults, "$.shader", "DeepSL compilation omitted material defaults.");
  requireValue(typeof id === "string" && id.length > 0 && new TextEncoder().encode(id).length <= 256,
    "$.material.id", "Invalid material identity.");
  const references = record(snapshotJson(textureReferences), "$.textureReferences");
  const enabled = textures?.enabledSlots ?? [];
  requireValue(Object.keys(references).every(key => enabled.includes(key as DeepPbrMeshV1TextureSemantic)),
    "$.textureReferences", "Texture reference is not enabled by the authored shader.");
  const slots: Partial<Record<DeepPbrMeshV1TextureSemantic, TextureSlot>> = {};
  for (const semantic of enabled) {
    const texture = references[semantic], settings = textures![semantic];
    requireValue(typeof texture === "string" && texture.length > 0, `$.textureReferences.${semantic}`,
      "Enabled shader texture has no resolved resource reference.");
    slots[semantic] = Object.freeze({ texture, texCoord: settings.texCoord,
      offset: Object.freeze([...settings.offset]) as readonly [number, number],
      scale: Object.freeze([...settings.scale]) as readonly [number, number], rotation: settings.rotation });
  }
  const color = defaults.baseColorMetallic, parameters = defaults.roughnessAlphaCutoffHandednessFlags;
  const emission = defaults.emissiveAlpha, flags = parameters[3];
  const material: PbrMaterial = Object.freeze({ id,
    baseColor: Object.freeze([color[0], color[1], color[2]]) as readonly [number, number, number],
    metallic: color[3], roughness: parameters[0], alphaCutoff: parameters[1],
    alphaMode: flags & 4 ? "BLEND" : flags & 2 ? "MASK" : "OPAQUE", doubleSided: Boolean(flags & 1),
    baseColorAlpha: emission[3],
    emissiveFactor: Object.freeze([emission[0], emission[1], emission[2]]) as readonly [number, number, number],
    // Plain defaults already include gain; textured defaults keep it in material uniform semantics.
    emissiveStrength: textures ? textures.emissive.emissiveStrength : 1,
    ...(slots.baseColor ? { baseColorTexture: slots.baseColor } : {}),
    ...(slots.metallicRoughness ? { metallicRoughnessTexture: slots.metallicRoughness } : {}),
    ...(slots.normal ? { normalTexture: Object.freeze({ ...slots.normal, normalScale: textures!.normal.normalScale }) } : {}),
    ...(slots.occlusion ? { occlusionTexture: Object.freeze({ ...slots.occlusion, strength: textures!.occlusion.strength }) } : {}),
    ...(slots.emissive ? { emissiveTexture: slots.emissive } : {}),
  });
  return Object.freeze({ material, binding: Object.freeze({ materialId: id, packageId: compiled.package.packageId, techniqueId: "webgpu" }) });
}
