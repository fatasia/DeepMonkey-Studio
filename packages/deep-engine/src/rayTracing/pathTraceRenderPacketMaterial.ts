import type { PbrMaterial } from "../renderPacketTypes.js";
import { MAX_EMISSIVE_STRENGTH } from "../renderPacketMaterials.js";
import { validatePathTraceRgb, type PathTraceCpuMaterial, type PathTraceRgb } from "./pathTraceCpuTypes.js";

export const PATH_TRACE_RENDER_PACKET_PROFILE = "production-opaque-two-sided-pbr-single-and-multiple" as const;

/** Standard untextured opaque stock PBR, including C8 direct multiple scattering. */
export function adaptPathTraceRenderPacketMaterial(material: PbrMaterial): PathTraceCpuMaterial {
  const unsupported = (reason: string): never => { throw new Error(`CPU path trace material ${material.id}: unsupported ${reason}.`); };
  if (material.shadingModel !== undefined) unsupported("shadingModel");
  if (material.alphaMode !== undefined && material.alphaMode !== "OPAQUE") unsupported("alphaMode");
  if (material.doubleSided !== true) unsupported("single-sided surface");
  if (material.extendedParameters !== undefined || material.layered !== undefined) unsupported("extended/layered BSDF");
  for (const key of ["baseColorTexture", "metallicRoughnessTexture", "normalTexture", "occlusionTexture", "emissiveTexture"] as const) {
    if (material[key] !== undefined) unsupported(key);
  }
  validatePathTraceRgb(material.baseColor, "baseColor", 1);
  validatePathTraceRgb(material.emissiveFactor ?? [0, 0, 0], "emission");
  if (!Number.isFinite(material.metallic) || !Number.isFinite(material.roughness)
    || material.metallic < 0 || material.metallic > 1 || material.roughness < 0 || material.roughness > 1) throw new RangeError("Invalid CPU path trace PBR parameters.");
  const ior = material.ior ?? 1.5;
  if (!Number.isFinite(ior) || ior < 1) throw new RangeError("Invalid CPU path trace IOR.");
  const strength = material.emissiveStrength ?? 1;
  if (!Number.isFinite(strength) || strength < 0 || strength > MAX_EMISSIVE_STRENGTH) {
    throw new RangeError("Invalid CPU path trace emissive strength.");
  }
  const emission = (material.emissiveFactor ?? [0, 0, 0]).map(value => value * strength) as unknown as PathTraceRgb;
  validatePathTraceRgb(emission, "emission");
  return Object.freeze({ model: "production-opaque-pbr", metallic: material.metallic, ior,
    reflectance: Object.freeze([...material.baseColor]) as PathTraceRgb,
    roughness: material.roughness, emission: Object.freeze(emission) });
}
