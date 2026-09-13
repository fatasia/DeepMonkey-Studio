import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ConservativeOcclusion } from "./conservativeOcclusion";
import { installOcclusionDrawFilter } from "./occlusionDrawFilter";

function fixture() {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  const root = new THREE.Group();
  const wall = new THREE.Mesh(new THREE.BoxGeometry(8, 8, 1), new THREE.MeshStandardMaterial()); wall.position.z = -5;
  const hidden = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 16), new THREE.MeshStandardMaterial()); hidden.position.z = -10;
  root.add(wall, hidden);
  return { camera, root, wall, hidden, occlusion: new ConservativeOcclusion() };
}

describe("conservative static mesh occlusion", () => {
  it("rejects walls with a backface hole or omitted material groups", () => {
    const { camera, root, wall, hidden, occlusion } = fixture(); occlusion.setEnabled(true);
    const index = wall.geometry.index!;
    for (let i = 24; i < 30; i += 3) { const second = index.getX(i + 1); index.setX(i + 1, index.getX(i + 2)); index.setX(i + 2, second); }
    index.needsUpdate = true; root.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(.1, .2, 0), new THREE.Vector3(0, 0, -1));
    expect(ray.intersectObject(wall)).toHaveLength(0);
    occlusion.update(root, camera, false); expect(occlusion.culled.has(hidden)).toBe(false);
    const grouped = new THREE.Mesh(new THREE.BoxGeometry(8, 8, 1), Array.from({ length: 6 }, () => new THREE.MeshStandardMaterial()));
    grouped.position.copy(wall.position); grouped.geometry.groups = grouped.geometry.groups.filter(group => group.materialIndex !== 4);
    root.remove(wall); root.add(grouped); root.updateMatrixWorld(true);
    expect(ray.intersectObject(grouped)).toHaveLength(0);
    occlusion.invalidate(); occlusion.update(root, camera, false); expect(occlusion.culled.has(hidden)).toBe(false);
  });
  it("retains through-wall materials and invalidates the camera layer signature", () => {
    const { camera, root, wall, hidden, occlusion } = fixture(); occlusion.setEnabled(true);
    for (const patch of [{ depthTest: false }, { depthTest: true, depthFunc: THREE.AlwaysDepth }, { depthFunc: THREE.LessEqualDepth, polygonOffset: true }]) {
      Object.assign(hidden.material, patch); occlusion.invalidate(); occlusion.update(root, camera, false);
      expect(occlusion.culled.has(hidden)).toBe(false);
    }
    hidden.material.polygonOffset = false; wall.layers.set(1); hidden.layers.enable(1); camera.layers.enable(1);
    occlusion.invalidate(); occlusion.update(root, camera, false); expect(occlusion.culled.has(hidden)).toBe(true);
    camera.layers.disable(1); occlusion.update(root, camera, false); expect(occlusion.culled.has(hidden)).toBe(false);
  });
  it("recomputes the target bounds when its buffer is edited", () => {
    const { camera, root, hidden, occlusion } = fixture(); occlusion.setEnabled(true);
    occlusion.update(root, camera, false); expect(occlusion.culled.has(hidden)).toBe(true);
    const position = hidden.geometry.attributes.position!;
    for (let i = 0; i < position.count; i++) position.setX(i, position.getX(i) + 20);
    position.needsUpdate = true; occlusion.invalidate(); occlusion.update(root, camera, false);
    expect(occlusion.culled.has(hidden)).toBe(false);
    expect(hidden.geometry.boundingBox!.min.x).toBeGreaterThan(19);
  });
  it("defaults off, culls an enclosed target without changing visibility, picking or export", () => {
    const { camera, root, hidden, occlusion } = fixture();
    occlusion.update(root, camera, false); expect(occlusion.culled.size).toBe(0);
    occlusion.setEnabled(true); occlusion.update(root, camera, false);
    expect(occlusion.culled.has(hidden)).toBe(true); expect(hidden.visible).toBe(true);
    expect(new THREE.Raycaster(new THREE.Vector3(0.15, 0.17, 0), new THREE.Vector3(0, 0, -1)).intersectObject(hidden).length).toBeGreaterThan(0);
    expect(root.toJSON().object.children).toHaveLength(2);
    occlusion.setEnabled(false); expect(occlusion.culled.size).toBe(0);
  });
  it("keeps targets across edges, holes, transparency, selection, movement and animation", () => {
    const { camera, root, wall, hidden, occlusion } = fixture(); occlusion.setEnabled(true);
    for (const apply of [
      () => { hidden.position.x = 10; },
      () => { hidden.position.x = 0; wall.material.transparent = true; },
      () => { wall.material.transparent = false; wall.material.alphaHash = true; },
      () => { wall.material.alphaHash = false; wall.geometry = new THREE.BoxGeometry(8, 8, 1); wall.geometry.setDrawRange(0, 30); },
    ]) { apply(); occlusion.invalidate(); occlusion.update(root, camera, false); expect(occlusion.culled.size).toBe(0); }
    wall.geometry = new THREE.BoxGeometry(8, 8, 1); occlusion.invalidate();
    occlusion.update(root, camera, false, hidden); expect(occlusion.culled.size).toBe(0);
    occlusion.update(root, camera, false); expect(occlusion.culled.has(hidden)).toBe(true);
    occlusion.update(root, camera, true); expect(occlusion.culled.size).toBe(0);
    camera.position.x = 12; camera.lookAt(hidden.position); occlusion.update(root, camera, false);
    expect(occlusion.culled.size).toBe(0);
    occlusion.dispose(); expect(occlusion.diagnostics().bypassReason).toBe("disposed");
  });
  it("never skips shadow cameras and restores WebGL hooks on shutdown", () => {
    const draw = vi.fn();
    const renderer = Object.assign(Object.create(THREE.WebGLRenderer.prototype), { renderBufferDirect: draw }) as THREE.WebGLRenderer;
    const camera = new THREE.PerspectiveCamera(); const shadowCamera = new THREE.PerspectiveCamera();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const stop = installOcclusionDrawFilter(renderer, camera, new Set([mesh]));
    renderer.renderBufferDirect(camera, new THREE.Scene(), mesh.geometry, mesh.material, mesh, { start: 0, count: 36, materialIndex: 0 }); expect(draw).not.toHaveBeenCalled();
    renderer.renderBufferDirect(shadowCamera, new THREE.Scene(), mesh.geometry, mesh.material, mesh, { start: 0, count: 36, materialIndex: 0 }); expect(draw).toHaveBeenCalledTimes(1);
    stop(); expect(renderer.renderBufferDirect).toBe(draw);
  });
  it("chains and restores the WebGPU object hook without skipping shadow cameras", () => {
    const original = vi.fn(); let current = original;
    const renderer = { getRenderObjectFunction: () => current, setRenderObjectFunction: (next: typeof current) => { current = next; }, renderObject: vi.fn() };
    const camera = new THREE.PerspectiveCamera(); const mesh = new THREE.Mesh();
    const stop = installOcclusionDrawFilter(renderer as never, camera, new Set([mesh]));
    current(mesh, new THREE.Scene(), camera); expect(original).not.toHaveBeenCalled();
    current(mesh, new THREE.Scene(), new THREE.PerspectiveCamera()); expect(original).toHaveBeenCalledTimes(1);
    stop(); expect(current).toBe(original);
  });
});
