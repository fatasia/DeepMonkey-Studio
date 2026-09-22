import type { IndustrialPrefabInstanceState } from "@bim-studio/contracts";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ViewerEngineInteraction } from "./viewerEngineInteraction";

describe("industrial prefab path ground snapping", () => {
  it("accounts for the hidden primitive ground offset and stores the snapped author path", () => {
    const root = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
    root.userData.primitiveKind = "box";
    root.position.y = 5;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    ground.rotation.x = -Math.PI / 2;
    ground.updateMatrixWorld(true);
    const model = { id: "fence", name: "Fence", object: root, kind: "primitive", visible: true, opacity: 1 };
    const context = Object.assign(Object.create(ViewerEngineInteraction.prototype) as ViewerEngineInteraction, {
      models: new Map([[model.id, model]]), modelPrefabStates: new Map(), motionRouteRuntimes: new Map(),
      visibleModelObjects: () => [ground], rebuildComponentIndex: vi.fn(), markShadowMapDirty: vi.fn(),
    });
    const state = { definitionId: "fence.modular", definitionVersion: "1.0.0", kind: "fence", operatingState: "idle",
      parameters: { heightM: 1.8, postSpacingM: 2, gateWidthM: 0, panel: "solid" },
      placementPath: { points: [{ id: "a", position: { x: 0, y: 0, z: 0 } },
        { id: "b", position: { x: 4, y: 0, z: 0 } }], interpolation: "linear", closed: false,
        snapToGround: true, seed: 1 } } satisfies IndustrialPrefabInstanceState;
    context.setIndustrialPrefabState(model.id, state);
    const saved = (context as unknown as { modelPrefabStates: Map<string, IndustrialPrefabInstanceState> }).modelPrefabStates.get(model.id)!;
    expect(saved.placementPath?.points.map(point => point.position.y)).toEqual([-4, -4]);
    root.updateMatrixWorld(true);
    expect(new THREE.Box3().setFromObject(root.children[0]!).min.y).toBeCloseTo(0);
  });
});
