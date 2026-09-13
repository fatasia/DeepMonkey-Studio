import { getGeometryFeatures, validateGeometryFeatures, type GeometryFeatureSource } from "./renderPacketGeometryFeatures.js";
import type {
  PbrMaterial,
  PreparedLodProfile,
  PreparedMaterialTextures,
  RenderInstance,
} from "./renderPacketTypes.js";

const DEFAULT_LOD_HYSTERESIS = 0.12;

export function prepareLodProfile(
  instance: RenderInstance,
  geometries: GeometryFeatureSource,
  material: PbrMaterial,
  textures: PreparedMaterialTextures | undefined,
): PreparedLodProfile | undefined {
  const source = instance.lod;
  if (source === undefined) return undefined;
  if (!source || typeof source !== "object" || !Array.isArray(source.levels)
    || source.levels.length < 2 || source.levels.length > 8) {
    throw new Error(`LOD profile for instance ${instance.id} must have 2-8 levels.`);
  }
  if (source.levels[0]?.geometry !== instance.geometry) {
    throw new Error(`LOD profile for instance ${instance.id} must start with its primary geometry.`);
  }
  const hysteresisRatio = source.hysteresisRatio ?? DEFAULT_LOD_HYSTERESIS;
  if (!Number.isFinite(hysteresisRatio) || hysteresisRatio < 0 || hysteresisRatio > 0.49) {
    throw new Error(`LOD hysteresis ratio for instance ${instance.id} must be between 0 and 0.49.`);
  }
  const levels = source.levels.map((level, index) => {
    if (!level || typeof level.geometry !== "string" || !level.geometry.length || !geometries.has(level.geometry)) {
      throw new Error(`Missing LOD geometry at level ${index} for instance ${instance.id}.`);
    }
    const features = getGeometryFeatures(geometries, level.geometry);
    if (!Number.isSafeInteger(features.triangles) || features.triangles! < 1) {
      throw new Error(`LOD geometry ${level.geometry} requires triangle count metadata.`);
    }
    if (!Number.isFinite(level.minProjectedDiameterPixels) || level.minProjectedDiameterPixels < 0
      || level.minProjectedDiameterPixels > 1e9) {
      throw new Error(`LOD threshold at level ${index} for instance ${instance.id} is invalid.`);
    }
    if (!Number.isFinite(level.geometricError) || level.geometricError < 0 || level.geometricError > 1e15) {
      throw new Error(`LOD geometric error at level ${index} for instance ${instance.id} is invalid.`);
    }
    if (level.resident !== undefined && typeof level.resident !== "boolean") {
      throw new Error(`LOD residency at level ${index} for instance ${instance.id} is invalid.`);
    }
    validateGeometryFeatures(level.geometry, material, textures, features);
    return Object.freeze({
      geometry: level.geometry,
      minProjectedDiameterPixels: level.minProjectedDiameterPixels,
      geometricError: level.geometricError,
      triangles: features.triangles!,
      resident: level.resident !== false,
    });
  });
  for (let index = 1; index < levels.length; index++) {
    const finer = levels[index - 1]!, coarser = levels[index]!;
    if (Math.fround(finer.minProjectedDiameterPixels) <= Math.fround(coarser.minProjectedDiameterPixels)) {
      throw new Error(`LOD thresholds for instance ${instance.id} must strictly decrease after float32 conversion.`);
    }
    if (finer.triangles <= coarser.triangles) {
      throw new Error(`LOD triangle counts for instance ${instance.id} must strictly decrease.`);
    }
    if (finer.geometricError > coarser.geometricError) {
      throw new Error(`LOD geometric errors for instance ${instance.id} must not decrease.`);
    }
  }
  if (levels.at(-1)!.minProjectedDiameterPixels !== 0) {
    throw new Error(`The coarsest LOD threshold for instance ${instance.id} must be zero.`);
  }
  if (!levels.some(level => level.resident)) {
    throw new Error(`LOD profile for instance ${instance.id} requires a resident level.`);
  }
  if (!levels[0]!.resident) {
    throw new Error(`The primary LOD geometry for instance ${instance.id} must be resident.`);
  }
  if (!levels.at(-1)!.resident) {
    throw new Error(`The coarsest LOD geometry for instance ${instance.id} must be resident for fallback.`);
  }
  return Object.freeze({ levels: Object.freeze(levels), hysteresisRatio });
}
