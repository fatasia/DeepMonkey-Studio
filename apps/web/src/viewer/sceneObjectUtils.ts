import * as THREE from "three";
import type { ModelTransform, Vector3Value } from "@bim-studio/contracts";
import type { BimSpaceRecord } from "./viewerTypes";

export function toValue(vector: THREE.Vector3 | THREE.Euler): Vector3Value {
  return { x: vector.x, y: vector.y, z: vector.z };
}

export function objectTransform(object: THREE.Object3D): ModelTransform {
  return {
    position: toValue(object.position),
    rotation: toValue(object.rotation),
    scale: toValue(object.scale)
  };
}

export function applyTransform(object: THREE.Object3D, transform: ModelTransform): void {
  object.position.set(transform.position.x, transform.position.y, transform.position.z);
  object.rotation.set(transform.rotation.x, transform.rotation.y, transform.rotation.z);
  object.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);
  object.updateMatrixWorld(true);
}

export function visibleObjectBox(root: THREE.Object3D, poseAware = false): THREE.Box3 {
  const box = new THREE.Box3();
  root.updateWorldMatrix(true, true);
  root.traverse((child) => {
    const renderable = child as THREE.Object3D & { geometry?: THREE.BufferGeometry };
    if (!renderable.geometry || !isEffectivelyVisible(child, root)) return;
    if (!renderable.geometry.boundingBox) renderable.geometry.computeBoundingBox();
    const childBox = (poseAware ? currentPoseBox(renderable) : renderable.geometry.boundingBox)?.clone();
    if (childBox) box.union(childBox.applyMatrix4(child.matrixWorld));
  });
  return box;
}

const posedBounds = new WeakMap<THREE.Object3D, { state: unknown[]; geometryState: unknown[]; box: THREE.Box3 }>();

/** Command-only bounds: the normal per-frame visible box keeps its cached geometry path. */
function currentPoseBox(object: THREE.Object3D & { geometry?: THREE.BufferGeometry }): THREE.Box3 | null | undefined {
  const mesh = object as THREE.Mesh, skin = object as THREE.SkinnedMesh, instances = object as THREE.InstancedMesh;
  const geometry = mesh.geometry;
  if (!skin.isSkinnedMesh && !instances.isInstancedMesh && !geometry.morphAttributes.position?.length) return geometry.boundingBox;
  const geometryState: unknown[] = [geometry, geometry.morphTargetsRelative];
  const attribute = (value: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined) => {
    const interleaved = value as THREE.InterleavedBufferAttribute | undefined;
    geometryState.push(value, interleaved?.isInterleavedBufferAttribute ? interleaved.data.version : (value as THREE.BufferAttribute | undefined)?.version);
  };
  attribute(geometry.getAttribute("position")); attribute(geometry.getAttribute("skinIndex")); attribute(geometry.getAttribute("skinWeight"));
  for (const target of geometry.morphAttributes.position ?? []) attribute(target);
  const state = [...geometryState, ...(mesh.morphTargetInfluences ?? [])];
  if (skin.isSkinnedMesh) {
    skin.updateMatrixWorld(true);
    state.push(skin.skeleton, skin.bindMode, ...skin.bindMatrix.elements, ...skin.bindMatrixInverse.elements);
    for (let joint = 0; joint < skin.skeleton.bones.length; joint++) {
      const bone = skin.skeleton.bones[joint]!;
      bone.updateWorldMatrix(true, false);
      state.push(bone, ...bone.matrixWorld.elements, ...skin.skeleton.boneInverses[joint]!.elements);
    }
  }
  if (instances.isInstancedMesh) state.push(instances.count, instances.instanceMatrix, instances.instanceMatrix.version,
    instances.morphTexture, instances.morphTexture?.version);
  const cached = posedBounds.get(object);
  const same = (left: readonly unknown[], right: readonly unknown[]) => left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  if (cached && same(cached.state, state)) return cached.box;
  let box: THREE.Box3;
  if (skin.isSkinnedMesh) {
    skin.computeBoundingBox(); box = skin.boundingBox!.clone();
    // The renderer's object sphere may still describe an earlier animation pose.
    skin.boundingSphere = box.getBoundingSphere(skin.boundingSphere ?? new THREE.Sphere());
  } else if (instances.isInstancedMesh) {
    if (!cached || !same(cached.geometryState, geometryState)) geometry.computeBoundingBox();
    instances.computeBoundingBox(); box = instances.boundingBox!.clone();
    instances.boundingSphere = box.getBoundingSphere(instances.boundingSphere ?? new THREE.Sphere());
  } else {
    box = new THREE.Box3(); const point = new THREE.Vector3(), positions = geometry.getAttribute("position");
    for (let index = 0; index < positions.count; index++) box.expandByPoint(mesh.getVertexPosition(index, point));
  }
  posedBounds.set(object, { state, geometryState, box });
  return box;
}

