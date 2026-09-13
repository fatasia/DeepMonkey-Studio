import { meshletLimit, rejectShared } from "./inputValidation.js";
import { unpackLocalTriangle } from "./localTriangle.js";
import { triangleNormal } from "./meshletBounds.js";
import {
  MESHLET_BOUNDS_STRIDE,
  MESHLET_BUILD_BUDGETS,
  MESHLET_DEFAULTS,
  MESHLET_DESCRIPTOR_STRIDE,
  MESHLET_SCHEMA_VERSION,
  MeshletError,
  type MeshletBuildResult,
  type MeshletValidationOptions,
} from "./types.js";

export function validateMeshletBuild(
  value: MeshletBuildResult,
  options: MeshletValidationOptions = {},
): MeshletBuildResult {
  if (!value || typeof value !== "object") fail("Meshlet result must be an object.");
  if (value.schemaVersion !== MESHLET_SCHEMA_VERSION) fail(`Unsupported meshlet schema ${String(value.schemaVersion)}.`);
  integer(value.sourceVertexCount, MESHLET_BUILD_BUDGETS.sourceVertices, "sourceVertexCount");
  integer(value.sourceTriangleCount, MESHLET_BUILD_BUDGETS.sourceTriangles, "sourceTriangleCount");
  integer(value.meshletCount, MESHLET_BUILD_BUDGETS.outputMeshlets, "meshletCount");
  const maxVertices = meshletLimit(options.maxVertices ?? value.maxVertices, MESHLET_DEFAULTS.maxVertices, "maxVertices");
  const maxTriangles = meshletLimit(options.maxTriangles ?? value.maxTriangles, MESHLET_DEFAULTS.maxTriangles, "maxTriangles");
  if (value.maxVertices !== maxVertices || value.maxTriangles !== maxTriangles) fail("Meshlet limits do not match the validation contract.");

  typed(value.descriptors, Uint32Array, "descriptors");
  typed(value.vertexRemap, Uint32Array, "vertexRemap");
  typed(value.localTriangleIndices, Uint32Array, "localTriangleIndices");
  typed(value.bounds, Float32Array, "bounds");
  exact(value.descriptors.length, value.meshletCount * MESHLET_DESCRIPTOR_STRIDE, "descriptor length");
  exact(value.bounds.length, value.meshletCount * MESHLET_BOUNDS_STRIDE, "bounds length");
  exact(value.localTriangleIndices.length, value.sourceTriangleCount, "triangle data length");
  const outputBytes = value.descriptors.byteLength + value.vertexRemap.byteLength
    + value.localTriangleIndices.byteLength + value.bounds.byteLength;
  if (outputBytes > MESHLET_BUILD_BUDGETS.outputBytes) fail("Meshlet output byte budget is exceeded.");

  const source = options.sourcePositions;
  if (source !== undefined) validateSourcePositions(source, value.sourceVertexCount);
  let expectedVertexOffset = 0, expectedTriangleOffset = 0;
  for (let meshlet = 0; meshlet < value.meshletCount; meshlet += 1) {
    const d = meshlet * MESHLET_DESCRIPTOR_STRIDE;
    const vertexOffset = value.descriptors[d]!, vertexCount = value.descriptors[d + 1]!;
    const triangleOffset = value.descriptors[d + 2]!, triangleCount = value.descriptors[d + 3]!;
    if (vertexOffset !== expectedVertexOffset || triangleOffset !== expectedTriangleOffset) fail(`Meshlet ${meshlet} offsets must be contiguous.`);
    if (vertexCount < 1 || vertexCount > maxVertices || triangleCount < 1 || triangleCount > maxTriangles) {
      fail(`Meshlet ${meshlet} exceeds its vertex or triangle limit.`);
    }
    if (vertexOffset + vertexCount > value.vertexRemap.length || triangleOffset + triangleCount > value.localTriangleIndices.length) {
      fail(`Meshlet ${meshlet} range exceeds its backing array.`);
    }
    validateRemap(value, meshlet, vertexOffset, vertexCount);
    validateTriangles(value, meshlet, vertexCount, triangleOffset, triangleCount);
    validateBounds(value, meshlet, vertexOffset, vertexCount, source);
    if (source) validateConeContainsTriangles(value, meshlet, vertexOffset, triangleOffset, triangleCount, source);
    expectedVertexOffset += vertexCount;
    expectedTriangleOffset += triangleCount;
  }
  exact(expectedVertexOffset, value.vertexRemap.length, "vertex remap length");
  exact(expectedTriangleOffset, value.localTriangleIndices.length, "triangle data length");
  if (value.meshletCount === 0 && (value.sourceTriangleCount !== 0 || value.vertexRemap.length !== 0)) {
    fail("An empty meshlet result must not contain triangles or remapped vertices.");
  }
  return value;
}

