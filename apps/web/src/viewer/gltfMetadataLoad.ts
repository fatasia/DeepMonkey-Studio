import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

/** 并行读取的任一分支失败，已经取得所有权的几何也必须归还。 */
export async function loadGltfWithMetadata<T>(
  loadGeometry: () => Promise<GLTF>, loadMetadata: () => Promise<T | undefined>, dispose: (scene: GLTF["scene"]) => void,
): Promise<[GLTF, T | undefined]> {
  const [geometry, metadata] = await Promise.allSettled([Promise.resolve().then(loadGeometry), Promise.resolve().then(loadMetadata)]);
  if (geometry.status === "rejected") throw geometry.reason;
  if (metadata.status === "rejected") { dispose(geometry.value.scene); throw metadata.reason; }
  return [geometry.value, metadata.value];
}
