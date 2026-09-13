import { invalid } from "./validation.js";

/** Generates deterministic, area-weighted smooth normals for triangle geometry. */
export function generateNormals(positions: Float32Array, indices: Uint32Array, path: string): Float32Array<ArrayBuffer> {
  if (positions.length % 3 !== 0 || indices.length % 3 !== 0) invalid(path, "Normal generation requires complete triangles.");
  const vertexCount = positions.length / 3, accumulated = new Float64Array(positions.length);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]!, b = indices[offset + 1]!, c = indices[offset + 2]!;
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) invalid(path, "Index exceeds vertex count.");
    const ao = a * 3, bo = b * 3, co = c * 3;
    const abx = positions[bo]! - positions[ao]!, aby = positions[bo + 1]! - positions[ao + 1]!, abz = positions[bo + 2]! - positions[ao + 2]!;
    const acx = positions[co]! - positions[ao]!, acy = positions[co + 1]! - positions[ao + 1]!, acz = positions[co + 2]! - positions[ao + 2]!;
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) invalid(path, "Generated normal is non-finite.");
    if (Math.hypot(nx, ny, nz) <= 1e-20) continue;
    for (const vertex of [a, b, c]) {
      const target = vertex * 3;
      accumulated[target] = accumulated[target]! + nx;
      accumulated[target + 1] = accumulated[target + 1]! + ny;
      accumulated[target + 2] = accumulated[target + 2]! + nz;
    }
  }
  const result = new Float32Array(positions.length);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 3, x = accumulated[offset]!, y = accumulated[offset + 1]!, z = accumulated[offset + 2]!;
    const length = Math.hypot(x, y, z);
    if (!Number.isFinite(length) || length <= 1e-20) invalid(path, `Cannot generate a normal for vertex ${vertex}.`);
    result[offset] = Math.fround(x / length); result[offset + 1] = Math.fround(y / length); result[offset + 2] = Math.fround(z / length);
  }
  return result;
}
