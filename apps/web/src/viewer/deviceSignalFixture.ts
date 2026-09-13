import * as THREE from "three";
import { applyViewerDeviceSignal } from "./viewerDeviceSignals";

/** CPU 回归/基准共享夹具；Canvas 只替代画布绘制，投影与 Three 变换使用真实实现。 */
export function deviceSignalCanvasDocument() {
  return { documentElement: { lang: "zh-CN" }, createElement: () => ({ width: 0, height: 0, getContext: () => ({ beginPath() {}, roundRect() {}, fill() {}, stroke() {}, fillText() {} }) }) };
}

export function createDeviceSignalFixture(count = 1) {
  const owner = {}, scene = new THREE.Scene(), parent = new THREE.Group(); scene.add(parent);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 2_000); camera.position.set(0, 10, 50); camera.lookAt(0, 0, 0);
  const entries: Array<{ id: string; target: THREE.Mesh; visual: THREE.Group; anchor: THREE.Vector3 }> = [];
  for (let index = 0; index < count; index += 1) {
    const target = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    target.position.set(index % 50 - 25, 0, Math.floor(index / 50)); parent.add(target);
    const id = `device-${index}`;
    applyViewerDeviceSignal(owner, { modelId: id, target, scene, container: {} as HTMLElement, value: "alarm",
      getEffects: () => ({ outline: false, glow: false, xray: false, scanline: false, heatmap: false, dissolve: 0, edgeLight: false, color: "#ff0000", intensity: 1 }), setEffects() {} });
    entries.push({ id, target, visual: scene.children.at(-1) as THREE.Group, anchor: new THREE.Vector3(0, 0.5, 0) });
  }
  return { owner, scene, parent, camera, entries };
}
