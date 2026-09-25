import * as THREE from "three";
import { ThreeProjectionBridge, type AuthorTransformResolver } from "./ThreeProjectionBridge.js";
import type { ProjectionResult } from "./types.js";

export function bridge(authorTransformResolver?: AuthorTransformResolver): ThreeProjectionBridge {
  return new ThreeProjectionBridge({ hooks: {
    objectBeforeRender: THREE.Object3D.prototype.onBeforeRender, objectAfterRender: THREE.Object3D.prototype.onAfterRender,
    objectBeforeShadow: THREE.Object3D.prototype.onBeforeShadow, objectAfterShadow: THREE.Object3D.prototype.onAfterShadow,
    materialBeforeRender: THREE.Material.prototype.onBeforeRender, materialBeforeCompile: THREE.Material.prototype.onBeforeCompile,
    materialProgramCacheKey: THREE.Material.prototype.customProgramCacheKey,
  }, ...(authorTransformResolver ? { authorTransformResolver } : {}) });
}
export function mesh(): THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial> {
  return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: "#ff8000", metalness: 0.2, roughness: 0.7 }));
}
export function accepted(result: ProjectionResult): Extract<ProjectionResult, { ok: true }> {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result;
}
export function project(target: ThreeProjectionBridge, root: THREE.Object3D, mask = 1) {
  root.updateWorldMatrix(true, true);
  return accepted(target.project(root, { cameraLayerMask: mask }));
}
