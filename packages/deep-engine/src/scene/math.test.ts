import { describe, expect, it } from "vitest";
import {
  invertAffineSceneMatrix,
  localTransformMatrix,
  multiplySceneMatrices,
  normalMatrixFromWorld,
  worldAabb,
} from "./math.js";
import type { SceneMatrix4 } from "./types.js";

describe("scene transform math", () => {
  it("builds normalized quaternion TRS matrices with mirrored non-uniform scale", () => {
    const matrix = localTransformMatrix({
      kind: "trs",
      translation: [10, 20, 30],
      rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
      scale: [-2, 3, 4],
    });
    expect(matrix).toEqual([
      expect.closeTo(0), expect.closeTo(-2), expect.closeTo(0), 0,
      expect.closeTo(-3), expect.closeTo(0), expect.closeTo(0), 0,
      expect.closeTo(0), expect.closeTo(0), expect.closeTo(4), 0,
      10, 20, 30, 1,
    ]);
    expect(worldAabb({ min: [-1, -2, -3], max: [1, 2, 3] }, matrix)).toEqual({
      min: [expect.closeTo(4), expect.closeTo(18), expect.closeTo(18)],
      max: [expect.closeTo(16), expect.closeTo(22), expect.closeTo(42)],
    });
    expect(normalMatrixFromWorld(matrix)).not.toBeNull();
  });

  it("inverts affine matrices and rejects singular or numerically collapsed bases", () => {
    const matrix: SceneMatrix4 = [
      2, 0, 0, 0,
      1, 3, 0, 0,
      0, 1, 4, 0,
      5, 6, 7, 1,
    ];
    const inverse = invertAffineSceneMatrix(matrix)!;
    expect(multiplySceneMatrices(matrix, inverse)).toEqual(expectIdentityClose());
    expect(invertAffineSceneMatrix([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toBeNull();
    expect(invertAffineSceneMatrix([1e-15, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).not.toBeNull();
  });

  it("uses inverse-transpose normals for shear", () => {
    const shear: SceneMatrix4 = [
      1, 0, 0, 0,
      2, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ];
    const normal = normalMatrixFromWorld(shear)!;
    const tangent = transformDirection(shear, [0, 1, 0]);
    const transformedNormal = transformNormal(normal, [1, 0, 0]);
    expect(dot(tangent, transformedNormal)).toBeCloseTo(0, 12);
    expect(worldAabb({ min: [-1, -1, -1], max: [1, 1, 1] }, shear)).toEqual({
      min: [-3, -1, -1],
      max: [3, 1, 1],
    });
  });
});

function transformDirection(matrix: SceneMatrix4, vector: readonly [number, number, number]) {
  return [
    matrix[0] * vector[0] + matrix[4] * vector[1] + matrix[8] * vector[2],
    matrix[1] * vector[0] + matrix[5] * vector[1] + matrix[9] * vector[2],
    matrix[2] * vector[0] + matrix[6] * vector[1] + matrix[10] * vector[2],
  ];
}

function transformNormal(matrix: readonly number[], vector: readonly [number, number, number]) {
  return [
    matrix[0]! * vector[0] + matrix[3]! * vector[1] + matrix[6]! * vector[2],
    matrix[1]! * vector[0] + matrix[4]! * vector[1] + matrix[7]! * vector[2],
    matrix[2]! * vector[0] + matrix[5]! * vector[1] + matrix[8]! * vector[2],
  ];
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]!;
}

function expectIdentityClose() {
  return [
    expect.closeTo(1), expect.closeTo(0), expect.closeTo(0), expect.closeTo(0),
    expect.closeTo(0), expect.closeTo(1), expect.closeTo(0), expect.closeTo(0),
    expect.closeTo(0), expect.closeTo(0), expect.closeTo(1), expect.closeTo(0),
    expect.closeTo(0), expect.closeTo(0), expect.closeTo(0), expect.closeTo(1),
  ];
}
