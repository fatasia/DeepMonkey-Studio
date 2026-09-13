import { sameAabb } from "./bounds.js";
import { validateLodObjects } from "./lodValidation.js";
import { DEFAULT_SPATIAL_MASK, validateSpatialId, validateSpatialMask } from "./octreeInternals.js";
import { SpatialIndexError, type SpatialItemId } from "./types.js";
import type { ScreenSpaceLodSelectorConfiguration } from "./lodTypes.js";
import type {
  VisibleObjectLodLevel,
  VisibleObjectPatch,
  VisibleObjectRegistration,
} from "./workingSetTypes.js";

const MAX_HANDLE_CODE_UNITS = 512;

export interface ValidatedVisibleObject<TId extends SpatialItemId> {
  readonly id: TId;
  readonly instanceId: SpatialItemId;
  readonly bounds: VisibleObjectRegistration<TId>["bounds"];
  readonly materialId: string;
  readonly levels: readonly VisibleObjectLodLevel[];
  readonly mask: number;
  readonly priority: number;
  readonly hysteresisRatio: number;
}

export function validateVisibleObject<TId extends SpatialItemId>(
  input: VisibleObjectRegistration<TId>,
  selectorOptions: ScreenSpaceLodSelectorConfiguration,
): ValidatedVisibleObject<TId> {
  if (!input || typeof input !== "object") {
    throw new SpatialIndexError("missing-metadata", "Visible object metadata is required.");
  }
  validateSpatialId(input.id);
  validateSpatialId(input.instanceId);
  const materialId = validateHandle(input.materialId, "materialId");
  if (!Array.isArray(input.levels)) {
    throw new SpatialIndexError("missing-metadata", `Visible object ${String(input.id)} is missing LOD levels.`);
  }
  const geometryIds = input.levels.map((level, index) => validateHandle(level?.geometryId, `levels[${index}].geometryId`));
  const validated = validateLodObjects([{
    id: input.id,
    bounds: input.bounds,
    levels: input.levels,
    priority: input.priority ?? 0,
    hysteresisRatio: input.hysteresisRatio ?? selectorOptions.defaultHysteresisRatio,
  }], selectorOptions)[0]!;
  const levels = validated.levels.map((level, index) => Object.freeze({
    ...level,
    geometryId: geometryIds[index]!,
  }));
  return Object.freeze({
    id: validated.id,
    instanceId: input.instanceId,
    bounds: validated.bounds,
    materialId,
    levels: Object.freeze(levels),
    mask: validateSpatialMask(input.mask ?? DEFAULT_SPATIAL_MASK),
    priority: validated.priority,
    hysteresisRatio: validated.hysteresisRatio,
  });
}

export function patchedVisibleObject<TId extends SpatialItemId>(
  current: ValidatedVisibleObject<TId>,
  patch: VisibleObjectPatch,
): VisibleObjectRegistration<TId> {
  if (!patch || typeof patch !== "object") {
    throw new SpatialIndexError("missing-metadata", `Update metadata for ${String(current.id)} is required.`);
  }
  return {
    id: current.id,
    instanceId: ownValue(patch, "instanceId", current.instanceId),
    bounds: ownValue(patch, "bounds", current.bounds),
    materialId: ownValue(patch, "materialId", current.materialId),
    levels: ownValue(patch, "levels", current.levels),
    mask: ownValue(patch, "mask", current.mask),
    priority: ownValue(patch, "priority", current.priority),
    hysteresisRatio: ownValue(patch, "hysteresisRatio", current.hysteresisRatio),
  };
}

export function sameVisibleObject<TId extends SpatialItemId>(
  left: ValidatedVisibleObject<TId>,
  right: ValidatedVisibleObject<TId>,
): boolean {
  return left.instanceId === right.instanceId
    && left.materialId === right.materialId
    && left.mask === right.mask
    && left.priority === right.priority
    && left.hysteresisRatio === right.hysteresisRatio
    && sameAabb(left.bounds, right.bounds)
    && sameLevels(left.levels, right.levels, true);
}

export function sameLodProfile(
  left: readonly VisibleObjectLodLevel[],
  right: readonly VisibleObjectLodLevel[],
): boolean {
  return sameLevels(left, right, false);
}

function sameLevels(
  left: readonly VisibleObjectLodLevel[],
  right: readonly VisibleObjectLodLevel[],
  includeGeometry: boolean,
): boolean {
  return left.length === right.length && left.every((level, index) => {
    const other = right[index]!;
    return (!includeGeometry || level.geometryId === other.geometryId)
      && level.minProjectedDiameterPixels === other.minProjectedDiameterPixels
      && level.geometricError === other.geometricError
      && level.triangles === other.triangles;
  });
}

function validateHandle(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_HANDLE_CODE_UNITS) {
    throw new SpatialIndexError("invalid-handle", `${label} must be a non-empty handle of at most ${MAX_HANDLE_CODE_UNITS} code units.`);
  }
  return value;
}

function ownValue<T extends object, K extends keyof T, V>(target: T, key: K, fallback: V): V {
  if (!Object.prototype.hasOwnProperty.call(target, key)) return fallback;
  const value = target[key];
  if (value === undefined) {
    throw new SpatialIndexError("missing-metadata", `Visible object update field ${String(key)} cannot be undefined.`);
  }
  return value as unknown as V;
}
