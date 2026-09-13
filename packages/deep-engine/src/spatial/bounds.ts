import { SpatialIndexError, type SpatialAabb, type SpatialFrustum, type SpatialPlane, type SpatialVec3 } from "./types.js";

const MAX_COORDINATE_MAGNITUDE = 1e15;

export function spatialAabb(
  min: SpatialVec3,
  max: SpatialVec3,
): SpatialAabb {
  return validateSpatialAabb({ min, max });
}

export function spatialAabbFromCenter(
  center: SpatialVec3,
  halfExtents: SpatialVec3,
): SpatialAabb {
  const c = validateVector(center, "center");
  const h = validateVector(halfExtents, "halfExtents");
  if (h.some((value) => value < 0)) {
    throw new SpatialIndexError("invalid-bounds", "Spatial AABB half extents must be non-negative.");
  }
  return validateSpatialAabb({
    min: [c[0] - h[0], c[1] - h[1], c[2] - h[2]],
    max: [c[0] + h[0], c[1] + h[1], c[2] + h[2]],
  });
}

/** Transforms a local AABB by a column-major affine matrix without losing mirrored or sheared extents. */
export function transformSpatialAabb(bounds: SpatialAabb, transform: ArrayLike<number>): SpatialAabb {
  const local = validateSpatialAabb(bounds, { label: "Local spatial AABB" });
  if (!transform || transform.length !== 16) {
    throw new SpatialIndexError("invalid-transform", "Spatial transform must contain 16 components.");
  }
  const matrix: number[] = [];
  for (let index = 0; index < 16; index += 1) {
    const component = transform[index];
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new SpatialIndexError("invalid-transform", "Spatial transform components must be finite numbers.");
    }
    matrix.push(component);
  }
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) {
    throw new SpatialIndexError("invalid-transform", "Spatial transform must be an affine column-major matrix.");
  }
  const center = aabbCenter(local);
  const half = aabbHalfExtents(local);
  const worldCenter: SpatialVec3 = [
    matrix[0]! * center[0] + matrix[4]! * center[1] + matrix[8]! * center[2] + matrix[12]!,
    matrix[1]! * center[0] + matrix[5]! * center[1] + matrix[9]! * center[2] + matrix[13]!,
    matrix[2]! * center[0] + matrix[6]! * center[1] + matrix[10]! * center[2] + matrix[14]!,
  ];
  const worldHalf: SpatialVec3 = [
    Math.abs(matrix[0]!) * half[0] + Math.abs(matrix[4]!) * half[1] + Math.abs(matrix[8]!) * half[2],
    Math.abs(matrix[1]!) * half[0] + Math.abs(matrix[5]!) * half[1] + Math.abs(matrix[9]!) * half[2],
    Math.abs(matrix[2]!) * half[0] + Math.abs(matrix[6]!) * half[1] + Math.abs(matrix[10]!) * half[2],
  ];
  return spatialAabbFromCenter(worldCenter, worldHalf);
}

export function validateSpatialAabb(
  value: SpatialAabb,
  options: { readonly requireVolume?: boolean; readonly label?: string } = {},
): SpatialAabb {
  const label = options.label ?? "Spatial AABB";
  const min = validateVector(value?.min, `${label}.min`);
  const max = validateVector(value?.max, `${label}.max`);
  for (let axis = 0; axis < 3; axis += 1) {
    if (min[axis]! > max[axis]!) {
      throw new SpatialIndexError("invalid-bounds", `${label} min must not exceed max on axis ${axis}.`);
    }
    if (options.requireVolume && min[axis] === max[axis]) {
      throw new SpatialIndexError("invalid-bounds", `${label} must have positive volume.`);
    }
  }
  return freezeAabb(min, max);
}

export function validateSpatialFrustum(value: SpatialFrustum): SpatialFrustum {
  if (!value || !Array.isArray(value.planes) || value.planes.length !== 6) {
    throw new SpatialIndexError("invalid-frustum", "A spatial frustum must contain exactly six planes.");
  }
  const planes = value.planes.map((plane, index) => normalizePlane(plane, index));
  return Object.freeze({ planes: Object.freeze(planes) });
}

export function aabbIntersects(left: SpatialAabb, right: SpatialAabb): boolean {
  return left.min[0] <= right.max[0] && left.max[0] >= right.min[0]
    && left.min[1] <= right.max[1] && left.max[1] >= right.min[1]
    && left.min[2] <= right.max[2] && left.max[2] >= right.min[2];
}

export function aabbContains(container: SpatialAabb, value: SpatialAabb): boolean {
  return container.min[0] <= value.min[0] && container.max[0] >= value.max[0]
    && container.min[1] <= value.min[1] && container.max[1] >= value.max[1]
    && container.min[2] <= value.min[2] && container.max[2] >= value.max[2];
}

export function aabbIntersectsFrustum(bounds: SpatialAabb, frustum: SpatialFrustum): boolean {
  const center = aabbCenter(bounds);
  const half = aabbHalfExtents(bounds);
  for (const [x, y, z, distance] of frustum.planes) {
    const projectedRadius = Math.abs(x) * half[0] + Math.abs(y) * half[1] + Math.abs(z) * half[2];
    if (x * center[0] + y * center[1] + z * center[2] + distance + projectedRadius < 0) return false;
  }
  return true;
}

export function aabbCenter(bounds: SpatialAabb): SpatialVec3 {
  return [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
}

export function aabbHalfExtents(bounds: SpatialAabb): SpatialVec3 {
  return [
    (bounds.max[0] - bounds.min[0]) * 0.5,
    (bounds.max[1] - bounds.min[1]) * 0.5,
    (bounds.max[2] - bounds.min[2]) * 0.5,
  ];
}

export function sameAabb(left: SpatialAabb, right: SpatialAabb): boolean {
  return left.min.every((value, axis) => value === right.min[axis])
    && left.max.every((value, axis) => value === right.max[axis]);
}

function validateVector(value: SpatialVec3, label: string): SpatialVec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new SpatialIndexError("invalid-bounds", `${label} must contain exactly three numbers.`);
  }
  const copy = [...value];
  if (copy.some((component) => typeof component !== "number"
    || !Number.isFinite(component) || Math.abs(component) > MAX_COORDINATE_MAGNITUDE)) {
    throw new SpatialIndexError("invalid-bounds", `${label} contains a non-finite or unsupported coordinate.`);
  }
  return Object.freeze(copy) as unknown as SpatialVec3;
}

function normalizePlane(value: SpatialPlane, index: number): SpatialPlane {
  if (!Array.isArray(value) || value.length !== 4 || value.some((component) => !Number.isFinite(component))) {
    throw new SpatialIndexError("invalid-frustum", `Frustum plane ${index} must contain four finite numbers.`);
  }
  const length = Math.hypot(value[0], value[1], value[2]);
  if (length <= Number.EPSILON) {
    throw new SpatialIndexError("invalid-frustum", `Frustum plane ${index} has a zero normal.`);
  }
  return Object.freeze([value[0] / length, value[1] / length, value[2] / length, value[3] / length]);
}

function freezeAabb(min: SpatialVec3, max: SpatialVec3): SpatialAabb {
  return Object.freeze({ min: Object.freeze([...min]) as SpatialVec3, max: Object.freeze([...max]) as SpatialVec3 });
}
