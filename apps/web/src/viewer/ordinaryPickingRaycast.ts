import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";

function triangleOrder(mesh: THREE.Mesh, hit: THREE.Intersection): number {
  if (!Array.isArray(mesh.material)) return 0;
  const offset = (hit.faceIndex ?? 0) * 3;
  return mesh.geometry.groups.findIndex((group) => group.materialIndex === hit.face?.materialIndex && offset >= group.start && offset < group.start + group.count);
}

export function indexedMeshHits(mesh: THREE.Mesh, bvh: MeshBVH, raycaster: THREE.Raycaster): THREE.Intersection[] {
  const inverse = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  const localRay = raycaster.ray.clone().applyMatrix4(inverse);
  // 在世界空间裁 near/far，保留非均匀缩放、镜像、父级组合造成剪切时的 Three 距离语义。
  const local = bvh.raycast(localRay, mesh.material, 0, Infinity);
  const hits: THREE.Intersection[] = [];
  for (const hit of local) {
    hit.point.applyMatrix4(mesh.matrixWorld);
    hit.distance = hit.point.distanceTo(raycaster.ray.origin);
    if (hit.distance >= raycaster.near && hit.distance <= raycaster.far) hits.push({ ...hit, object: mesh });
  }
  // BVH 的叶节点顺序不同；恢复 Three 的材质组/三角面遍历顺序，保证共边等距命中的 face 不变。
  hits.sort((a, b) => triangleOrder(mesh, a) - triangleOrder(mesh, b) || (a.faceIndex ?? 0) - (b.faceIndex ?? 0));
  return hits;
}
