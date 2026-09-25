import type * as THREE from "three";

/** Candidate capture has no animation tick; it only derives render state from the current author pose. */
export function updateAuthorProjectionState(root: THREE.Object3D, camera: THREE.Camera, signal: AbortSignal): void {
  signal.throwIfAborted();
  root.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  updateAuthorLodSelection(root, camera);
}

/**
 * 每帧 Deep-WebGPU 路径的 LOD 重选(presentViewerFrame 合同)。LOD.update 的
 * 结果只依赖相机投影参数与层级结构:同参数+同树版本时全树递归是纯冗余,
 * 以 WeakMap 缓存摘除。树版本取 Three Object3D 的自增 version(子节点增删、
 * 可见性变化都会提升它);相机平移不改 LOD 选择结果(LOD 以距离=|Δ|判定,
 * 与相机到 LOD 的相对位置有关——平移会变,计入位置)。
 */
interface LodCacheKey {
  x: number; y: number; z: number; zoom: number; fov: number; version: number;
}

const lodCache = new WeakMap<THREE.Object3D, LodCacheKey>();

function lodCacheKey(root: THREE.Object3D, camera: THREE.PerspectiveCamera): LodCacheKey {
  return { x: camera.position.x, y: camera.position.y, z: camera.position.z,
    zoom: camera.zoom, fov: (camera as THREE.PerspectiveCamera).fov, version: (root as { version?: number }).version ?? -1 };
}

function sameKey(a: LodCacheKey, b: LodCacheKey): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.zoom === b.zoom && a.fov === b.fov && a.version === b.version;
}

export function updateAuthorLodSelection(root: THREE.Object3D, camera: THREE.Camera): void {
  // PerspectiveCamera 专属字段(fov/zoom)存在才走缓存键;类型导入不可用于 instanceof。
  const perspective = (camera as { fov?: number; zoom?: number; position: THREE.Vector3 }).fov !== undefined
    && (camera as { zoom?: number }).zoom !== undefined;
  if (!perspective) {
    updateLodRecursive(root, camera);
    return;
  }
  const key = lodCacheKey(root, camera as THREE.PerspectiveCamera);
  const cached = lodCache.get(root);
  if (cached && sameKey(cached, key)) return;
  lodCache.set(root, key);
  updateLodRecursive(root, camera);
}

function updateLodRecursive(root: THREE.Object3D, camera: THREE.Camera): void {
  if (!root.visible) return;
  const lod = root as THREE.LOD;
  if (lod.isLOD && lod.autoUpdate && root.layers.test(camera.layers)) lod.update(camera);
  for (const child of root.children) updateLodRecursive(child, camera);
}
