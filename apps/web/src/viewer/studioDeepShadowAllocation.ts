import * as THREE from "three";

/** Reserve the author's map even when global shadows are currently off. */
export function studioDeepShadowMapSize(scene: THREE.Scene, cameraLayerMask: number): number {
  let mapSize: number | undefined;
  scene.traverseVisible(object => {
    if (mapSize !== undefined || !(object instanceof THREE.DirectionalLight) || !object.castShadow
      || object.intensity <= 0 || (object.layers.mask & cameraLayerMask) === 0) return;
    const { x, y } = object.shadow.mapSize;
    // Invalid inactive author shadows are diagnosed when enabled, not while preparing a shadow-free view.
    if (x === y && Number.isSafeInteger(x) && x >= 64 && x <= 16384) mapSize = x;
  });
  return mapSize ?? 1024;
}