function validateConeContainsTriangles(value: MeshletBuildResult, meshlet: number, vertexOffset: number,
  triangleOffset: number, triangleCount: number, source: Float32Array): void {
  const boundsOffset = meshlet * MESHLET_BOUNDS_STRIDE, cutoff = value.bounds[boundsOffset + 15]!;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const local = unpackLocalTriangle(value.localTriangleIndices[triangleOffset + triangle]!);
    const normal = triangleNormal(source,
      value.vertexRemap[vertexOffset + local[0]]!,
      value.vertexRemap[vertexOffset + local[1]]!,
      value.vertexRemap[vertexOffset + local[2]]!);
    if (!normal) {
      if (cutoff !== -1) fail(`Meshlet ${meshlet} must disable cone culling for degenerate triangles.`);
      continue;
    }
    if (cutoff === -1) continue;
    const dot = value.bounds[boundsOffset + 12]! * normal[0]
      + value.bounds[boundsOffset + 13]! * normal[1]
      + value.bounds[boundsOffset + 14]! * normal[2];
    if (dot + 1e-6 < cutoff) fail(`Meshlet ${meshlet} normal cone does not contain every face normal.`);
  }
}

function validateRemap(value: MeshletBuildResult, meshlet: number, offset: number, count: number): void {
  const unique = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    const global = value.vertexRemap[offset + index]!;
    if (global >= value.sourceVertexCount) fail(`Meshlet ${meshlet} remap is outside the source vertex range.`);
    if (unique.has(global)) fail(`Meshlet ${meshlet} contains a duplicate remapped vertex.`);
    unique.add(global);
  }
}

function validateTriangles(value: MeshletBuildResult, meshlet: number, vertexCount: number, offset: number, count: number): void {
  const used = new Uint8Array(vertexCount);
  for (let index = 0; index < count; index += 1) {
    const local = unpackLocalTriangle(value.localTriangleIndices[offset + index]!);
    for (const vertex of local) {
      if (vertex >= vertexCount) fail(`Meshlet ${meshlet} has a local index outside its vertex table.`);
      used[vertex] = 1;
    }
  }
  if (used.some((entry) => entry === 0)) fail(`Meshlet ${meshlet} remaps an unreferenced vertex.`);
}

function validateBounds(value: MeshletBuildResult, meshlet: number, vertexOffset: number, vertexCount: number, source?: Float32Array): void {
  const offset = meshlet * MESHLET_BOUNDS_STRIDE;
  for (let index = 0; index < MESHLET_BOUNDS_STRIDE; index += 1) {
    if (!Number.isFinite(value.bounds[offset + index])) fail(`Meshlet ${meshlet} bounds must be finite.`);
  }
  const radius = value.bounds[offset + 3]!, cutoff = value.bounds[offset + 15]!;
  if (radius < 0) fail(`Meshlet ${meshlet} sphere radius must be non-negative.`);
  for (let axis = 0; axis < 3; axis += 1) {
    if (value.bounds[offset + 4 + axis]! > value.bounds[offset + 8 + axis]!) fail(`Meshlet ${meshlet} AABB is inverted.`);
  }
  if (value.bounds[offset + 7] !== 0 || value.bounds[offset + 11] !== 0) fail(`Meshlet ${meshlet} AABB padding must be zero.`);
  if (cutoff !== -1) {
    const length = Math.hypot(value.bounds[offset + 12]!, value.bounds[offset + 13]!, value.bounds[offset + 14]!);
    if (cutoff < 0 || cutoff > 1 || Math.abs(length - 1) > 1e-5) fail(`Meshlet ${meshlet} normal cone is invalid.`);
  }
  if (!source) return;
  for (let local = 0; local < vertexCount; local += 1) {
    const positionOffset = value.vertexRemap[vertexOffset + local]! * 3;
    let distanceSquared = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      const coordinate = source[positionOffset + axis]!;
      if (coordinate < value.bounds[offset + 4 + axis]! || coordinate > value.bounds[offset + 8 + axis]!) {
        fail(`Meshlet ${meshlet} AABB does not contain its source positions.`);
      }
      const delta = coordinate - value.bounds[offset + axis]!;
      distanceSquared += delta * delta;
    }
    if (Math.sqrt(distanceSquared) > radius) fail(`Meshlet ${meshlet} sphere does not contain its source positions.`);
  }
}

function validateSourcePositions(source: Float32Array, vertexCount: number): void {
  typed(source, Float32Array, "sourcePositions");
  exact(source.length, vertexCount * 3, "source position length");
  for (const coordinate of source) if (!Number.isFinite(coordinate)) fail("Source positions must be finite.");
}

function typed(value: ArrayBufferView, constructor: typeof Uint32Array | typeof Float32Array, label: string): void {
  if (!(value instanceof constructor)) fail(`${label} has an invalid typed-array representation.`);
  rejectShared(value, label);
}

function integer(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(`${label} is outside its supported range.`);
}

function exact(actual: number, expected: number, label: string): void {
  if (actual !== expected) fail(`Meshlet ${label} must be ${expected}, received ${actual}.`);
}

function fail(message: string): never {
  throw new MeshletError("invalid-result", message);
}
