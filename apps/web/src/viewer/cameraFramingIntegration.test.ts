import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ViewerEngine } from "./ViewerEngine";
import { DEFAULT_CAMERA_CONSTRAINTS } from "./viewerEngineTypes";

function fixture() {
  const engine = Object.create(ViewerEngine.prototype) as ViewerEngine;
  const camera = new THREE.PerspectiveCamera(50, 0.6, 0.05, 100_000);
  camera.position.set(10, 10, 10);
  const orbit = { target: new THREE.Vector3(), minDistance: 0.5, maxDistance: 10_000, update: vi.fn(() => {
    const delta = camera.position.clone().sub(orbit.target);
    camera.position.copy(orbit.target).add(delta.setLength(THREE.MathUtils.clamp(delta.length(), orbit.minDistance, orbit.maxDistance)));
    camera.lookAt(orbit.target); camera.updateMatrixWorld();
  }) };
  const object = new THREE.Mesh(new THREE.BoxGeometry(0.001, 0.002, 0.001), new THREE.MeshBasicMaterial());
  const models = new Map([["small", { object, visible: true }]]);
  Object.assign(engine, { camera, orbit, models, navigationMode: "orbit", navigationViewStates: new Map(),
    cameraConstraints: structuredClone(DEFAULT_CAMERA_CONSTRAINTS), pointer: { isLocked: false },
    updateTransformAccess: vi.fn(), resetCameraCollisionAnchor: vi.fn(), emitCameraChange: vi.fn(), setAvatarVisible: vi.fn(),
  });
  return { engine, camera, orbit, object, models };
}

describe("camera framing engine integration", () => {
  it("focuses millimeter assets before OrbitControls applies distance and clip limits", () => {
    const { engine, camera, orbit, object } = fixture();
    engine.focusModel("small");
    expect(camera.position.distanceTo(orbit.target)).toBeLessThan(0.01);
    expect(camera.near).toBeLessThan(0.0001);
    expect(orbit.minDistance).toBeLessThan(0.001);
    expect(engine.getCameraConstraints()).toEqual(DEFAULT_CAMERA_CONSTRAINTS);
    expect(object.scale.toArray()).toEqual([1, 1, 1]);
  });

  it("reloads the saved tiny camera without default controls pushing it back out", () => {
    const original = fixture(); original.engine.focusModel("small");
    const saved = original.engine.getCameraState();
    const restored = fixture(); restored.engine.applyCamera(saved);
    const loaded = restored.engine.getCameraState();
    expect(loaded.target).toEqual(saved.target); expect(loaded.mode).toBe(saved.mode);
    // Orbit normalization may differ by one floating-point ULP, never by a world-unit floor.
    for (const axis of ["x", "y", "z"] as const) expect(loaded.position[axis]).toBeCloseTo(saved.position[axis], 12);
    expect(restored.camera.near).toBeCloseTo(original.camera.near, 12);
  });

  it("fits all and six standard views without a hidden distant object changing bounds", () => {
    const { engine, camera, orbit, models } = fixture();
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(1_000, 1_000, 1_000), new THREE.MeshBasicMaterial());
    models.set("hidden", { object: hidden, visible: false });
    engine.fitAll();
    expect(camera.position.distanceTo(orbit.target)).toBeLessThan(0.01);
    for (const view of ["front", "back", "left", "right", "top", "bottom"] as const) {
      engine.setStandardView(view);
      expect(camera.position.distanceTo(orbit.target)).toBeLessThan(0.01);
      expect(camera.up.toArray()).toEqual(view === "top" ? [0, 0, -1] : view === "bottom" ? [0, 0, 1] : [0, 1, 0]);
    }
  });

  it("retains authored limits through focus and saved-camera restore", () => {
    const { engine, camera, orbit } = fixture();
    const custom = { ...DEFAULT_CAMERA_CONSTRAINTS, minDistance: 4, nearClip: 0.02 };
    engine.setCameraConstraints(custom); engine.focusModel("small");
    expect(camera.position.distanceTo(orbit.target)).toBeCloseTo(4);
    expect(camera.near).toBe(0.02); expect(engine.getCameraConstraints()).toEqual(custom);
    engine.applyCamera({ position: { x: 0, y: 0, z: 0.001 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" });
    expect(camera.position.distanceTo(orbit.target)).toBeCloseTo(4);
  });

  it("keeps light handles screen-sized at microscopic viewing distances", () => {
    const { engine, camera } = fixture();
    const light = new THREE.DirectionalLight(); light.position.set(0, 0, 0);
    const target = new THREE.Object3D();
    const proxy = { position: new THREE.Group(), target: new THREE.Group() };
    Object.assign(engine, { sceneLights: new Map([["light", light]]), sceneLightTargets: new Map([["light", target]]),
      sceneLightProxies: new Map([["light", proxy]]) });
    for (const distance of [0.001, 0.1, 1, 10]) {
      camera.position.set(0, 0, distance);
      (engine as unknown as { updateSceneLightProxies(): void }).updateSceneLightProxies();
      expect(proxy.position.scale.x / distance).toBeCloseTo(0.035);
      expect(proxy.target.scale.x / distance).toBeCloseTo(0.03);
    }
  });
});
