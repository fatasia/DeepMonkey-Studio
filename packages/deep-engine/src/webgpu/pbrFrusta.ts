import { lookAt, multiply, orthographic, perspective, type Vec3 } from "./cameraMath.js";
import type { Frustum } from "./gpuFrustumCulling.js";
import type { PbrCameraProjection } from "./pbrFrameUniforms.js";

export function cameraFrustum(eye: Vec3, target: Vec3, up: Vec3 | undefined,
  aspect: number, projection: PbrCameraProjection): Frustum {
  return matrixFrustum(multiply(perspective(projection.verticalFovRadians, aspect,
    projection.near, projection.far), lookAt(eye, target, up)));
}

export function shadowFrustum(extent: number): Frustum {
  return matrixFrustum(multiply(orthographic(extent * 1.5, 0.1, extent * 8),
    lookAt([extent * 1.6, extent * 2.8, extent * 1.2], [0, 0, 0])));
}

export function viewProjectionFrustum(matrix: Float32Array): Frustum { return matrixFrustum(matrix); }

function matrixFrustum(matrix: Float32Array): Frustum {
  const row = (index: number): [number, number, number, number] =>
    [matrix[index]!, matrix[4 + index]!, matrix[8 + index]!, matrix[12 + index]!];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const add = (a: readonly number[], b: readonly number[]) =>
    [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!, a[3]! + b[3]!] as const;
  const sub = (a: readonly number[], b: readonly number[]) =>
    [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!, a[3]! - b[3]!] as const;
  return { planes: [add(r3, r0), sub(r3, r0), add(r3, r1), sub(r3, r1), r2, sub(r3, r2)] };
}
