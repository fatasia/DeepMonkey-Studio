import * as THREE from "three";
import { ThreeProjectionBridge } from "./ThreeProjectionBridge.js";

export function deformationBridge(): ThreeProjectionBridge {
  return new ThreeProjectionBridge({ capabilities: { authorDeformation: true }, hooks: {
    objectBeforeRender: THREE.Object3D.prototype.onBeforeRender, objectAfterRender: THREE.Object3D.prototype.onAfterRender,
    objectBeforeShadow: THREE.Object3D.prototype.onBeforeShadow, objectAfterShadow: THREE.Object3D.prototype.onAfterShadow,
    materialBeforeRender: THREE.Material.prototype.onBeforeRender, materialBeforeCompile: THREE.Material.prototype.onBeforeCompile,
    materialProgramCacheKey: THREE.Material.prototype.customProgramCacheKey,
  } });
}

export function morphMesh(): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  const geometry = new THREE.PlaneGeometry(2, 2);
  const values = new Float32Array(geometry.attributes.position!.count * 3);
  for (let i = 0; i < values.length / 3; i++) values[i * 3 + 2] = i + 1;
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = [new THREE.BufferAttribute(values, 3)];
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
}

export function skinMesh(geometry = morphMesh().geometry): THREE.SkinnedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  const count = geometry.attributes.position!.count;
  const weights = new Float32Array(count * 4), joints = new Uint16Array(count * 4);
  for (let i = 0; i < count; i++) { weights[i * 4] = 0.75; joints[i * 4] = i % 2; }
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(joints, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(weights, 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  const a = new THREE.Bone(), b = new THREE.Bone(); a.add(b); mesh.add(a);
  mesh.bind(new THREE.Skeleton([a, b]));
  return mesh;
}
