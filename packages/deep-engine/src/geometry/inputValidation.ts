import {
  MESHLET_BUILD_BUDGETS,
  MESHLET_DEFAULTS,
  MeshletError,
  type IndexedTriangleGeometry,
  type MeshletBuildOptions,
} from "./types.js";

export interface ValidatedMeshletInput {
  readonly positions: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly maxVertices: number;
  readonly maxTriangles: number;
}

export function validateMeshletInput(
  geometry: IndexedTriangleGeometry,
  options: MeshletBuildOptions = {},
): ValidatedMeshletInput {
  if (!geometry || typeof geometry !== "object") invalid("Geometry must be an object.");
  const { positions, indices } = geometry;
  if (!(positions instanceof Float32Array)) invalid("positions must be a Float32Array.");
  if (!(indices instanceof Uint16Array) && !(indices instanceof Uint32Array)) {
    invalid("indices must be a Uint16Array or Uint32Array.");
  }
  rejectShared(positions, "positions");
  rejectShared(indices, "indices");
  if (positions.length % 3 !== 0) invalid("positions must contain tightly packed XYZ triples.");
  if (indices.length % 3 !== 0) invalid("indices must contain complete triangles.");
  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;
  budget(vertexCount, MESHLET_BUILD_BUDGETS.sourceVertices, "source vertices");
  budget(triangleCount, MESHLET_BUILD_BUDGETS.sourceTriangles, "source triangles");
  for (let offset = 0; offset < positions.length; offset += 1) {
    if (!Number.isFinite(positions[offset])) invalid(`Position component ${offset} must be finite.`);
  }
  for (let offset = 0; offset < indices.length; offset += 1) {
    if (indices[offset]! >= vertexCount) invalid(`Index ${offset} is outside the source vertex range.`);
  }
  return Object.freeze({
    positions,
    indices,
    vertexCount,
    triangleCount,
    maxVertices: meshletLimit(options.maxVertices, MESHLET_DEFAULTS.maxVertices, "maxVertices"),
    maxTriangles: meshletLimit(options.maxTriangles, MESHLET_DEFAULTS.maxTriangles, "maxTriangles"),
  });
}

export function budget(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new MeshletError("budget-exceeded", `${label} exceeds the supported limit of ${maximum}.`);
  }
}

export function meshletLimit(value: number | undefined, maximum: number, label: string): number {
  const resolved = value ?? maximum;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    invalid(`${label} must be an integer in 1..${maximum}.`);
  }
  return resolved;
}

export function rejectShared(value: ArrayBufferView, label: string): void {
  if (typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer) {
    invalid(`${label} must not use SharedArrayBuffer because concurrent mutation breaks determinism.`);
  }
}

export function invalid(message: string): never {
  throw new MeshletError("invalid-input", message);
}
