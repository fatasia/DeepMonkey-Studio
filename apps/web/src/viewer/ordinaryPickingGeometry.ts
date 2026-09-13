import * as THREE from "three";
import type { SerializedBVH } from "three-mesh-bvh";

export type PickingSnapshot = {
  position: Float32Array | Float64Array;
  index: Uint16Array | Uint32Array | null;
  start: number;
  count: number;
};
export type PickingBuilder = {
  build(snapshot: PickingSnapshot, signal: AbortSignal): Promise<SerializedBVH>;
  dispose(): void;
};
export type GeometryStamp = ReturnType<typeof geometryStamp>;

export function geometryStamp(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = geometry.index;
  return {
    position, positionArray: position.array, positionVersion: position.version, positionCount: position.count,
    index, indexArray: index?.array, indexVersion: index?.version, indexCount: index?.count,
    start: geometry.drawRange.start, count: geometry.drawRange.count,
    groups: geometry.groups.map(({ start, count, materialIndex }) => `${start}:${count}:${materialIndex}`).join("|"),
  };
}

export function stampMatches(geometry: THREE.BufferGeometry, previous: GeometryStamp): boolean {
  if (!geometry.getAttribute("position")) return false;
  const current = geometryStamp(geometry);
  return (Object.keys(current) as Array<keyof GeometryStamp>).every((key) => current[key] === previous[key]);
}

export function eligiblePickingMesh(object: THREE.Object3D, minTriangles: number, maxSnapshotBytes: number): object is THREE.Mesh {
  const mesh = object as THREE.Mesh;
  if (!mesh.isMesh || mesh.raycast !== THREE.Mesh.prototype.raycast || mesh.getVertexPosition !== THREE.Mesh.prototype.getVertexPosition) return false;
  if (!mesh.material || Object.keys(mesh.geometry.morphAttributes).length) return false;
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  const index = geometry.index;
  if (!(position instanceof THREE.BufferAttribute) || position.itemSize !== 3 || position.normalized || position.usage !== THREE.StaticDrawUsage) return false;
  if (!(position.array instanceof Float32Array || position.array instanceof Float64Array)) return false;
  if (index && (index.itemSize !== 1 || index.normalized || index.usage !== THREE.StaticDrawUsage || !(index.array instanceof Uint16Array || index.array instanceof Uint32Array))) return false;
  const total = index?.count ?? position.count;
  const { start, count } = geometry.drawRange;
  if (start < 0 || start % 3 || (Number.isFinite(count) && (count < 0 || count % 3))) return false;
  if (Math.min(total - start, count) < minTriangles * 3 || total % 3) return false;
  if (position.array.byteLength + (index?.array.byteLength ?? 0) > maxSnapshotBytes) return false;
  return geometry.groups.every((group) => group.start >= 0 && group.start % 3 === 0 && group.count >= 0 && group.count % 3 === 0
    && (!Array.isArray(mesh.material) || Boolean(mesh.material[group.materialIndex ?? 0])));
}

export function abortPicking(): never { throw new DOMException("Picking index cancelled", "AbortError"); }

export function pickingIdle(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Picking index cancelled", "AbortError")); return; }
    const idle = typeof requestIdleCallback === "function";
    let handle: number | ReturnType<typeof setTimeout>;
    const cancel = () => {
      if (idle) cancelIdleCallback(handle as number); else clearTimeout(handle);
      reject(new DOMException("Picking index cancelled", "AbortError"));
    };
    const complete = () => { signal.removeEventListener("abort", cancel); resolve(); };
    signal.addEventListener("abort", cancel, { once: true });
    handle = idle ? requestIdleCallback(complete, { timeout: 1000 }) : setTimeout(complete, 0);
  });
}

// 只复制快照，绝不 transfer 正在渲染的几何；分段复制把大数组工作让出给输入与绘制。
export async function copyPickingSnapshot(geometry: THREE.BufferGeometry, stamp: GeometryStamp, signal: AbortSignal): Promise<PickingSnapshot> {
  const check = () => { if (signal.aborted || !stampMatches(geometry, stamp)) abortPicking(); };
  const copy = async <T extends Float32Array | Float64Array | Uint16Array | Uint32Array>(source: T): Promise<T> => {
    check();
    const result = new (source.constructor as { new(length: number): T })(source.length);
    const chunk = 262144 / source.BYTES_PER_ELEMENT;
    for (let offset = 0; offset < source.length; offset += chunk) {
      await pickingIdle(signal); check();
      result.set(source.subarray(offset, offset + chunk), offset);
    }
    return result;
  };
  const position = await copy(stamp.positionArray as PickingSnapshot["position"]);
  const index = stamp.indexArray ? await copy(stamp.indexArray as NonNullable<PickingSnapshot["index"]>) : null;
  check();
  return { position, index, start: stamp.start, count: stamp.count };
}