export function spaceVisualKey(space: Pick<BimSpaceRecord, "modelId" | "id">): string {
  return `${space.modelId}:${space.id}`;
}

export function normalizedSpaceBox(bounds: { min: Vector3Value; max: Vector3Value }): THREE.Box3 | undefined {
  const values = [bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z];
  if (!values.every(Number.isFinite)) return undefined;
  const box = new THREE.Box3(
    new THREE.Vector3(Math.min(bounds.min.x, bounds.max.x), Math.min(bounds.min.y, bounds.max.y), Math.min(bounds.min.z, bounds.max.z)),
    new THREE.Vector3(Math.max(bounds.min.x, bounds.max.x), Math.max(bounds.min.y, bounds.max.y), Math.max(bounds.min.z, bounds.max.z))
  );
  const size = box.getSize(new THREE.Vector3());
  if (size.lengthSq() < 1e-10) return undefined;
  // 极薄空间会导致选择框和定位不可见，只对接近零厚度的轴补最小可视尺寸。
  const padding = new THREE.Vector3(size.x < 0.02 ? 0.25 : 0, size.y < 0.02 ? 0.25 : 0, size.z < 0.02 ? 0.25 : 0);
  box.min.sub(padding);
  box.max.add(padding);
  return box;
}

export function isFiniteBox(box: THREE.Box3): boolean {
  return [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].every(Number.isFinite);
}

export function isAncestorOf(ancestor: THREE.Object3D, object: THREE.Object3D): boolean {
  let current = object.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

export function explosionTargets(root: THREE.Object3D): THREE.Object3D[] {
  const semantic: THREE.Object3D[] = [];
  root.traverse((object) => {
    if (object !== root && object.userData.NodeType === "Element" && objectVisibleMeshCount(object) > 0) semantic.push(object);
  });
  if (semantic.length > 1) return semantic;
  const meshes: THREE.Object3D[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.attributes.position && isEffectivelyVisible(mesh, root)) meshes.push(mesh);
  });
  return meshes;
}

export function objectVisibleMeshCount(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.attributes.position && isEffectivelyVisible(mesh, root)) count += 1;
  });
  return count;
}

export function sanitizeExportObject(object: THREE.Object3D): void {
  object.userData = {};
  for (const child of [...object.children]) {
    if (child.userData.layerDeleted || child.name.startsWith("helper:") || child.name.startsWith("measurement:")) {
      object.remove(child);
      continue;
    }
    sanitizeExportObject(child);
  }
}

/** 完整场景导出包含作者隐藏的业务对象，但始终排除已删除层与编辑辅助物。 */
export function prepareCompleteExportObject(object: THREE.Object3D): void {
  sanitizeExportObject(object);
  object.traverse((child) => { child.visible = true; });
}

export function objectMeshCount(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.attributes.position) count += 1;
  });
  return count;
}

function isEffectivelyVisible(object: THREE.Object3D, root: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible || current.userData.layerDeleted || current.userData.effectHelper) return false;
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}
