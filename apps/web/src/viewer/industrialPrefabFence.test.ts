import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { clearIndustrialPrefabProxy, ensureIndustrialPrefabProxy } from "./industrialPrefabProxy";

const state = (parameters: Record<string, number | string> = {}) => ({
  definitionId: "fence.modular", definitionVersion: "1", kind: "fence" as const,
  parameters, operatingState: "idle" as const,
});
const primitive = () => {
  const root = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
  root.userData.primitiveKind = "box";
  root.userData.locked = true;
  root.position.y = 1;
  return root;
};
describe("parameterized fence runtime", () => {
  it("uses metre dimensions, stays grounded and preserves identity and authored transform", () => {
    const root = primitive();
    const id = root.uuid;
    ensureIndustrialPrefabProxy(root, state({ heightM: 3, postSpacingM: 2, gateWidthM: 0 }));
    root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(root.children[0]!);
    expect(bounds.min.y).toBeCloseTo(0);
    expect(bounds.max.y).toBeCloseTo(3);
    expect(bounds.getSize(new THREE.Vector3()).x).toBeCloseTo(4.1);
    expect(root.uuid).toBe(id);
    expect(root.userData.locked).toBe(true);
    root.scale.set(2, 2, 2);
    root.updateMatrixWorld(true);
    expect(new THREE.Box3().setFromObject(root.children[0]!).getSize(new THREE.Vector3()).y).toBeCloseTo(6);
  });
  it("rebuilds parameter changes and disposes replaced resources once, retaining authored material", () => {
    const root = primitive();
    const original = root.material;
    ensureIndustrialPrefabProxy(root, state());
    const old = root.children[0]!;
    const part = old.children[0] as THREE.Mesh;
    const geometry = vi.spyOn(part.geometry, "dispose");
    const material = vi.spyOn(part.material as THREE.Material, "dispose");
    expect(ensureIndustrialPrefabProxy(root, state())).toBe(false);
    expect(root.children[0]).toBe(old);
    expect(ensureIndustrialPrefabProxy(root, state({ panel: "glass", heightM: 4 }))).toBe(true);
    expect(geometry).toHaveBeenCalledTimes(1);
    expect(material).toHaveBeenCalledTimes(1);
    expect(root.children).toHaveLength(1);
    expect(root.children[0]!.children.some((child) => child.name === "围栏面板")).toBe(true);
    clearIndustrialPrefabProxy(root);
    expect(root.material).toBe(original);
  });
  it("bounds hostile values and distinguishes panels without unbounded geometry", () => {
    const root = primitive();
    for (const panel of ["mesh", "solid", "glass", "electronic"]) {
      ensureIndustrialPrefabProxy(root, state({ heightM: NaN, postSpacingM: 1e30, gateWidthM: Infinity, panel }));
      const group = root.children[0]!;
      root.updateMatrixWorld(true);
      expect(group.children.length).toBeLessThan(200);
      expect(new THREE.Box3().setFromObject(group).max.y).toBeCloseTo(1.8);
      expect(group.children.some((child) => child.name === "电子围栏警示线")).toBe(panel === "electronic");
    }
  });
});
