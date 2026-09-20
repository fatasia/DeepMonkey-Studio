import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ViewerEngine } from "./ViewerEngine";
import { xrControllerRay, xrHitModelId } from "./xrInput";

function createEngineStub() {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry());
  mesh.userData.modelId = "pump";
  const engine = Object.create(ViewerEngine.prototype) as ViewerEngine & Record<string, unknown>;
  Object.assign(engine, {
    xrActive: true,
    raycaster: new THREE.Raycaster(),
    ordinaryPicking: {
      intersectObjects: vi.fn(() => [{ object: mesh, point: new THREE.Vector3(0, 1, 0), distance: 2 }]),
    },
    fragmentModels: new Map(),
    models: new Map([["pump", { id: "pump", object: mesh }]]),
    visibleModelObjects: vi.fn(() => [mesh]),
    select: vi.fn(),
    dispatchInteraction: vi.fn(),
  });
  return { engine, mesh };
}

function createController() {
  const controller = new THREE.Group();
  controller.position.set(1, 2, 3);
  controller.updateMatrixWorld(true);
  return controller;
}

afterEach(() => vi.restoreAllMocks());

describe("XR controller selection input", () => {
  it("maps a controller select to the existing select command and click interaction", () => {
    const { engine } = createEngineStub();
    const controller = createController();

    (engine as unknown as { handleXRControllerSelect(c: THREE.Group): void }).handleXRControllerSelect(controller);

    const raycaster = engine["raycaster"] as THREE.Raycaster;
    expect(raycaster.ray.origin.x).toBeCloseTo(1);
    expect(raycaster.ray.origin.z).toBeCloseTo(3);
    expect(raycaster.ray.direction.z).toBeLessThan(0);
    expect(engine["select"]).toHaveBeenCalledWith("pump");
    expect(engine["dispatchInteraction"]).toHaveBeenCalledWith("click", { kind: "object", modelId: "pump" });
  });

  it("clears the selection when the ray misses every model", () => {
    const { engine } = createEngineStub();
    (engine["ordinaryPicking"] as unknown as { intersectObjects: ReturnType<typeof vi.fn> }).intersectObjects.mockReturnValue([]);

    (engine as unknown as { handleXRControllerSelect(c: THREE.Group): void }).handleXRControllerSelect(createController());

    expect(engine["select"]).toHaveBeenCalledWith(undefined);
    expect(engine["dispatchInteraction"]).not.toHaveBeenCalled();
  });

  it("ignores controller input outside an XR session", () => {
    const { engine } = createEngineStub();
    engine["xrActive"] = false;

    (engine as unknown as { handleXRControllerSelect(c: THREE.Group): void }).handleXRControllerSelect(createController());

    expect(engine["select"]).not.toHaveBeenCalled();
    expect(engine["dispatchInteraction"]).not.toHaveBeenCalled();
  });

  it("attaches select and squeeze listeners when a controller is created", () => {
    const { engine } = createEngineStub();
    const handler = vi.fn();
    engine["handleXRControllerSelect"] = handler;
    const group = new THREE.Group();

    (engine as unknown as { onXRControllerCreated(c: THREE.Group): void }).onXRControllerCreated(group);
    const dispatcher = group as unknown as { dispatchEvent(event: { type: string }): void };
    dispatcher.dispatchEvent({ type: "selectstart" });
    dispatcher.dispatchEvent({ type: "squeezestart" });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("derives targetRay rays and model ids with the pure helpers", () => {
    const matrix = new THREE.Matrix4().makeTranslation(4, 5, 6);
    const ray = xrControllerRay(matrix);
    expect(ray.origin.equals(new THREE.Vector3(4, 5, 6))).toBe(true);
    expect(ray.direction.equals(new THREE.Vector3(0, 0, -1))).toBe(true);

    const holder = new THREE.Group();
    holder.userData.modelId = "fan";
    expect(xrHitModelId(holder)).toBe("fan");
    expect(xrHitModelId(new THREE.Group())).toBeUndefined();
    expect(xrHitModelId(undefined)).toBeUndefined();
  });
});
