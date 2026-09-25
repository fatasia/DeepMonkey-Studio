import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { projectStudioEditorOverlay } from "./studioDeepEditorOverlay";
import { StudioDeepEditorOverlaySession } from "./StudioDeepEditorOverlaySession";
import { clipOverlayLine, clipOverlayTriangle, overlayLine } from "./studioDeepOverlayGeometry";

const camera = () => { const value = new THREE.PerspectiveCamera(60, 1, 0.1, 100); value.position.z = 3; value.updateMatrixWorld(true); return value; };
const line = () => new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)]),
  new THREE.LineBasicMaterial({ color: 0x2684ff, toneMapped: false, depthTest: false, transparent: true, opacity: 0.75 }));

describe("author editor overlay projection", () => {
  it("preserves triangle sidedness including mirrored transforms and rejects tone mapped materials", () => {
    const material = new THREE.MeshBasicMaterial({ depthTest: false, toneMapped: false });
    const object = new THREE.Mesh(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), 3)), material);
    const view = camera(); object.updateMatrixWorld(true);
    expect(projectStudioEditorOverlay([object], view, 128, 128, 1)).toHaveLength(24);
    material.side = THREE.BackSide; expect(projectStudioEditorOverlay([object], view, 128, 128, 1)).toHaveLength(0);
    material.side = THREE.FrontSide; object.scale.x = -1; object.updateMatrixWorld(true);
    expect(projectStudioEditorOverlay([object], view, 128, 128, 1)).toHaveLength(24);
    material.toneMapped = true; expect(() => projectStudioEditorOverlay([object], view, 128, 128, 1)).toThrow("material");
  });
  it("rejects invalid ranges, indices and oversized source before projecting", () => {
    const object = line(), view = camera();
    object.geometry.setDrawRange(NaN, 2);
    expect(() => projectStudioEditorOverlay([object], view, 128, 128, 1)).toThrow("range");
    object.geometry.setDrawRange(0, Infinity); object.geometry.setIndex([0, 99]);
    expect(() => projectStudioEditorOverlay([object], view, 128, 128, 1)).toThrow("index");
    object.geometry.setIndex(null); object.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(196_609 * 3), 3));
    expect(() => projectStudioEditorOverlay([object], view, 128, 128, 1)).toThrow("budget");
  });
  it("clips crossing near/side planes and excludes fully behind-camera segments", () => {
    expect(clipOverlayLine([0, 0, -2, 1], [0.5, 0, 0, 1])![0][2]).toBe(-1);
    expect(clipOverlayLine([-2, 0, 0, 1], [0, 0, 0, 1])![0][0]).toBe(-1);
    expect(clipOverlayLine([0, 0, 0, -1], [0.5, 0, 0, -1])).toBeUndefined();
    const vertices: number[] = []; overlayLine(vertices, [0, 0, -2, 1], [0.5, 0, 0, 1], [1, 0, 0, 1], 128, 128, 1);
    expect(vertices.length).toBeGreaterThan(0); expect(vertices.every(Number.isFinite)).toBe(true);
    const triangle = clipOverlayTriangle([[0, 0.5, -2, 1], [-0.5, -0.5, 0, 1], [0.5, -0.5, 0, 1]]);
    expect(triangle).toHaveLength(4);
    expect(triangle.every(point => point[2] >= -point[3])).toBe(true);
    expect(clipOverlayTriangle([[0, 0, 0, -1], [0, 0.5, 0, -1], [0.5, 0, 0, -1]])).toHaveLength(0);
  });
  it("preserves CSS line width across DPR and adds transparent coverage edges", () => {
    const extent = (ratio: number) => { const values: number[] = [];
      overlayLine(values, [-0.5, 0, 0, 1], [0.5, 0, 0, 1], [1, 0, 0, 1], 100 * ratio, 100 * ratio, 2 * ratio);
      const y = values.filter((_, index) => index % 8 === 1); return (Math.max(...y) - Math.min(...y)) * 50 * ratio; };
    expect(extent(1)).toBeCloseTo(3); expect(extent(2)).toBeCloseTo(5);
  });
  it("follows parent visibility and camera layers without changing author state", () => {
    const object = line(), parent = new THREE.Group(), view = camera(); parent.add(object); parent.updateMatrixWorld(true);
    const material = object.material as THREE.LineBasicMaterial;
    expect(projectStudioEditorOverlay([parent], view, 128, 128, 1).length).toBeGreaterThan(0);
    parent.visible = false; expect(projectStudioEditorOverlay([object], view, 128, 128, 1)).toHaveLength(0);
    parent.visible = true; object.layers.set(2); expect(projectStudioEditorOverlay([parent], view, 128, 128, 1)).toHaveLength(0);
    view.layers.enable(2); const output = projectStudioEditorOverlay([parent], view, 128, 128, 1);
    expect(output[12]).toBeCloseTo(0x26 / 255); expect(output[15]).toBe(0);
    expect(material.opacity).toBe(0.75); expect(object.parent).toBe(parent);
  });
  it("excludes depth-tested grid and hidden transform pickers", () => {
    const grid = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
    const picker = line(); picker.visible = false;
    expect(projectStudioEditorOverlay([grid, picker], camera(), 128, 128, 1)).toHaveLength(0);
  });
  it("changes independent snapshot revisions only when projected content changes", () => {
    const session = new StudioDeepEditorOverlaySession(), object = line(), view = camera(); object.updateMatrixWorld(true);
    const a = session.read([object], view, 128, 128, 1); expect(session.read([object], view, 128, 128, 1)).toBe(a);
    object.position.x = 0.2; object.updateMatrixWorld(true);
    const b = session.read([object], view, 128, 128, 1); expect(b.revision).toBe(a.revision + 1);
    expect(a.vertices[0]).not.toBe(b.vertices[0]); session.dispose();
    expect(session.read([object], view, 128, 128, 1).revision).toBeGreaterThan(b.revision);
  });
  it("merges deep native primitives into the snapshot and reuses revisions for identical content", () => {
    const session = new StudioDeepEditorOverlaySession(), view = camera();
    const primitive = new Float32Array(8);
    const merged = session.read([], view, 128, 128, 1, [primitive]);
    expect(merged.vertices.length).toBe(8);
    expect(session.read([], view, 128, 128, 1, [primitive])).toBe(merged);
    expect(session.read([], view, 128, 128, 1).vertices.length).toBe(0);
    session.dispose();
    // dispose 清空缓存后重建修订(计数延续),不再复用旧快照对象。
    expect(session.read([], view, 128, 128, 1, [primitive]).revision).toBeGreaterThan(merged.revision);
  });
});
