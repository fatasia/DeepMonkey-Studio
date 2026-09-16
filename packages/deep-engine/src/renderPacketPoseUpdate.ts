import type { DeformationPose, DeformationSnapshot, DeformationSource } from "./deformation/types.js";
import { DeformationPoseValidator } from "./deformation/poseValidation.js";

// Source-array identity survives pose-only snapshots, so hot updates share their cold validator.
const validators = new WeakMap<readonly DeformationSource[], DeformationPoseValidator>();

/** Prepared source ownership is stable; hot updates validate/copy only changing pose arrays. */
export function snapshotDeformationPoseUpdate(retained: DeformationSnapshot, poses: readonly DeformationPose[]): DeformationSnapshot {
  let validator = validators.get(retained.sources);
  if (!validator) { validator = new DeformationPoseValidator(retained); validators.set(retained.sources, validator); }
  validator.validate(poses);
  const previous = new Map(retained.poses.map(pose => [pose.id, pose]));
  const owned = poses.map(pose => {
    const old = previous.get(pose.id);
    if (old && pose.revision < old.revision) throw new Error("Stale deformation pose revision.");
    if (old && pose.revision === old.revision && !equalPose(old, pose)) throw new Error("Deformation pose changed without a revision.");
    return Object.freeze({ id: pose.id, source: pose.source, revision: pose.revision,
      ...(pose.morphWeights ? { morphWeights: Object.freeze({ revision: pose.morphWeights.revision, values: pose.morphWeights.values.slice() }) } : {}),
      ...(pose.palette ? { palette: Object.freeze({ revision: pose.palette.revision, matrices: pose.palette.matrices.slice(),
        ...(pose.palette.normalMatrices ? { normalMatrices: pose.palette.normalMatrices.slice() } : {}) }) } : {}),
    });
  });
  return Object.freeze({ sources: retained.sources, poses: Object.freeze(owned) });
}

function equalPose(a: DeformationPose, b: DeformationPose): boolean {
  return a.source === b.source && a.morphWeights?.revision === b.morphWeights?.revision && a.palette?.revision === b.palette?.revision
    && equal(a.morphWeights?.values, b.morphWeights?.values) && equal(a.palette?.matrices, b.palette?.matrices)
    && equal(a.palette?.normalMatrices, b.palette?.normalMatrices);
}
function equal(a: Float32Array | undefined, b: Float32Array | undefined): boolean {
  return a === b || Boolean(a && b && a.length === b.length && a.every((value, index) => value === b[index]));
}
