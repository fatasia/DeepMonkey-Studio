import { readFileSync } from "node:fs";
import { CompatibleGLTFLoader } from "./CompatibleGLTFLoader";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { materialSlotId, materialStateForSlot, tagGltfMaterialSlots } from "./materialSlots";

describe("stable source material slots", () => {
  it("keeps duplicate names distinct and preserves identity through per-instance clones", () => {
    const first = new THREE.MeshStandardMaterial({ name: "Paint" });
    const second = new THREE.MeshStandardMaterial({ name: "Paint" });
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), [first, second]));
    tagGltfMaterialSlots({ scene, parser: { associations: new Map([[first, { materials: 0 }], [second, { materials: 1 }]]) } } as unknown as GLTF);
    expect(materialSlotId(first)).toBe("gltf:0");
    expect(materialSlotId(second)).toBe("gltf:1");
    const clone = first.clone();
    expect(clone.uuid).not.toBe(first.uuid);
    expect(materialSlotId(clone)).toBe("gltf:0");
    expect(materialStateForSlot({ slotOverrides: { "gltf:1": { roughness: 0.2 } } }, first)).toBeUndefined();
    expect(materialStateForSlot({ roughness: 0.9, slotOverrides: { "gltf:1": { roughness: 0.2 } } }, second)).toEqual({ roughness: 0.2 });
    expect(first.roughness).toBe(1);
  });
  it("does not invent identities for unsupported model sources", () => {
    expect(materialSlotId(new THREE.MeshStandardMaterial())).toBeUndefined();
  });
});


it("tags actual loader materials identically after independent reloads", async () => {
  const bytes = readFileSync(new URL("../../../../packages/deep-engine/lab/assets/Box.glb", import.meta.url));
  const loader = new CompatibleGLTFLoader();
  const first = await loader.parseAsync(Uint8Array.from(bytes).buffer, "");
  const second = await loader.parseAsync(Uint8Array.from(bytes).buffer, "");
  const ids = (root: THREE.Object3D) => {
    const result: string[] = [];
    root.traverse(child => {
      const mesh = child as THREE.Mesh;
      for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
        result.push(materialSlotId(material)!);
      }
    });
    return result;
  };
  expect(ids(first.scene)).toEqual(["gltf:0"]);
  expect(ids(second.scene)).toEqual(ids(first.scene));
});
