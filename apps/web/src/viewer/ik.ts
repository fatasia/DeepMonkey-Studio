import * as THREE from "three";

export interface IKSolveOptions {
  chainLength: number;
  iterations: number;
  tolerance?: number;
}

/** Lightweight CCD solver for imported GLTF/FBX skeletons. The target is in world space. */
export function solveBoneChainIK(effector: THREE.Bone, target: THREE.Vector3, options: IKSolveOptions): number {
  const chainLength = Math.max(1, Math.floor(options.chainLength));
  const iterations = Math.max(1, Math.min(64, Math.floor(options.iterations)));
  const tolerance = Math.max(1e-5, options.tolerance ?? 1e-3);
  const effectorPosition = new THREE.Vector3();
  const jointPosition = new THREE.Vector3();
  const toEffector = new THREE.Vector3();
  const toTarget = new THREE.Vector3();
  const worldRotation = new THREE.Quaternion();
  const parentWorldRotation = new THREE.Quaternion();
  const delta = new THREE.Quaternion();

  effector.updateWorldMatrix(true, false);
  for (let iteration = 0; iteration < iterations; iteration++) {
    if (effector.getWorldPosition(effectorPosition).distanceTo(target) <= tolerance) break;
    let joint: THREE.Object3D | null = effector.parent;
    let used = 0;
    while (joint && used < chainLength) {
      if (!(joint instanceof THREE.Bone)) {
        joint = joint.parent;
        continue;
      }
      joint.getWorldPosition(jointPosition);
      effector.getWorldPosition(effectorPosition);
      toEffector.subVectors(effectorPosition, jointPosition);
      toTarget.subVectors(target, jointPosition);
      if (toEffector.lengthSq() > 1e-10 && toTarget.lengthSq() > 1e-10) {
        toEffector.normalize();
        toTarget.normalize();
        delta.setFromUnitVectors(toEffector, toTarget);
        joint.getWorldQuaternion(worldRotation);
        worldRotation.premultiply(delta);
        if (joint.parent) joint.parent.getWorldQuaternion(parentWorldRotation).invert();
        else parentWorldRotation.identity();
        joint.quaternion.copy(parentWorldRotation.multiply(worldRotation)).normalize();
        joint.updateWorldMatrix(true, true);
      }
      used++;
      joint = joint.parent;
    }
  }
  return effector.getWorldPosition(effectorPosition).distanceTo(target);
}
