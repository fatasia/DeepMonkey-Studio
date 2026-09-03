import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { clearIndustrialPrefabProxy, ensureIndustrialPrefabProxy } from "./industrialPrefabProxy";

describe("industrial prefab procedural proxy", () => {
  it("turns a primitive robot placeholder into a recognizable compound object", () => {
    const original = new THREE.MeshStandardMaterial({ color: "#2f80ed" });
    const root = new THREE.Mesh(new THREE.CylinderGeometry(), original);
    root.userData.primitiveKind = "cylinder";

    expect(ensureIndustrialPrefabProxy(root, "robot-arm")).toBe(true);
    const proxy = root.children[0]!;
    expect(proxy.userData.prefabKind).toBe("robot-arm");
    expect(proxy.children.map((child) => child.name)).toEqual(expect.arrayContaining(["底座", "肩关节", "大臂", "肘关节", "小臂", "末端工具"]));
    expect((root.material as THREE.Material).visible).toBe(false);

    expect(clearIndustrialPrefabProxy(root)).toBe(true);
    expect(root.children).toHaveLength(0);
    expect(root.material).toBe(original);
  });

  it("does not alter uploaded model groups", () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
    expect(ensureIndustrialPrefabProxy(root, "machine")).toBe(false);
    expect(root.children).toHaveLength(1);
  });
});
