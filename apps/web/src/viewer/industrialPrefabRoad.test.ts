import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ensureIndustrialPrefabProxy } from "./industrialPrefabProxy";

function primitive() {
  const root = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
  root.userData.primitiveKind = "box";
  root.position.y = 1;
  return root;
}

const state = (parameters: Record<string, number | string>) => ({
  definitionId: "road.straight",
  definitionVersion: "1.0.0",
  kind: "road" as const,
  parameters,
  operatingState: "idle" as const,
});

describe("straight-road prefab runtime", () => {
  it("rebuilds the visible road from edited author parameters while preserving identity", () => {
    const root = primitive();
    const id = root.uuid;
    expect(ensureIndustrialPrefabProxy(root, state({ lengthM: 20, carriagewayWidthM: 7, shoulderWidthM: 1, laneCount: 2, surface: "asphalt", marking: "center" }))).toBe(true);
    root.updateMatrixWorld(true);
    let bounds = new THREE.Box3().setFromObject(root.children[0]!);
    expect(bounds.min.y).toBeCloseTo(0);
    expect(bounds.getSize(new THREE.Vector3()).x).toBeCloseTo(20);
    expect(bounds.getSize(new THREE.Vector3()).z).toBeCloseTo(9);

    const old = root.children[0]!;
    const geometryDispose = vi.spyOn((old.children[0] as THREE.Mesh).geometry, "dispose");
    expect(ensureIndustrialPrefabProxy(root, state({ lengthM: 36, carriagewayWidthM: 8, shoulderWidthM: 0, laneCount: 4, surface: "concrete", marking: "lanes" }))).toBe(true);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(root.uuid).toBe(id);
    root.updateMatrixWorld(true);
    bounds = new THREE.Box3().setFromObject(root.children[0]!);
    expect(bounds.getSize(new THREE.Vector3()).x).toBeCloseTo(36);
    const markings = root.children[0]!.children.find((child) => child.name === "道路标线") as THREE.InstancedMesh;
    expect(markings.count).toBeGreaterThan(3);
  });
});
