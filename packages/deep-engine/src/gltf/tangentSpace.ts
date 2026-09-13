import { invalid } from "./validation.js";

const QUALITY_EPSILON = 1e-8;

/**
 * 为法线纹理生成索引三角网格切线。算法按几何面积累计 UV 导数，随后对顶点法线做 Gram-Schmidt；
 * UV 手性在共享顶点冲突时拒绝，避免在未拆分的镜像缝上生成不确定 TBN。
 */
export function generateTangents(vertices: Float32Array, uv0: Float32Array, indices: Uint32Array,
  path: string): Float32Array<ArrayBuffer> {
  const vertexCount = vertices.length / 6;
  if (uv0.length !== vertexCount * 2) invalid(path, "POSITION/NORMAL and TEXCOORD_0 counts differ.");
  const tangentSum = new Float64Array(vertexCount * 3), bitangentSum = new Float64Array(vertexCount * 3);
  const orientation = new Int8Array(vertexCount), contributions = new Uint32Array(vertexCount);

  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const a = indices[triangle]!, b = indices[triangle + 1]!, c = indices[triangle + 2]!;
    const e1 = edge(vertices, a, b), e2 = edge(vertices, a, c);
    const cross = cross3(e1, e2), area2 = length3(cross), edgeQuality = length3(e1) * length3(e2);
    const du1 = uv0[b * 2]! - uv0[a * 2]!, dv1 = uv0[b * 2 + 1]! - uv0[a * 2 + 1]!;
    const du2 = uv0[c * 2]! - uv0[a * 2]!, dv2 = uv0[c * 2 + 1]! - uv0[a * 2 + 1]!;
    const determinant = du1 * dv2 - du2 * dv1, uvQuality = Math.hypot(du1, dv1) * Math.hypot(du2, dv2);
    if (!edgeQuality || area2 / edgeQuality < QUALITY_EPSILON || !uvQuality || Math.abs(determinant) / uvQuality < QUALITY_EPSILON) continue;
    const inverse = 1 / determinant;
    const tangent = scale3(subtract3(scale3(e1, dv2), scale3(e2, dv1)), inverse);
    const bitangent = scale3(subtract3(scale3(e2, du1), scale3(e1, du2)), inverse);
    const tangentLength = length3(tangent), bitangentLength = length3(bitangent);
    if (!Number.isFinite(tangentLength + bitangentLength) || tangentLength < 1e-12 || bitangentLength < 1e-12) continue;
    const sign = determinant < 0 ? -1 : 1;
    for (const vertex of [a, b, c]) {
      const previousOrientation = orientation[vertex]!;
      if (previousOrientation && previousOrientation !== sign) {
        invalid(path, "Mirrored UV charts sharing a vertex require an authored TANGENT seam.");
      }
      orientation[vertex] = sign; contributions[vertex] = contributions[vertex]! + 1;
      accumulate(tangentSum, vertex, tangent, area2 / tangentLength);
      accumulate(bitangentSum, vertex, bitangent, area2 / bitangentLength);
    }
  }

  const result = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    if (!contributions[vertex]) invalid(path, `Cannot derive a tangent for vertex ${vertex} from degenerate geometry or UVs.`);
    const source = vertex * 6, normal = normalize3([vertices[source + 3]!, vertices[source + 4]!, vertices[source + 5]!]);
    const sum = read3(tangentSum, vertex), projected = subtract3(sum, scale3(normal, dot3(normal, sum)));
    const tangentLength = length3(projected);
    if (!Number.isFinite(tangentLength) || tangentLength < 1e-8) invalid(path, `Tangent accumulation cancelled at vertex ${vertex}.`);
    const tangent = scale3(projected, 1 / tangentLength), bitangent = read3(bitangentSum, vertex);
    const handedness = dot3(cross3(normal, tangent), bitangent) < 0 ? -1 : 1;
    result.set([Math.fround(tangent[0]), Math.fround(tangent[1]), Math.fround(tangent[2]), handedness], vertex * 4);
  }
  return result;
}

export function validateTangentBasis(vertices: Float32Array, tangents: Float32Array, indices: Uint32Array, path: string): void {
  if (tangents.length !== vertices.length / 6 * 4) invalid(path, "POSITION/NORMAL and TANGENT counts differ.");
  for (let vertex = 0; vertex < tangents.length / 4; vertex++) {
    const source = vertex * 6, target = vertex * 4;
    const normal = normalize3([vertices[source + 3]!, vertices[source + 4]!, vertices[source + 5]!]);
    const tangent: Vec3 = [tangents[target]!, tangents[target + 1]!, tangents[target + 2]!];
    const w = tangents[target + 3]!;
    if (!Number.isFinite(length3(tangent) + w) || Math.abs(length3(tangent) - 1) > 1e-3 || (w !== -1 && w !== 1)) {
      invalid(path, "TANGENT must contain unit XYZ and W equal to -1 or +1.");
    }
    if (Math.abs(dot3(normal, tangent)) > 1e-3) invalid(path, "TANGENT must be orthogonal to NORMAL.");
  }
  for (let index = 0; index < indices.length; index += 3) {
    const a = tangents[indices[index]! * 4 + 3]!, b = tangents[indices[index + 1]! * 4 + 3]!, c = tangents[indices[index + 2]! * 4 + 3]!;
    if (a !== b || a !== c) invalid(path, "TANGENT handedness must be consistent within each triangle.");
  }
}

type Vec3 = readonly [number, number, number];
const edge = (vertices: Float32Array, from: number, to: number): Vec3 => {
  const a = from * 6, b = to * 6;
  return [vertices[b]! - vertices[a]!, vertices[b + 1]! - vertices[a + 1]!, vertices[b + 2]! - vertices[a + 2]!];
};
const read3 = (values: Float64Array, vertex: number): Vec3 => [values[vertex * 3]!, values[vertex * 3 + 1]!, values[vertex * 3 + 2]!];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length3 = (value: Vec3): number => Math.hypot(value[0], value[1], value[2]);
const scale3 = (value: Vec3, scalar: number): Vec3 => [value[0] * scalar, value[1] * scalar, value[2] * scalar];
const subtract3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize3 = (value: Vec3): Vec3 => scale3(value, 1 / length3(value));
function accumulate(target: Float64Array, vertex: number, value: Vec3, weight: number): void {
  const offset = vertex * 3;
  target[offset] = target[offset]! + value[0] * weight;
  target[offset + 1] = target[offset + 1]! + value[1] * weight;
  target[offset + 2] = target[offset + 2]! + value[2] * weight;
}
