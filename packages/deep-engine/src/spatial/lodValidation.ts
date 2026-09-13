import { validateSpatialAabb } from "./bounds.js";
import { validateSpatialId } from "./octreeInternals.js";
import { SpatialIndexError, type SpatialAabb, type SpatialItemId, type SpatialVec3 } from "./types.js";
import type {
  LodCamera,
  LodFrameBudget,
  LodViewport,
  ScreenSpaceLodLevel,
  ScreenSpaceLodObject,
  ScreenSpaceLodSelectorConfiguration,
  ScreenSpaceLodSelectorOptions,
} from "./lodTypes.js";

export const DEEP_SCREEN_SPACE_LOD_LIMITS = Object.freeze({
  maxLevels: 32,
  maxTrackedObjects: 1_000_000,
  maxTrianglesPerLevel: 2_000_000_000,
  maxProjectedPixels: 1_000_000_000,
  maxViewportDimension: 65_536,
  maxHysteresisRatio: 0.49,
  minPerspectiveFovRadians: 1e-4,
  minCameraDistance: 1e-9,
  maxWorldMagnitude: 1e15,
  maxPriorityMagnitude: 1e9,
} as const);

export interface ValidatedLodObject<TId extends SpatialItemId> {
  readonly id: TId;
  readonly bounds: SpatialAabb;
  readonly levels: readonly ScreenSpaceLodLevel[];
  readonly priority: number;
  readonly hysteresisRatio: number;
}

export interface ValidatedLodCamera {
  readonly projection: "perspective" | "orthographic";
  readonly position: SpatialVec3;
  readonly forward: SpatialVec3;
  readonly near: number;
  readonly far: number;
  readonly projectionScale: number;
}

export interface ValidatedLodBudget {
  readonly maxObjects: number;
  readonly maxTriangles: number;
}

export function validateSelectorOptions(options: ScreenSpaceLodSelectorOptions): Readonly<ScreenSpaceLodSelectorConfiguration> {
  if (!options || typeof options !== "object") {
    throw new SpatialIndexError("invalid-options", "LOD selector options must be an object.");
  }
  const maxTrackedObjects = boundedInteger(
    options.maxTrackedObjects ?? 250_000,
    1,
    DEEP_SCREEN_SPACE_LOD_LIMITS.maxTrackedObjects,
    "maxTrackedObjects",
  );
  const defaultHysteresisRatio = validateHysteresis(options.defaultHysteresisRatio ?? 0.1);
  return Object.freeze({ maxTrackedObjects, defaultHysteresisRatio });
}

export function validateCamera(camera: LodCamera, viewport: LodViewport): ValidatedLodCamera {
  if (!camera || (camera.projection !== "perspective" && camera.projection !== "orthographic")) {
    throw new SpatialIndexError("invalid-options", "LOD camera projection must be perspective or orthographic.");
  }
  const height = boundedInteger(viewport?.height, 1, DEEP_SCREEN_SPACE_LOD_LIMITS.maxViewportDimension, "viewport.height");
  boundedInteger(viewport?.width, 1, DEEP_SCREEN_SPACE_LOD_LIMITS.maxViewportDimension, "viewport.width");
  const position = finiteVector(camera.position, "camera.position");
  const direction = finiteVector(camera.forward, "camera.forward");
  const directionLength = Math.hypot(...direction);
  if (directionLength <= Number.EPSILON) throw new SpatialIndexError("invalid-options", "camera.forward must be non-zero.");
  const forward = direction.map((value) => value / directionLength) as unknown as SpatialVec3;
  const near = finiteRange(camera.near, DEEP_SCREEN_SPACE_LOD_LIMITS.minCameraDistance,
    DEEP_SCREEN_SPACE_LOD_LIMITS.maxWorldMagnitude, "camera.near");
  const far = finiteRange(camera.far, DEEP_SCREEN_SPACE_LOD_LIMITS.minCameraDistance,
    DEEP_SCREEN_SPACE_LOD_LIMITS.maxWorldMagnitude, "camera.far");
  if (far <= near) throw new SpatialIndexError("invalid-options", "camera.far must exceed camera.near.");

  let projectionScale: number;
  if (camera.projection === "perspective") {
    const fov = camera.verticalFovRadians;
    const minimum = DEEP_SCREEN_SPACE_LOD_LIMITS.minPerspectiveFovRadians;
    if (!Number.isFinite(fov) || fov < minimum || fov > Math.PI - minimum) {
      throw new SpatialIndexError("invalid-options", "Perspective vertical FOV is outside the supported finite range.");
    }
    projectionScale = height / (2 * Math.tan(fov * 0.5));
  } else {
    const verticalSize = finiteRange(camera.verticalSize, DEEP_SCREEN_SPACE_LOD_LIMITS.minCameraDistance,
      DEEP_SCREEN_SPACE_LOD_LIMITS.maxWorldMagnitude, "camera.verticalSize");
    projectionScale = height / verticalSize;
  }
  if (!Number.isFinite(projectionScale)) throw new SpatialIndexError("invalid-options", "LOD projection scale is not finite.");
  return Object.freeze({ projection: camera.projection, position, forward, near, far, projectionScale });
}

