import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import * as projection from "./studioDeepEditorOverlay";
import { StudioDeepEditorOverlaySession } from "./StudioDeepEditorOverlaySession";

afterEach(() => vi.restoreAllMocks());
const fixture = () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.z = 3; camera.updateMatrixWorld(true);
  const root = new THREE.Group();
  const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)]),
  new THREE.LineBasicMaterial({ color: 0x2684ff, toneMapped: false, depthTest: false }));
  root.add(line); root.updateMatrixWorld(true);
  const session = new StudioDeepEditorOverlaySession();
  return { camera, root, line, session, read: () => session.read([root], camera, 128, 128, 1) };
};

describe("unchanged author editor overlay reuse", () => {
  it("does not project or clip again while exact author inputs remain unchanged", () => {
    const spy = vi.spyOn(projection, "projectStudioEditorOverlay"), f = fixture();
    const first = f.read();
    for (let index = 0; index < 100; index++) expect(f.read()).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1);
    f.session.dispose(); f.read(); expect(spy).toHaveBeenCalledTimes(2);
  });

  it("reprojects camera, projection/viewport and animated object matrices", () => {
    const f = fixture(), first = f.read();
    f.camera.position.x = 0.5; f.camera.updateMatrixWorld(true);
    const cameraChanged = f.read(); expect(cameraChanged.revision).toBeGreaterThan(first.revision);
    f.camera.fov = 45; f.camera.updateProjectionMatrix();
    const lensChanged = f.read(); expect(lensChanged.revision).toBeGreaterThan(cameraChanged.revision);
    f.line.position.y = 0.3; f.root.updateMatrixWorld(true);
    const moved = f.read(); expect(moved.revision).toBeGreaterThan(lensChanged.revision);
    const resized = f.session.read([f.root], f.camera, 256, 128, 2);
    expect(resized.revision).toBeGreaterThan(moved.revision);
  });

  it("tracks direct geometry/color writes, draw range and parent visibility without needsUpdate", () => {
    const f = fixture(); let previous = f.read();
    f.line.geometry.getAttribute("position").setY(0, 0.2);
    let next = f.read(); expect(next.revision).toBeGreaterThan(previous.revision); previous = next;
    f.line.material.color.setRGB(1, 0, 0);
    next = f.read(); expect(next.revision).toBeGreaterThan(previous.revision); previous = next;
    f.line.geometry.setDrawRange(0, 0);
    next = f.read(); expect(next.vertices).toHaveLength(0);
    f.line.geometry.setDrawRange(0, Infinity); f.read();
    f.root.visible = false; expect(f.read().vertices).toHaveLength(0);
    f.root.visible = true; expect(f.read().vertices.length).toBeGreaterThan(0);
    f.camera.layers.set(2); expect(f.read().vertices).toHaveLength(0);
  });

  it("does not hide invalid mutations behind the cached successful frame", () => {
    const f = fixture(); f.read();
    f.line.geometry.getAttribute("position").setX(0, NaN);
    expect(() => f.read()).toThrow("finite");
    f.line.geometry.getAttribute("position").setX(0, -1);
    f.read(); f.line.material.toneMapped = true;
    expect(() => f.read()).toThrow("material");
  });

  it("tracks hierarchy order, dashed distances and direct primitive writes", () => {
    const f = fixture();
    f.line.material = new THREE.LineDashedMaterial({ toneMapped: false, depthTest: false,
      dashSize: 0.3, gapSize: 0.2 }); f.line.computeLineDistances();
    const first = f.read();
    f.line.geometry.getAttribute("lineDistance").setX(1, 1.5);
    expect(f.read().revision).toBeGreaterThan(first.revision);
    const vertices = new Float32Array(24); vertices[3] = 1; vertices[11] = 1; vertices[19] = 1;
    const initial = f.session.read([], f.camera, 128, 128, 1, [vertices]);
    vertices[0] = 0.1;
    expect(f.session.read([], f.camera, 128, 128, 1, [vertices]).revision).toBeGreaterThan(initial.revision);
    f.root.remove(f.line); expect(f.read().vertices).toHaveLength(0);
  });
});
