import { MeshletError } from "./types.js";

type Vec3 = readonly [number, number, number];
const ADJACENT_BUFFER = new ArrayBuffer(4);
const ADJACENT_FLOATS = new Float32Array(ADJACENT_BUFFER);
const ADJACENT_WORDS = new Uint32Array(ADJACENT_BUFFER);

export interface MeshletBounds {
  readonly sphere: readonly [number, number, number, number];
  readonly aabbMin: Vec3;
  readonly aabbMax: Vec3;
  readonly cone: readonly [number, number, number, number];
}

export function computeMeshletBounds(
  positions: Float32Array,
  vertices: readonly number[],
  triangleNormals: readonly Vec3[],
  hasDegenerateTriangle: boolean,
): MeshletBounds {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const vertex of vertices) {
    const offset = vertex * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[offset + axis]!;
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  const center: number[] = [];
  for (let axis = 0; axis < 3; axis += 1) center.push(Math.fround((min[axis]! + max[axis]!) * 0.5));
  let radius = 0;
  for (const vertex of vertices) {
    const offset = vertex * 3;
    radius = Math.max(radius, Math.hypot(
      positions[offset]! - center[0]!,
      positions[offset + 1]! - center[1]!,
      positions[offset + 2]! - center[2]!,
    ));
  }
  const conservativeRadius = nextFloat32(radius);
  if (!Number.isFinite(conservativeRadius)) {
    throw new MeshletError("overflow", "Meshlet sphere cannot be represented by finite float32 bounds.");
  }
  const cone = computeNormalCone(triangleNormals, hasDegenerateTriangle);
  return {
    sphere: [center[0]!, center[1]!, center[2]!, conservativeRadius],
    aabbMin: [min[0]!, min[1]!, min[2]!],
    aabbMax: [max[0]!, max[1]!, max[2]!],
    cone,
  };
}

/** Returns a unit face normal, or undefined for repeated/near-collinear triangles. */
export function triangleNormal(positions: Float32Array, a: number, b: number, c: number): Vec3 | undefined {
  const ao = a * 3, bo = b * 3, co = c * 3;
  const ab: Vec3 = [positions[bo]! - positions[ao]!, positions[bo + 1]! - positions[ao + 1]!, positions[bo + 2]! - positions[ao + 2]!];
  const ac: Vec3 = [positions[co]! - positions[ao]!, positions[co + 1]! - positions[ao + 1]!, positions[co + 2]! - positions[ao + 2]!];
  const cross: Vec3 = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const length = Math.hypot(...cross);
  const scale = Math.max(Math.hypot(...ab), Math.hypot(...ac));
  if (!Number.isFinite(length) || length <= scale * scale * 1e-12) return undefined;
  return [cross[0] / length, cross[1] / length, cross[2] / length];
}

function computeNormalCone(normals: readonly Vec3[], disabled: boolean): readonly [number, number, number, number] {
  if (disabled || normals.length === 0) return [0, 0, 1, -1];
  const sum = [0, 0, 0];
  for (const normal of normals) {
    sum[0] = sum[0]! + normal[0];
    sum[1] = sum[1]! + normal[1];
    sum[2] = sum[2]! + normal[2];
  }
  const length = Math.hypot(sum[0]!, sum[1]!, sum[2]!);
  if (length <= 1e-12) return [0, 0, 1, -1];
  const axis: Vec3 = [Math.fround(sum[0]! / length), Math.fround(sum[1]! / length), Math.fround(sum[2]! / length)];
  let cutoff = 1;
  for (const normal of normals) cutoff = Math.min(cutoff, axis[0] * normal[0] + axis[1] * normal[1] + axis[2] * normal[2]);
  if (cutoff <= 0) return [axis[0], axis[1], axis[2], -1];
  return [axis[0], axis[1], axis[2], previousFloat32(Math.min(1, cutoff))];
}

function nextFloat32(value: number): number {
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded) || rounded >= value) return rounded;
  return adjacentFloat32(rounded, 1);
}

function previousFloat32(value: number): number {
  const rounded = Math.fround(value);
  return adjacentFloat32(rounded, -1);
}

function adjacentFloat32(value: number, direction: -1 | 1): number {
  if (value === 0) return direction > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  ADJACENT_FLOATS[0] = value;
  ADJACENT_WORDS[0] = ADJACENT_WORDS[0]! + (value > 0 === direction > 0 ? 1 : -1);
  return ADJACENT_FLOATS[0]!;
}
