import { expect, it } from "vitest";
import type { DeformationSnapshot } from "./types.js";
import { DeformationPoseValidator } from "./poseValidation.js";

function fixture(): DeformationSnapshot {
  return { sources: [{ id: "source", geometry: "g", revision: 0, kind: "morph", semantics: "three-r185",
    morph: { revision: 0, positions: new Float32Array([1, 0, 0]),
      primitive: { id: "m", sourceMeshIndex: 0, sourcePrimitiveIndex: 0, vertexCount: 1,
        targets: [{ index: 0, name: "move", positionDeltas: new Float32Array([1, 0, 0]) }] } } }],
    poses: [{ id: "p", source: "source", revision: 0, morphWeights: { revision: 0, values: new Float32Array([0]) } }] };
}

it("uses cached static limits while validating only new dynamic arrays", () => {
  const snapshot = fixture(), validator = new DeformationPoseValidator(snapshot);
  // No retained dependency on mutable caller geometry: preparation owns the static validation profile.
  snapshot.sources[0]!.morph!.positions.fill(NaN);
  expect(() => validator.validate([{ ...snapshot.poses[0]!, revision: 1,
    morphWeights: { revision: 1, values: new Float32Array([-2]) } }])).not.toThrow();
  expect(() => validator.validate([{ ...snapshot.poses[0]!,
    morphWeights: { revision: 1, values: new Float32Array([NaN]) } }])).toThrow();
});

it("requires exact prepared identities and rejects partial, duplicate, or extra data", () => {
  const snapshot = fixture(), validator = new DeformationPoseValidator(snapshot), pose = snapshot.poses[0]!;
  for (const poses of [[], [pose, pose], [{ ...pose, id: "other" }], [{ ...pose, source: "other" }],
    [{ ...pose, revision: -1 }], [{ ...pose, morphWeights: undefined }], [{ ...pose, surprise: 1 }]]) {
    expect(() => validator.validate(poses)).toThrow();
  }
});

it("keeps joint count fixed and validates dynamic normal matrices", () => {
  const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const snapshot: DeformationSnapshot = { sources: [{ id: "s", geometry: "g", revision: 0, kind: "skin", semantics: "three-r185",
    skinning: { revision: 0, positions: new Float32Array([0, 0, 0]), normals: new Float32Array([0, 1, 0]),
      joints: new Uint16Array(4), weights: new Float32Array([1, 0, 0, 0]) } }],
    poses: [{ id: "p", source: "s", revision: 0, palette: { revision: 0, matrices: matrix } }] };
  const validator = new DeformationPoseValidator(snapshot), pose = snapshot.poses[0]!;
  expect(() => validator.validate([{ ...pose, palette: { revision: 1, matrices: new Float32Array([...matrix, ...matrix]) } }])).toThrow("joint count");
  expect(() => validator.validate([{ ...pose, palette: { revision: 1, matrices: matrix, normalMatrices: new Float32Array(12).fill(NaN) } }])).toThrow();
  expect(() => validator.validate([{ ...pose, revision: 1, palette: { revision: 1, matrices: matrix } }])).not.toThrow();
});
