import { getGeometryFeatures, validateGeometryFeatures, type GeometryFeatureSource } from "./renderPacketGeometryFeatures.js";
import { assertDenseLodArray } from "./renderPacketLodArrays.js";
import type { PreparedAuthorSelectedLodProfile, RenderAuthorSelectedLodProfile, PbrMaterial, PreparedMaterialTextures } from "./renderPacketTypes.js";

/** Selected author levels are authoritative for both main and shadow drawing. */
export function prepareAuthorSelectedLod(source: RenderAuthorSelectedLodProfile, geometry: string,
  geometries: GeometryFeatureSource, material: PbrMaterial, textures: PreparedMaterialTextures | undefined): PreparedAuthorSelectedLodProfile {
  if (Object.keys(source).some(key => !["strategy", "revision", "levels", "selectedLevels"].includes(key))
    || !Number.isSafeInteger(source.revision) || source.revision < 0 || !Array.isArray(source.levels)
    || source.levels.length < 1 || source.levels.length > 8 || source.levels[0]?.geometry !== geometry)
    throw new Error("Invalid author-selected LOD profile.");
  let previousDistance = -1;
  assertDenseLodArray(source.levels);
  const levels = source.levels.map(level => {
    if (!level || Object.keys(level).some(key => !["geometry", "distance", "hysteresis"].includes(key))
      || typeof level.geometry !== "string" || !geometries.has(level.geometry)
      || !Number.isFinite(level.distance) || level.distance < 0 || level.distance < previousDistance
      || !Number.isFinite(level.hysteresis) || level.hysteresis < 0 || level.hysteresis > 1)
      throw new Error("Invalid author-selected LOD level.");
    previousDistance = level.distance;
    const features = getGeometryFeatures(geometries, level.geometry);
    if (!Number.isSafeInteger(features.triangles) || features.triangles! < 1) throw new Error("Author LOD requires triangle metadata.");
    validateGeometryFeatures(level.geometry, material, textures, features);
    return Object.freeze({ geometry: level.geometry, distance: level.distance, hysteresis: level.hysteresis,
      triangles: features.triangles!, resident: true as const });
  });
  if (!Array.isArray(source.selectedLevels) || source.selectedLevels.length > levels.length) throw new Error("Invalid author LOD selection array.");
  assertDenseLodArray(source.selectedLevels);
  if (source.selectedLevels.some((level, index) =>
    !Number.isSafeInteger(level) || level < 0 || level >= levels.length || index > 0 && level <= source.selectedLevels[index - 1]!))
    throw new Error("Author LOD selected levels must be unique, ordered, valid indices.");
  return Object.freeze({ strategy: "author-selected", revision: source.revision,
    levels: Object.freeze(levels), selectedLevels: Object.freeze([...source.selectedLevels]) });
}
