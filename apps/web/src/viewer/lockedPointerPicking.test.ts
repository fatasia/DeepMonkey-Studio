import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ViewerEngine } from "./ViewerEngine";

function fixture() {
  const front = new THREE.Mesh();
  front.userData.modelId = "front";
  const back = new THREE.Mesh();
  back.userData.modelId = "back";
  const engine = Object.create(ViewerEngine.prototype) as ViewerEngine & {
    pointerHit(event: PointerEvent, editableOnly?: boolean): THREE.Intersection | undefined;
    scenePointerHit(event: PointerEvent, editableOnly?: boolean): Promise<{ modelId?: string; fragmentNodeId?: string } | undefined>;
  };
  const models = new Map([["front", { object: front, visible: true }], ["back", { object: back, visible: true }]]);
  const hit = (object: THREE.Object3D, distance: number) => ({ object, distance, point: new THREE.Vector3() });
  Object.assign(engine, {
    models, camera: new THREE.PerspectiveCamera(), pointerPosition: new THREE.Vector2(), raycaster: new THREE.Raycaster(),
    renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } },
    ordinaryPicking: { intersectObjects: () => [hit(front, 1), hit(back, 3)] },
    fragmentModels: new Map(), fragmentLayers: new Map(), fragmentNodeIdsByLocalId: new Map(), layerObjects: new Map(),
    visibleModelObjects: () => [front, back],
  });
  return { engine, front, back, event: { clientX: 50, clientY: 50 } as PointerEvent };
}

describe("locked author selection picking", () => {
  it("picks through a locked model while measurement and runtime picking retain it", () => {
    const { engine, front, back, event } = fixture();
    front.userData.modelLocked = true;
    expect(engine.pointerHit(event, true)?.object).toBe(back);
    expect(engine.pointerHit(event)?.object).toBe(front);
  });
  it("picks through children inheriting a locked layer", () => {
    const { engine, front, back, event } = fixture();
    const group = new THREE.Group(); group.userData.layerLocked = true; group.add(front);
    expect(engine.pointerHit(event, true)?.object).toBe(back);
  });
  it("uses all fragment intersections to find an unlocked item behind a locked item", async () => {
    const { engine, front, event } = fixture();
    const raycast = vi.fn();
    const raycastAll = vi.fn(async () => [
      { localId: 1, point: new THREE.Vector3(), distance: 1 },
      { localId: 2, point: new THREE.Vector3(), distance: 2 },
    ]);
    Object.assign(engine, {
      ordinaryPicking: { intersectObjects: () => [] },
      fragmentModels: new Map([["front", { raycast, raycastAll }]]),
      fragmentNodeIdsByLocalId: new Map([["front", new Map([[1, "locked"], [2, "open"]])]]),
      fragmentLayers: new Map([["front", new Map([["locked", { node: { locked: true } }], ["open", { node: { locked: false } }]])]]),
    });
    expect(await engine.scenePointerHit(event, true)).toMatchObject({ modelId: "front", fragmentNodeId: "open" });
    expect(raycast).not.toHaveBeenCalled();
    front.userData.modelLocked = true;
    expect(await engine.scenePointerHit(event, true)).toBeUndefined();
    expect(raycastAll).toHaveBeenCalledTimes(1);
  });
});
