import type { SpatialAabb, SpatialVec3 } from "../spatial/types.js";
import { transformSpatialAabb } from "../spatial/bounds.js";
import {
  SceneTransformGraphError,
  type SceneMatrix4,
  type SceneLocalTransform,
  type SceneNormalMatrix3,
} from "./types.js";

export const IDENTITY_SCENE_MATRIX: SceneMatrix4 = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

export function localTransformMatrix(transform: SceneLocalTransform): SceneMatrix4 {
  if (transform.kind === "matrix") return transform.matrix;
  const [x, y, z, w] = transform.rotation;
  const [sx, sy, sz] = transform.scale;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return freezeMatrix([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    transform.translation[0], transform.translation[1], transform.translation[2], 1,
  ]);
}

export function multiplySceneMatrices(left: SceneMatrix4, right: SceneMatrix4): SceneMatrix4 {
  const output = new Array<number>(16);
  for (let column = 0; column < 4; column += 1) {
    const offset = column * 4;
    for (let row = 0; row < 4; row += 1) {
      output[offset + row] = left[row]! * right[offset]!
        + left[4 + row]! * right[offset + 1]!
        + left[8 + row]! * right[offset + 2]!
        + left[12 + row]! * right[offset + 3]!;
    }
  }
  if (output.some((component) => !Number.isFinite(component))) {
    throw new SceneTransformGraphError("invalid-transform", "Scene matrix composition produced a non-finite component.");
  }
  return freezeMatrix(output);
}

export function invertAffineSceneMatrix(matrix: SceneMatrix4): SceneMatrix4 | null {
  const a00 = matrix[0], a01 = matrix[4], a02 = matrix[8];
  const a10 = matrix[1], a11 = matrix[5], a12 = matrix[9];
  const a20 = matrix[2], a21 = matrix[6], a22 = matrix[10];
  const c00 = a11 * a22 - a12 * a21;
  const c01 = a12 * a20 - a10 * a22;
  const c02 = a10 * a21 - a11 * a20;
  const c10 = a02 * a21 - a01 * a22;
  const c11 = a00 * a22 - a02 * a20;
  const c12 = a01 * a20 - a00 * a21;
  const c20 = a01 * a12 - a02 * a11;
  const c21 = a02 * a10 - a00 * a12;
  const c22 = a00 * a11 - a01 * a10;
  const determinant = a00 * c00 + a01 * c01 + a02 * c02;
  const conditioning = Math.hypot(a00, a10, a20) * Math.hypot(a01, a11, a21) * Math.hypot(a02, a12, a22);
  if (!Number.isFinite(conditioning) || !Number.isFinite(determinant)
    || !conditioning || Math.abs(determinant) / conditioning < 1e-10) return null;
  const inverseDeterminant = 1 / determinant;
  const i00 = c00 * inverseDeterminant, i01 = c10 * inverseDeterminant, i02 = c20 * inverseDeterminant;
  const i10 = c01 * inverseDeterminant, i11 = c11 * inverseDeterminant, i12 = c21 * inverseDeterminant;
  const i20 = c02 * inverseDeterminant, i21 = c12 * inverseDeterminant, i22 = c22 * inverseDeterminant;
  const tx = matrix[12], ty = matrix[13], tz = matrix[14];
  return freezeMatrix([
    i00, i10, i20, 0,
    i01, i11, i21, 0,
    i02, i12, i22, 0,
    -(i00 * tx + i01 * ty + i02 * tz),
    -(i10 * tx + i11 * ty + i12 * tz),
    -(i20 * tx + i21 * ty + i22 * tz),
    1,
  ]);
}

export function normalMatrixFromWorld(matrix: SceneMatrix4): SceneNormalMatrix3 | null {
  const inverse = invertAffineSceneMatrix(matrix);
  if (!inverse) return null;
  return freezeNormalMatrix([
    inverse[0], inverse[4], inverse[8],
    inverse[1], inverse[5], inverse[9],
    inverse[2], inverse[6], inverse[10],
  ]);
}

export function worldAabb(localBounds: SpatialAabb | null, world: SceneMatrix4): SpatialAabb | null {
  return localBounds === null ? null : transformSpatialAabb(localBounds, world);
}

export function translationMatrix(translation: SpatialVec3): SceneMatrix4 {
  return freezeMatrix([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    translation[0], translation[1], translation[2], 1,
  ]);
}

export function sameMatrix(left: SceneMatrix4, right: SceneMatrix4): boolean {
  return left.every((value, index) => value === right[index]);
}

function freezeMatrix(values: ArrayLike<number>): SceneMatrix4 {
  return Object.freeze(Array.from(values, canonicalNumber)) as unknown as SceneMatrix4;
}

function freezeNormalMatrix(values: ArrayLike<number>): SceneNormalMatrix3 {
  return Object.freeze(Array.from(values, canonicalNumber)) as unknown as SceneNormalMatrix3;
}

function canonicalNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
