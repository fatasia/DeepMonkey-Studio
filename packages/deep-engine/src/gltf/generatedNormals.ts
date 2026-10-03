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

/**
 * 真实资产常带零长度顶点法线(退化顶点/导出器缺陷)。Three 容忍并仍能绘制,引擎导入若逐个拒绝会让整件模型不可用:
 * 零法线顶点改用面积加权的几何法线;顶点不属于任何有效三角形时(绘制不到)用 +Z 占位。
 * 全部法线有效时原样返回同一数组(零拷贝,行为不变)。
 */
export function repairZeroNormals(normals: Float32Array<ArrayBuffer>, positions: Float32Array, indices: Uint32Array,
  path: string): Float32Array<ArrayBuffer> {
  const vertexCount = normals.length / 3;
  let broken = -1;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    if (Math.hypot(normals[vertex * 3]!, normals[vertex * 3 + 1]!, normals[vertex * 3 + 2]!) < 1e-8) { broken = vertex; break; }
  }
  if (broken < 0) return normals;
  const repaired = new Float32Array(normals);
  const generated = generateNormals(positions, indices, path, [0, 0, 1]);
  for (let vertex = broken; vertex < vertexCount; vertex++) {
    if (Math.hypot(repaired[vertex * 3]!, repaired[vertex * 3 + 1]!, repaired[vertex * 3 + 2]!) < 1e-8) {
      repaired.set(generated.subarray(vertex * 3, vertex * 3 + 3), vertex * 3);
    }
  }
  return repaired;
}
