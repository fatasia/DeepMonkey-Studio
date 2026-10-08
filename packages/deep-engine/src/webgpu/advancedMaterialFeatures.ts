import type { RenderPacket } from "../renderPacket.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";
type MaterialFeatures = Pick<RenderPacket["materials"][number], "advancedParameters" | "extendedParameters">;

/** Clearcoat=1, sheen=2, iridescence=4, transmission/volume=8, anisotropy=16. Specular and IOR remain enabled. */
export const ALL_ADVANCED_MATERIAL_FEATURES = 31;
export function resolveAdvancedMaterialFeatures(value: number | undefined): number {
  if (value === undefined) return ALL_ADVANCED_MATERIAL_FEATURES;
  if (!Number.isInteger(value) || value < 0 || value > ALL_ADVANCED_MATERIAL_FEATURES)
    throw new TypeError("Invalid advanced material feature mask.");
  return value;
}
export function advancedMaterialFeatures(materials: readonly MaterialFeatures[]): number {
  let mask = 0;
  for (const material of materials) {
    if ((material.extendedParameters?.clearcoat.factor ?? 0) > 0) mask |= 1;
    if (material.advancedParameters?.sheen?.color.some(value => value > 0)) mask |= 2;
    if ((material.advancedParameters?.iridescence?.factor ?? 0) > 0
      && (material.advancedParameters?.iridescence?.thickness ?? 400) > 0) mask |= 4;
    if ((material.extendedParameters?.transmission.factor ?? 0) > 0) mask |= 8;
    if ((material.extendedParameters?.anisotropy.strength ?? 0) > 0) mask |= 16;
  }
  return mask;
}
export function assertAdvancedMaterialFeatures(materials: readonly MaterialFeatures[], allowed: number): void {
  if (advancedMaterialFeatures(materials) & ~allowed)
    throw new Error("advanced-materials/not-enabled: scene requires a wider compiled material profile.");
}
export function assertResidentMaterialFeatures(projection: ResidentPacketProjection, allowed: number): void {
  for (const batch of projection.batches) {
    const textures = batch.source.textures;
    if (textures) assertAdvancedMaterialFeatures([{
      ...(textures.extendedParameters ? { extendedParameters: textures.extendedParameters } : {}),
      ...(textures.advanced ? { advancedParameters: textures.advanced } : {}),
    }], allowed);
  }
}

/** Keep the material ABI intact; only unused lobes become compile-time constants. */
export function specializeAdvancedMaterialShader(source: string, mask: number | undefined): string {
  const features = resolveAdvancedMaterialFeatures(mask);
  if ((features & 17) !== 17) source = source.replaceAll("materialTextures.extended0",
    `vec4f(materialTextures.extended0.x, ${features & 1 ? "materialTextures.extended0.y" : "0.0"}, materialTextures.extended0.z, ${features & 16 ? "materialTextures.extended0.w" : "0.0"})`);
  if (!(features & 2)) source = source.replaceAll("materialTextures.advanced0", "vec4f(0.0)");
  if (!(features & 4)) source = source.replaceAll("materialTextures.advanced1",
    "vec4f(0.0, 1.3, 0.0, materialTextures.advanced1.w)");
  if (!(features & 8)) source = source.replaceAll("materialTextures.extended1",
    "vec4f(materialTextures.extended1.x, 0.0, materialTextures.extended1.zw)");
  if (!(features & 6)) source = source.replace(
    "var color = (original - stockBrdf * sunRadiance * visibility - emissive) * energyIndirect\n    + sunBrdf * sunRadiance * visibility * energyDirect + sheenDirect + emissive;",
    "var color = original;");
  return source;
}
