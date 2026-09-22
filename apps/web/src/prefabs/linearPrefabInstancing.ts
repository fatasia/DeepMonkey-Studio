import * as THREE from "three";

const MIN_BATCH_SIZE = 4;

/** Collapses repeated generated parts into one draw while retaining the editable path as source state. */
export function instanceRepeatedPathMeshes(root: THREE.Group): void {
  root.updateMatrixWorld(true);
  const groups = new Map<string, THREE.Mesh[]>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh
      || Array.isArray(object.material) || object.material.transparent || !object.material.visible) return;
    const key = `${geometryFingerprint(object.geometry)}:${object.material.uuid}:${Number(object.castShadow)}:${Number(object.receiveShadow)}`;
    const matches = groups.get(key);
    if (matches) matches.push(object); else groups.set(key, [object]);
  });
  const inverseRoot = root.matrixWorld.clone().invert();
  for (const sources of groups.values()) {
    if (sources.length < MIN_BATCH_SIZE) continue;
    const first = sources[0]!;
    const batch = new THREE.InstancedMesh(first.geometry, first.material, sources.length);
    batch.name = `实例批次:${first.name}`;
    batch.castShadow = first.castShadow;
    batch.receiveShadow = first.receiveShadow;
    batch.userData.pathInstanceCount = sources.length;
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index]!;
      batch.setMatrixAt(index, inverseRoot.clone().multiply(source.matrixWorld));
      source.removeFromParent();
      if (source.geometry !== first.geometry) source.geometry.dispose();
    }
    batch.instanceMatrix.needsUpdate = true;
    batch.computeBoundingBox();
    batch.computeBoundingSphere();
    root.add(batch);
  }
}

function geometryFingerprint(geometry: THREE.BufferGeometry): string {
  let hash = 2166136261;
  const scratch = new DataView(new ArrayBuffer(4));
  const feed = (array: ArrayLike<number>) => {
    for (let index = 0; index < array.length; index++) {
      scratch.setFloat32(0, array[index]!, true);
      const bits = scratch.getUint32(0, true);
      hash = Math.imul(hash ^ bits, 16777619);
    }
  };
  const position = geometry.getAttribute("position"), normal = geometry.getAttribute("normal"), uv = geometry.getAttribute("uv");
  feed(position.array); if (normal) feed(normal.array); if (uv) feed(uv.array); if (geometry.index) feed(geometry.index.array);
  return `${geometry.type}:${position.count}:${geometry.index?.count ?? 0}:${hash >>> 0}`;
}
