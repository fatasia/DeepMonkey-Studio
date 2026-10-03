import type { GeometryResource } from "../renderPacketTypes.js";
import { ptAdd, ptCross, ptDot, ptNormalize, ptScale,
  type PathTraceRgb, type PathTraceVec3 } from "./pathTraceCpuTypes.js";

export interface PathTraceTriangleNormals {
  readonly origin: PathTraceRgb;
  readonly edge1: PathTraceRgb;
  readonly edge2: PathTraceRgb;
  readonly gram: readonly [number, number, number, number];
  readonly geometric: PathTraceRgb;
  readonly corners: readonly [PathTraceRgb, PathTraceRgb, PathTraceRgb];
  readonly flat: boolean;
}

/** Prepared packet arrays are already snapshot-owned; each shared triangle is prepared once. */
export function preparePathTraceTriangleNormals(geometry: GeometryResource): readonly PathTraceTriangleNormals[] {
  return Array.from({ length: geometry.indices.length / 3 }, (_, triangle) => {
    const vector = (corner: number, offset: number): PathTraceVec3 => {
      const index = geometry.indices[triangle * 3 + corner]! * 6 + offset;
      return [geometry.vertices[index]!, geometry.vertices[index + 1]!, geometry.vertices[index + 2]!];
    };
    const origin = vector(0, 0), edge1 = ptAdd(vector(1, 0), ptScale(origin, -1));
    const edge2 = ptAdd(vector(2, 0), ptScale(origin, -1)), cross = ptCross(edge1, edge2);
    const determinant = ptDot(cross, cross), geometric = ptNormalize(cross);
    if (!(determinant > 0) || !Number.isFinite(determinant)) throw new Error("CPU path trace unsupported degenerate triangle.");
    const corners = [vector(0, 3), vector(1, 3), vector(2, 3)] as const;
    for (const normal of corners) {
      if (Math.abs(Math.hypot(...normal) - 1) > 1e-5 || ptDot(normal, geometric) <= 0) {
        throw new Error("CPU path trace unsupported non-unit or reversed authored normal.");
      }
    }
    return { origin, edge1, edge2, geometric, corners,
      gram: [ptDot(edge1, edge1), ptDot(edge1, edge2), ptDot(edge2, edge2), determinant] as const,
      flat: corners.every(normal => normal.every((value, axis) => value === geometric[axis])) };
  });
}

/** Hit records intentionally have zero barycentrics; reconstruct only the accepted PT hit. */
export function pathTraceTriangleWeights(triangle: PathTraceTriangleNormals, point: PathTraceRgb): PathTraceVec3 {
  const delta = ptAdd(point, ptScale(triangle.origin, -1));
  const q1 = ptDot(delta, triangle.edge1), q2 = ptDot(delta, triangle.edge2);
  const [a, b, c, determinant] = triangle.gram;
  const u = (c * q1 - b * q2) / determinant, v = (a * q2 - b * q1) / determinant;
  const result: PathTraceVec3 = [1 - u - v, u, v];
  if (result.some(weight => !Number.isFinite(weight) || weight < -1e-5 || weight > 1 + 1e-5)) {
    throw new Error("CPU path trace accepted hit exceeds triangle interpolation precision.");
  }
  return result;
}

export function pathTraceWorldNormal(normal: PathTraceRgb, inverse: readonly number[]): PathTraceVec3 {
  return ptNormalize([inverse[0]! * normal[0] + inverse[4]! * normal[1] + inverse[8]! * normal[2],
    inverse[1]! * normal[0] + inverse[5]! * normal[1] + inverse[9]! * normal[2],
    inverse[2]! * normal[0] + inverse[6]! * normal[1] + inverse[10]! * normal[2]]);
}

/** Match production vertex-normal normalization before fragment/triangle interpolation. */
export function preparePathTraceWorldNormals(triangle: PathTraceTriangleNormals, inverse: readonly number[]) {
  const geometric = pathTraceWorldNormal(triangle.geometric, inverse);
  const corners = triangle.corners.map(normal => pathTraceWorldNormal(normal, inverse));
  if (corners.some(normal => ptDot(normal, geometric) <= 0)) {
    throw new Error("CPU path trace unsupported transformed authored normal across geometric hemisphere.");
  }
  return { geometric, corners };
}

export function interpolatePathTraceWorldNormal(corners: readonly PathTraceRgb[], weights: PathTraceRgb): PathTraceVec3 {
  return ptNormalize([0, 1, 2].map(axis => corners.reduce((sum, normal, corner) =>
    sum + normal[axis]! * weights[corner]!, 0)) as PathTraceVec3);
}
