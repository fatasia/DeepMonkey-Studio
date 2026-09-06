import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { fitPerspectiveBox, resolveOrbitCameraRange } from "./cameraFraming";
import { DEFAULT_CAMERA_CONSTRAINTS } from "./viewerEngineTypes";

const defaults = DEFAULT_CAMERA_CONSTRAINTS;
const direction = new THREE.Vector3(1, 0.72, 1).normalize();

describe("scale-aware camera framing", () => {
  it.each([0.001, 0.1, 1, 100, 100_000])("frames a %s m box without a world-unit size floor", size => {
    for (const aspect of [0.25, 0.6, 1, 2.4]) {
      const box = new THREE.Box3(new THREE.Vector3(-size / 2, -size, -size / 3), new THREE.Vector3(size / 2, size, size / 3));
      const camera = new THREE.PerspectiveCamera(50, aspect);
      const frame = fitPerspectiveBox(box, camera, defaults, direction)!;
      const range = resolveOrbitCameraRange(defaults, frame.distance);
      camera.position.copy(frame.center).addScaledVector(direction, frame.distance);
      camera.near = range.nearClip; camera.far = range.farClip;
      camera.lookAt(frame.center); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
      const projected = [];
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const point = new THREE.Vector3(x, y, z).project(camera); projected.push(point);
        expect(Math.abs(point.x)).toBeLessThanOrEqual(0.88);
        expect(Math.abs(point.y)).toBeLessThanOrEqual(0.88);
        expect(Math.abs(point.z)).toBeLessThan(1);
      }
      const span = Math.max(...projected.map(p => Math.abs(p.x)), ...projected.map(p => Math.abs(p.y)));
      expect(span).toBeGreaterThan(0.8);
      expect(range.minDistance).toBeLessThan(frame.distance);
      expect(range.maxDistance).toBeGreaterThan(frame.distance);
    }
  });

  it("uses effective FOV, ignores object world offset, and never mutates author limits", () => {
    const camera = new THREE.PerspectiveCamera(35, 0.6); camera.zoom = 2;
    const box = new THREE.Box3(new THREE.Vector3(-0.03, -0.01, -0.02), new THREE.Vector3(0.03, 0.01, 0.02));
    const original = structuredClone(defaults);
    const centered = fitPerspectiveBox(box, camera, defaults, direction)!;
    const offset = new THREE.Vector3(10_000, 100, -500);
    const moved = fitPerspectiveBox(box.clone().translate(offset), camera, defaults, direction)!;
    expect(moved.distance).toBeCloseTo(centered.distance, 8);
    expect(moved.center.toArray()).toEqual(offset.toArray());
    expect(defaults).toEqual(original);
  });

  it("preserves non-default authored distance and clipping boundaries", () => {
    const custom = { ...defaults, minDistance: 8, maxDistance: 20, nearClip: 0.2, farClip: 800 };
    expect(resolveOrbitCameraRange(custom, 0.001)).toEqual(custom);
    const camera = new THREE.PerspectiveCamera(50, 1);
    const small = new THREE.Box3(new THREE.Vector3(-0.01, -0.01, -0.01), new THREE.Vector3(0.01, 0.01, 0.01));
    expect(fitPerspectiveBox(small, camera, custom, direction)!.distance).toBe(8);
    expect(fitPerspectiveBox(small.clone().expandByScalar(100), camera, custom, direction)!.distance).toBe(20);
  });

  it("returns no frame for empty, point, non-finite boxes or invalid projection", () => {
    const camera = new THREE.PerspectiveCamera(50, 1);
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    expect(fitPerspectiveBox(new THREE.Box3(), camera, defaults, direction)).toBeUndefined();
    expect(fitPerspectiveBox(new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()), camera, defaults, direction)).toBeUndefined();
    expect(fitPerspectiveBox(box.clone().translate(new THREE.Vector3(NaN, 0, 0)), camera, defaults, direction)).toBeUndefined();
    camera.aspect = 0;
    expect(fitPerspectiveBox(box, camera, defaults, direction)).toBeUndefined();
  });
});
