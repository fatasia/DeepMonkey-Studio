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

  it("fail-closes author preview when a path segment exceeds the slope limit", () => {
    const material = new THREE.MeshStandardMaterial();
    const steep = (maxSlopeAngleDegrees?: number) => ({ definitionId: "road.straight", definitionVersion: "1.0.0",
      kind: "road" as const, operatingState: "idle" as const, parameters: {},
      placementPath: { points: [
        { id: "a", position: { x: 0, y: 0, z: 0 } }, { id: "b", position: { x: 1, y: 2, z: 0 } },
      ], interpolation: "linear" as const, closed: false, snapToGround: false, seed: 3,
      ...(maxSlopeAngleDegrees === undefined ? {} : { maxSlopeAngleDegrees }) } });
    // 63.4° 超过缺省 50°：作者预览直接拒绝，不生成静默爬坡的几何。
    expect(() => buildLinearPrefabGeometry(steep(), { metal: material, dark: material, panel: material, warning: material }))
      .toThrow(/坡度 63\.4° 超过上限 50°/);
    // 作者显式放宽到 89° 内即可放行，阈值可配置。
    expect(buildLinearPrefabGeometry(steep(89), { metal: material, dark: material, panel: material, warning: material }))
      .toBeDefined();
  });
});
