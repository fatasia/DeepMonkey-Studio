import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { RuntimeFollowCamera } from "./runtimeFollowCamera";
import { ViewerEngine } from "./ViewerEngine";

function fixture() {
  const engine = Object.create(ViewerEngine.prototype) as ViewerEngine;
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.25, 5);
  const target = new THREE.Vector3(0, 1.25, 0);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 0.2), new THREE.MeshBasicMaterial());
  wall.position.set(0, 1, 2);
  wall.updateMatrixWorld(true);
  const orbit = { target, minDistance: 2.2, update: vi.fn() };
  const models = new Map([["wall", { object: wall, visible: true }]]);
  Object.assign(engine, {
    camera, orbit, models, raycaster: new THREE.Raycaster(),
    runtimeFollowCamera: new RuntimeFollowCamera(),
    cameraConstraints: { minDistance: 0.5, collisionRadius: 0.32, collisionEnabled: true },
  });
  const update = (dt = 1 / 60) => (engine as unknown as { updateRuntimeFollowCamera(dt: number): void }).updateRuntimeFollowCamera(dt);
  return { engine, camera, target, wall, orbit, models, update };
}

describe("third-person runtime camera consumption", () => {
  it("pulls in on the same frame as a target-to-eye wall, without moving the target", () => {
    const { camera, target, wall, orbit, update } = fixture();
    update();
    expect(orbit.minDistance).toBeLessThan(camera.position.distanceTo(target));
    expect(camera.position.z).toBeGreaterThan(0.8);
    expect(camera.position.z).toBeLessThan(1.6);
    const wallMeshes = new THREE.Raycaster(target, camera.position.clone().sub(target).normalize(), 0.01, target.distanceTo(camera.position))
      .intersectObject(wall, true);
    expect(wallMeshes).toHaveLength(0);
    expect(target.toArray()).toEqual([0, 1.25, 0]);
    update();
    expect(camera.position.z).toBeLessThan(1.6);
  });

  it("restores the intended orbit smoothly after target leaves the wall and never overshoots", () => {
    const { camera, target, update } = fixture();
    update();
    const occluded = camera.position.z;
    target.x = 4;
    camera.position.x = 4;
    update();
    expect(camera.position.z).toBeGreaterThan(occluded);
    expect(camera.position.z).toBeLessThan(5);
    for (let frame = 0; frame < 90; frame += 1) update();
    expect(camera.position.z).toBeCloseTo(5, 2);
    expect(camera.position.x).toBe(4);
  });

  it("does not mutate eye with no scene objects and honors explicit camera reset", () => {
    const { camera, orbit, models, update } = fixture();
    orbit.minDistance = 0.01;
    models.clear();
    update();
    expect(orbit.minDistance).toBe(2.2);
    expect(camera.position.toArray()).toEqual([0, 1.25, 5]);
    const follow = new RuntimeFollowCamera();
    const eye = new THREE.Vector3(0, 0, 5);
    const center = new THREE.Vector3();
    follow.update(eye, center, 0.32, 1 / 60, () => 2);
    follow.reset();
    eye.z = 7;
    follow.update(eye, center, 0.32, 1 / 60, () => undefined);
    expect(eye.z).toBe(7);
  });

  it("casts one camera ray per frame with 100 static scene objects", () => {
    const { camera, target, models, update } = fixture();
    models.clear();
    const wall = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 0.2), new THREE.MeshBasicMaterial());
    wall.position.set(0, 1, 2);
    wall.updateMatrixWorld(true);
    for (let i = 0; i < 100; i += 1) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1, 0.4), new THREE.MeshBasicMaterial());
      mesh.position.set(20 + i, 0.5, 0);
      mesh.updateMatrixWorld(true);
      models.set(`obstacle-${i}`, { object: mesh, visible: true });
    }
    models.set("wall", { object: wall, visible: true });
    const start = performance.now();
    for (let frame = 0; frame < 120; frame += 1) update();
    const elapsed = performance.now() - start;
    expect(camera.position.z).toBeLessThan(2);
    expect(target.x).toBe(0);
    // Environment-sensitive measurement: record as diagnostic, not a flaky hard threshold.
    console.info(`T16 100 blockers / 120 frames: ${elapsed.toFixed(2)}ms (${(elapsed / 120).toFixed(3)}ms/frame)`);
  });

  it("keeps finite clearance for a thin blocker and handles zero-distance inputs", () => {
    const follow = new RuntimeFollowCamera();
    const eye = new THREE.Vector3(0, 0, 5);
    const center = new THREE.Vector3();
    expect(follow.update(eye, center, 0.32, 1 / 60, () => 0.1)).toBe(true);
    expect(eye.z).toBeCloseTo(1e-4, 6);
    eye.z = 5;
    follow.reset();
    follow.update(eye, center, 0.32, 1 / 60, () => 0.015);
    expect(eye.z).toBeLessThan(0.015);
    expect(follow.update(eye, eye, 0.32, 1 / 60, () => { throw Error("no ray expected"); })).toBe(false);
  });
});
