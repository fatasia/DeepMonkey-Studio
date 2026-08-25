import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { exportFbxAscii } from "./fbxExporter";

describe("exportFbxAscii", () => {
  it("round-trips a transformed colored mesh through Three FBXLoader", () => {
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: "#d54b3d", transparent: true, opacity: 0.7 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4), material);
    mesh.name = "测试立方体";
    mesh.position.set(5, 2, -3);
    mesh.rotation.set(0.1, 0.2, 0.3);
    root.add(mesh);

    const text = exportFbxAscii(root);
    const bytes = new TextEncoder().encode(text);
    const parsed = new FBXLoader().parse(bytes.buffer, "");
    let meshCount = 0;
    let vertexCount = 0;
    parsed.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        meshCount += 1;
        vertexCount += object.geometry.getAttribute("position")?.count ?? 0;
      }
    });

    expect(text).toContain("FBXVersion: 7400");
    expect(text).toContain("DiffuseColor");
    expect(meshCount).toBe(1);
    expect(vertexCount).toBeGreaterThan(0);
  });

  it("rejects an empty scene", () => {
    expect(() => exportFbxAscii(new THREE.Group())).toThrow("没有可导出的可见网格");
  });
});
