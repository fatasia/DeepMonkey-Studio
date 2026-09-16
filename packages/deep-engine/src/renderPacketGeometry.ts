import type { GeometryFeatures, GeometryResource, PreparedBatch } from "./renderPacketTypes.js";

export function validateGeometries(geometries: ReadonlyMap<string, GeometryResource>): void {
  let bytes = 0;
  for (const geometry of geometries.values()) {
    validateGeometryLayout(geometry);
    bytes += geometryGpuByteLength(geometry);
    if (bytes > 128 * 1024 * 1024) throw new Error("Geometry data exceeds packet budget.");
    validateGeometryContent(geometry);
  }
}

/** Exact bytes allocated by MeshBuffers for the fixed Deep PBR vertex ABI. */
export function geometryGpuByteLength(geometry: GeometryResource): number {
  return geometry.vertices.length / 6 * 40
    + (geometry.tangents?.byteLength ?? 0)
    + (geometry.colors?.byteLength ?? 0)
    + geometry.indices.byteLength;
}

export function geometryFeatureMap(
  geometries: ReadonlyMap<string, GeometryResource>,
): ReadonlyMap<string, GeometryFeatures> {
  return new Map(Array.from(geometries, ([id, geometry]) => [id, {
    uv0: geometry.uv0 !== undefined,
    uv1: geometry.uv1 !== undefined,
    tangents: geometry.tangents !== undefined,
    colors: geometry.colors !== undefined,
    triangles: geometry.indices.length / 3,
    center: geometryCenter(geometry),
  }]));
}

export function snapshotUsedGeometries(
  geometries: ReadonlyMap<string, GeometryResource>,
  batches: readonly PreparedBatch[],
  requiredGeometryIds: readonly string[] = [],
): ReadonlyMap<string, GeometryResource> {
  const owned = new Map<string, GeometryResource>();
  const usedIds = new Set([...requiredGeometryIds, ...batches.flatMap(batch => batch.lod?.levels.map(level => level.geometry) ?? [batch.geometry])]);
  for (const id of usedIds) {
    const geometry = geometries.get(id)!;
    owned.set(geometry.id, {
      id: geometry.id,
      revision: geometry.revision,
      vertices: geometry.vertices.slice(),
      ...(geometry.uv0 ? { uv0: geometry.uv0.slice() } : {}),
      ...(geometry.uv1 ? { uv1: geometry.uv1.slice() } : {}),
      ...(geometry.tangents ? { tangents: geometry.tangents.slice() } : {}),
      ...(geometry.colors ? { colors: geometry.colors.slice() } : {}),
      indices: geometry.indices.slice(),
    });
  }
  return owned;
}

export function geometryCenter(geometry: GeometryResource): readonly [number, number, number] {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const index of geometry.indices) {
    const offset = index * 6;
    const x = geometry.vertices[offset]!, y = geometry.vertices[offset + 1]!, z = geometry.vertices[offset + 2]!;
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  return [
    Math.fround(minX * 0.5 + maxX * 0.5),
    Math.fround(minY * 0.5 + maxY * 0.5),
    Math.fround(minZ * 0.5 + maxZ * 0.5),
  ];
}

function validateGeometryLayout(geometry: GeometryResource): void {
  if (!Number.isSafeInteger(geometry.revision) || geometry.revision < 0) throw new Error("Invalid geometry revision.");
  const { vertices, indices } = geometry;
  if (!(vertices instanceof Float32Array) || !(indices instanceof Uint32Array)
    || !vertices.length || vertices.length % 6 || !indices.length || indices.length % 3) {
    throw new Error("Invalid triangle geometry layout.");
  }
  for (const [name, uv] of [["UV0", geometry.uv0], ["UV1", geometry.uv1]] as const) {
    if (uv !== undefined && (!(uv instanceof Float32Array) || !(uv.buffer instanceof ArrayBuffer)
      || uv.length !== vertices.length / 3 || !uv.every(Number.isFinite))) {
      throw new Error(`Invalid geometry ${name} layout.`);
    }
  }
  const tangents = geometry.tangents;
  if (tangents !== undefined && (!(tangents instanceof Float32Array) || !(tangents.buffer instanceof ArrayBuffer)
    || tangents.length !== vertices.length / 6 * 4)) throw new Error("Invalid geometry tangent layout.");
  const colors = geometry.colors;
  if (colors !== undefined && (!(colors instanceof Float32Array) || !(colors.buffer instanceof ArrayBuffer)
    || colors.length !== vertices.length / 6 * 4 || !colors.every(Number.isFinite))) {
    throw new Error("Invalid geometry colors layout.");
  }
}

function validateGeometryContent(geometry: GeometryResource): void {
  const { vertices, indices, tangents } = geometry;
  for (const index of indices) {
    if (index >= vertices.length / 6) throw new Error("Geometry contains non-finite vertices or out-of-range indices.");
  }
  for (let offset = 0; offset < vertices.length; offset += 6) {
    const x = vertices[offset]!, y = vertices[offset + 1]!, z = vertices[offset + 2]!;
    const nx = vertices[offset + 3]!, ny = vertices[offset + 4]!, nz = vertices[offset + 5]!;
    if (!Number.isFinite(x + y + z + nx + ny + nz)) {
      throw new Error("Geometry contains non-finite vertices or out-of-range indices.");
    }
    if (Math.hypot(nx, ny, nz) < 1e-8) throw new Error("Geometry normals must be nonzero.");
    if (tangents) validateTangent(tangents, offset / 6, nx, ny, nz);
  }
  if (tangents) validateTriangleHandedness(tangents, indices);
}

function validateTangent(
  tangents: Float32Array,
  vertex: number,
  nx: number,
  ny: number,
  nz: number,
): void {
  const offset = vertex * 4;
  const tx = tangents[offset]!, ty = tangents[offset + 1]!, tz = tangents[offset + 2]!, w = tangents[offset + 3]!;
  const tangentLength = Math.hypot(tx, ty, tz), normalLength = Math.hypot(nx, ny, nz);
  if (!Number.isFinite(tx + ty + tz + w) || Math.abs(tangentLength - 1) > 1e-3 || (w !== -1 && w !== 1)) {
    throw new Error("Geometry tangents must contain unit xyz and -1/+1 handedness.");
  }
  if (Math.abs((tx * nx + ty * ny + tz * nz) / normalLength) > 1e-3) {
    throw new Error("Geometry tangents must be orthogonal to normals.");
  }
}

function validateTriangleHandedness(tangents: Float32Array, indices: Uint32Array): void {
  for (let index = 0; index < indices.length; index += 3) {
    const a = tangents[indices[index]! * 4 + 3]!;
    const b = tangents[indices[index + 1]! * 4 + 3]!;
    const c = tangents[indices[index + 2]! * 4 + 3]!;
    if (a !== b || a !== c) throw new Error("Triangle tangent handedness must be consistent.");
  }
}
