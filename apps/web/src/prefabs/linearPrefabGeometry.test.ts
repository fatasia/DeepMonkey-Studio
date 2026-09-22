import type { IndustrialPrefabInstanceState } from "@bim-studio/contracts";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildLinearPrefabGeometry } from "./linearPrefabGeometry";

describe("linear prefab geometry", () => {
  it("instances repeated fence parts while preserving the authored path bounds", () => {
    const material = new THREE.MeshStandardMaterial();
    const state = { definitionId: "fence.modular", definitionVersion: "1.0.0", kind: "fence", operatingState: "idle",
      parameters: { heightM: 1.8, postSpacingM: 2, gateWidthM: 0, panel: "mesh" },
      placementPath: { points: [
        { id: "a", position: { x: 0, y: 0, z: 0 } }, { id: "b", position: { x: 6, y: 0, z: 0 } },
        { id: "c", position: { x: 12, y: 0, z: 0 } }, { id: "d", position: { x: 18, y: 0, z: 0 } },
      ], interpolation: "linear", closed: false, snapToGround: false, seed: 3 } } satisfies IndustrialPrefabInstanceState;
    const root = buildLinearPrefabGeometry(state, { metal: material, dark: material, panel: material, warning: material })!;
    const batches: THREE.InstancedMesh[] = [];
    root.traverse(object => { if (object instanceof THREE.InstancedMesh) batches.push(object); });
    expect(batches.some(batch => batch.userData.pathInstanceCount >= 4)).toBe(true);
    root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(root);
    expect(bounds.min.x).toBeLessThanOrEqual(0);
    expect(bounds.max.x).toBeGreaterThanOrEqual(18);
  });
});
