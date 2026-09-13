import * as THREE from "three";
import type { RendererInstance } from "./viewerRendererTypes";

/** 阴影相机仍绘制所有投影体，避免“省下模型后阴影也消失”。 */
export function installOcclusionDrawFilter(renderer: RendererInstance, camera: THREE.Camera, culled: ReadonlySet<THREE.Object3D>): () => void {
  if (renderer instanceof THREE.WebGLRenderer) {
    const original = renderer.renderBufferDirect;
    const filtered: typeof original = function (passCamera, scene, geometry, material, object, group) {
      if (passCamera === camera && culled.has(object)) return;
      original.call(renderer, passCamera, scene, geometry, material, object, group);
    };
    renderer.renderBufferDirect = filtered;
    return () => { if (renderer.renderBufferDirect === filtered) renderer.renderBufferDirect = original; };
  }
  const original = renderer.getRenderObjectFunction();
  const filtered: NonNullable<typeof original> = (...args) => {
    if (args[2] === camera && culled.has(args[0])) return;
    if (original) original(...args); else renderer.renderObject(...args);
  };
  renderer.setRenderObjectFunction(filtered);
  return () => { if (renderer.getRenderObjectFunction() === filtered) renderer.setRenderObjectFunction(original); };
}
