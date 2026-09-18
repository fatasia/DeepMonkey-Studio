import type * as THREE from "three";

/** Candidate capture has no animation tick; it only derives render state from the current author pose. */
export function updateAuthorProjectionState(root: THREE.Object3D, camera: THREE.Camera, signal: AbortSignal): void {
  signal.throwIfAborted();
  root.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  updateAuthorLodSelection(root, camera);
}

/** Replaces only the LOD.update work normally performed by the skipped author renderer. */
export function updateAuthorLodSelection(root: THREE.Object3D, camera: THREE.Camera): void {
  if (!root.visible) return;
  const lod = root as THREE.LOD;
  if (lod.isLOD && lod.autoUpdate && root.layers.test(camera.layers)) lod.update(camera);
  for (const child of root.children) updateAuthorLodSelection(child, camera);
}