export function validateBudget(
  budget: LodFrameBudget,
  maxTrackedObjects: number,
): ValidatedLodBudget {
  if (!budget || typeof budget !== "object") throw new SpatialIndexError("invalid-options", "LOD frame budget must be an object.");
  const maxObjects = boundedInteger(budget.maxObjects ?? maxTrackedObjects, 0, maxTrackedObjects, "budget.maxObjects");
  const maxTriangles = boundedInteger(budget.maxTriangles ?? Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER, "budget.maxTriangles");
  return Object.freeze({ maxObjects, maxTriangles });
}

export function validateLodObjects<TId extends SpatialItemId>(
  objects: readonly ScreenSpaceLodObject<TId>[],
  options: ScreenSpaceLodSelectorConfiguration,
): readonly ValidatedLodObject<TId>[] {
  if (!Array.isArray(objects)) throw new SpatialIndexError("invalid-options", "LOD objects must be an array.");
  if (objects.length > options.maxTrackedObjects) {
    throw new SpatialIndexError("capacity-exceeded", `LOD object count exceeds ${options.maxTrackedObjects}.`);
  }
  const ids = new Set<TId>();
  return Object.freeze(objects.map((object) => {
    validateSpatialId(object?.id);
    if (ids.has(object.id)) throw new SpatialIndexError("duplicate-id", `Duplicate LOD object id: ${String(object.id)}.`);
    ids.add(object.id);
    const bounds = validateSpatialAabb(object.bounds, { label: `LOD object ${String(object.id)}` });
    const levels = validateLevels(object.levels, object.id);
    const priority = finiteRange(object.priority ?? 0, -DEEP_SCREEN_SPACE_LOD_LIMITS.maxPriorityMagnitude,
      DEEP_SCREEN_SPACE_LOD_LIMITS.maxPriorityMagnitude, `LOD priority for ${String(object.id)}`);
    const hysteresisRatio = validateHysteresis(object.hysteresisRatio ?? options.defaultHysteresisRatio);
    return Object.freeze({ id: object.id, bounds, levels, priority, hysteresisRatio });
  }));
}

function validateLevels<TId extends SpatialItemId>(levels: readonly ScreenSpaceLodLevel[], id: TId): readonly ScreenSpaceLodLevel[] {
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > DEEP_SCREEN_SPACE_LOD_LIMITS.maxLevels) {
    throw new SpatialIndexError("invalid-options", `LOD object ${String(id)} must have 1-${DEEP_SCREEN_SPACE_LOD_LIMITS.maxLevels} levels.`);
  }
  const copy = levels.map((level, index) => {
    const threshold = finiteRange(level?.minProjectedDiameterPixels, 0, DEEP_SCREEN_SPACE_LOD_LIMITS.maxProjectedPixels, `LOD ${index} threshold`);
    const geometricError = finiteRange(level?.geometricError, 0, 1e15, `LOD ${index} geometric error`);
    const triangles = boundedInteger(level?.triangles, 0, DEEP_SCREEN_SPACE_LOD_LIMITS.maxTrianglesPerLevel, `LOD ${index} triangles`);
    return Object.freeze({ minProjectedDiameterPixels: threshold, geometricError, triangles });
  });
  for (let index = 1; index < copy.length; index += 1) {
    if (copy[index - 1]!.minProjectedDiameterPixels <= copy[index]!.minProjectedDiameterPixels) {
      throw new SpatialIndexError("invalid-options", `LOD thresholds for ${String(id)} must strictly decrease.`);
    }
    if (copy[index - 1]!.triangles <= copy[index]!.triangles) {
      throw new SpatialIndexError("invalid-options", `LOD triangle counts for ${String(id)} must strictly decrease.`);
    }
    if (copy[index - 1]!.geometricError > copy[index]!.geometricError) {
      throw new SpatialIndexError("invalid-options", `LOD geometric errors for ${String(id)} must not decrease.`);
    }
  }
  if (copy.at(-1)!.minProjectedDiameterPixels !== 0) {
    throw new SpatialIndexError("invalid-options", `The coarsest LOD threshold for ${String(id)} must be zero.`);
  }
  return Object.freeze(copy);
}

function finiteVector(value: SpatialVec3, label: string): SpatialVec3 {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => typeof component !== "number"
    || !Number.isFinite(component) || Math.abs(component) > DEEP_SCREEN_SPACE_LOD_LIMITS.maxWorldMagnitude)) {
    throw new SpatialIndexError("invalid-options", `${label} must contain three finite numbers.`);
  }
  return Object.freeze([...value]) as SpatialVec3;
}

function validateHysteresis(value: number): number {
  return finiteRange(value, 0, DEEP_SCREEN_SPACE_LOD_LIMITS.maxHysteresisRatio, "LOD hysteresis ratio");
}

function finiteRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new SpatialIndexError("invalid-options", `${label} must be finite and between ${minimum} and ${maximum}.`);
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SpatialIndexError("invalid-options", `${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
