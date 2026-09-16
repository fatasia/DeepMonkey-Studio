import type {
  GeometryFeatures,
  PbrMaterial,
  PreparedMaterialTextures,
  PreparedTextureSlot,
} from "./renderPacketTypes.js";

export type GeometryFeatureSource = ReadonlySet<string>
  | ReadonlyMap<string, boolean | GeometryFeatures>;

export function getGeometryFeatures(
  geometries: GeometryFeatureSource,
  id: string,
): GeometryFeatures {
  const candidate = geometries as ReadonlyMap<string, boolean | GeometryFeatures>;
  const value = typeof candidate.get === "function" ? candidate.get(id) : undefined;
  return typeof value === "object" && value !== null
    ? value
    : { uv0: value === true, uv1: false, tangents: false, colors: false };
}

export function validateGeometryFeatures(
  geometry: string,
  material: PbrMaterial,
  textures: PreparedMaterialTextures | undefined,
  features: GeometryFeatures,
): void {
  const slots = textures ? [
    textures.baseColor,
    textures.metallicRoughness,
    textures.normal,
    textures.occlusion,
    textures.emissive,
  ].filter((value): value is PreparedTextureSlot => value !== undefined) : [];
  for (const slot of slots) {
    const selected = slot.texCoord === 1 ? features.uv1 : features.uv0;
    if (!selected) {
      throw new Error(`Geometry ${geometry} requires UV${slot.texCoord} for textured material ${material.id}.`);
    }
  }
  if (textures?.normal && !features.tangents) {
    throw new Error(`Geometry ${geometry} requires a tangent basis for normal-mapped material ${material.id}.`);
  }
}
