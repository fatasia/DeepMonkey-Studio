import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { updateAuthorLodSelection } from "./authorLodSelection";
import { presentViewerFrame } from "./viewerFramePresentation";
describe("author LOD update when WebGL drawing is skipped", () => {
  it("runs the real Three distance/zoom/hysteresis update before consumers and never draws WebGL", () => {
    const root = new THREE.Group(), lod = new THREE.LOD(), camera = new THREE.PerspectiveCamera(); root.add(lod);
    lod.addLevel(new THREE.Object3D(), 0); lod.addLevel(new THREE.Object3D(), 10, 0.2); camera.position.set(8,0,8);
    const draw = vi.fn(), read = vi.fn(() => expect(lod.getCurrentLevel()).toBe(1));
    presentViewerFrame({ authorBackend: "webgl", presentationBackend: "webgpu", xrActive: false, offscreenFrame: false,
      listeners: new Set([read]), drawAuthor: draw, updateAuthorMatrices: () => { root.updateMatrixWorld(); camera.updateMatrixWorld(); },
      updateAuthorLods: () => updateAuthorLodSelection(root, camera) });
    expect(draw).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledOnce();
    camera.position.set(0, 0, 9); camera.updateMatrixWorld(); updateAuthorLodSelection(root, camera);
    expect(lod.getCurrentLevel()).toBe(1);
    camera.position.z = 7; camera.updateMatrixWorld(); updateAuthorLodSelection(root, camera);
    expect(lod.getCurrentLevel()).toBe(0);
    camera.position.set(8, 0, 8); camera.updateMatrixWorld();
    camera.zoom = 2; updateAuthorLodSelection(root, camera); expect(lod.getCurrentLevel()).toBe(0);
    lod.autoUpdate = false; lod.levels.forEach(level => { level.object.visible = true; }); updateAuthorLodSelection(root, camera);
    expect(lod.levels.every(level => level.object.visible)).toBe(true);
  });
  it("does not update invisible or camera-layer-excluded LODs", () => {
    const lod = new THREE.LOD(), camera = new THREE.PerspectiveCamera(), update = vi.spyOn(lod, "update");
    lod.visible = false; updateAuthorLodSelection(lod, camera); lod.visible = true; lod.layers.set(2); updateAuthorLodSelection(lod, camera);
    expect(update).not.toHaveBeenCalled();
  });
});
