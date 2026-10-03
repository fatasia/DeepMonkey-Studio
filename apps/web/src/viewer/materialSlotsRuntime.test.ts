import { sourceMaterialPatch, sourceTexturePatch } from "./sourceMaterialReset";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { SceneMaterialState } from "@bim-studio/contracts";
import { ViewerEngineObjectState } from "./viewerEngineObjectState";
import { readMaterialSlot } from "./materialSlots";

const apply = ViewerEngineObjectState.prototype as unknown as {
  applyMaterialState: (this: unknown, object: THREE.Object3D, state: SceneMaterialState) => void;
  materialsForMesh: (mesh: THREE.Mesh) => THREE.Material[];
  getMaterialState: (this: unknown, object: THREE.Object3D) => SceneMaterialState;
};
function harness() {
  return { collisionOriginalMaterials: new Map(), materialsForMesh: apply.materialsForMesh,
    applyMaterialTexture: vi.fn(), applyModelScreen: vi.fn() };
}
function model() {
  const materials = [0, 1].map(index => {
    const material = new THREE.MeshStandardMaterial({ roughness: 0.5 });
    material.userData.studioGltfMaterialSlot = `gltf:${index}`;
    return material;
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), materials);
  return { mesh, materials };
}
describe("material slot renderer consumption", () => {
  it("serializes ungraded author color so saved grading reproduces exact rendered RGB rather than grading twice", () => {
    const renderer = harness();
    const original = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: "#d4a84f" }));
    const neutral = original.material.color.toArray();
    apply.applyMaterialState.call(renderer, original, { brightness: 0.35, contrast: -0.3 });
    const graded = original.material.color.toArray();
    const saved = apply.getMaterialState.call(renderer, original);
    console.info("C2/B2 color readback", JSON.stringify({ rendered: original.material.color.getHexString(), serialized: saved.color, ungraded: original.material.userData.studioUngradedColor }));
    expect(graded).not.toEqual(neutral); // Positive control: real grading changed the output.
    expect(saved.color).toBe("#d4a84f");
    expect(readMaterialSlot(original.material).color).toBe(saved.color);
    const reopened = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: "#d4a84f" }));
    apply.applyMaterialState.call(renderer, reopened, JSON.parse(JSON.stringify(saved)));
    expect(reopened.material.color.toArray()).toEqual(graded);
    expect(reopened.material.userData.studioColorAdjustment).toEqual(original.material.userData.studioColorAdjustment);
    const wrong = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: "#d4a84f" }));
    apply.applyMaterialState.call(renderer, wrong, { ...saved, color: `#${original.material.color.getHexString()}` });
    expect(wrong.material.color.toArray()).not.toEqual(graded); // Same-phase negative control detects double grading.
  });

  it("keeps zero adjustment bit-identical for precise linear source colors and reset after nonzero grading", () => {
    const renderer = harness();
    const colors = [[0.1234567, 0.3456789, 0.5678912], [0, 0.0000123456, 1], [0.25, 0.75, 0.5]];
    const bits = (values: number[]) => Array.from(new BigUint64Array(Float64Array.from(values).buffer));
    for (const source of colors) {
      const material = new THREE.MeshStandardMaterial(); material.color.fromArray(source);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material), baseline = bits(material.color.toArray());
      const zero = { hue: 0, saturation: 0, brightness: 0, contrast: 0 };
      apply.applyMaterialState.call(renderer, mesh, zero);
      expect(bits(material.color.toArray())).toEqual(baseline);
      apply.applyMaterialState.call(renderer, mesh, { brightness: 0.3, contrast: -0.25 });
      expect(bits(material.color.toArray())).not.toEqual(baseline);
      apply.applyMaterialState.call(renderer, mesh, zero);
      expect(bits(material.color.toArray())).toEqual(baseline);
    }
  });
  it("preserves the linear baseline through a material clone and explicit author-color changes", () => {
    const renderer = harness(), material = new THREE.MeshStandardMaterial();
    material.color.fromArray([0.1234567, 0.3456789, 0.5678912]);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material), original = material.color.toArray();
    apply.applyMaterialState.call(renderer, mesh, { brightness: 0.3 });
    const clone = new THREE.Mesh(new THREE.BoxGeometry(), material.clone());
    apply.applyMaterialState.call(renderer, clone, { brightness: 0 });
    expect(clone.material.color.toArray()).toEqual(original);
    apply.applyMaterialState.call(renderer, clone, { color: "#12abef" });
    expect(clone.material.color.toArray()).toEqual(new THREE.Color("#12abef").toArray());
    apply.applyMaterialState.call(renderer, clone, { brightness: 0.2 });
    apply.applyMaterialState.call(renderer, clone, { brightness: 0 });
    expect(clone.material.color.toArray()).toEqual(new THREE.Color("#12abef").toArray());
  });

  it("edits exactly one slot and leaves the other instance and slot unchanged", () => {
    const a = model(), b = model(), renderer = harness();
    apply.applyMaterialState.call(renderer, a.mesh, { slotOverrides: { "gltf:1": { roughness: 0.12 } } });
    expect(a.materials.map(material => material.roughness)).toEqual([0.5, 0.12]);
    expect(b.materials.map(material => material.roughness)).toEqual([0.5, 0.5]);
    apply.applyMaterialState.call(renderer, a.mesh, { roughness: 0.8, slotOverrides: { "gltf:1": { roughness: 0.12 } } });
    expect(a.materials.map(material => material.roughness)).toEqual([0.8, 0.12]);
  });
});


it("restores only the selected slot from source values and replays the saved restoration", () => {
  const a = model(), renderer = harness();
  const source = { roughness: 0.5, metalness: 0, color: "#ffffff" };
  const edit = { slotOverrides: { "gltf:1": { roughness: 0.12 } } };
  apply.applyMaterialState.call(renderer, a.mesh, edit);
  const restored = { slotOverrides: { "gltf:1": sourceMaterialPatch(source) } };
  apply.applyMaterialState.call(renderer, a.mesh, restored);
  expect(a.materials.map(material => material.roughness)).toEqual([0.5, 0.5]);
  apply.applyMaterialState.call(renderer, a.mesh, edit);
  expect(a.materials[1]!.roughness).toBe(0.12);
  const reloaded = model();
  apply.applyMaterialState.call(renderer, reloaded.mesh, JSON.parse(JSON.stringify(restored)));
  expect(reloaded.materials.map(material => material.roughness)).toEqual([0.5, 0.5]);
});

it("animates an instance clone and restores the original UV/sampler without mutating its source", () => {
  const prototype = ViewerEngineObjectState.prototype as unknown as Record<string, (...args: any[]) => any>;
  const source = new THREE.Texture();
  source.repeat.set(2, 3); source.offset.set(0.2, 0.4); source.rotation = 0.3;
  source.wrapS = THREE.ClampToEdgeWrapping;
  const material = new THREE.MeshStandardMaterial({ map: source });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  const renderer = { ...harness(), originalMaterialTextures: new WeakMap(), modelScreenOriginals: new WeakMap(),
    applyMaterialTexture: prototype.applyMaterialTexture,
    disposeManagedMaterialTexture: prototype.disposeManagedMaterialTexture,
    models: new Map([["a", { visible: true, object: mesh }]]) };
  apply.applyMaterialState.call(renderer, mesh, { uvAnimation: { enabled: true, offsetSpeedX: 0.2, offsetSpeedY: 0, rotationSpeed: 0 } });
  const animated = material.map!;
  expect(animated).not.toBe(source);
  expect(animated.repeat.toArray()).toEqual([2, 3]);
  prototype.updateMaterialUvAnimations!.call(renderer, 1);
  expect(animated.offset.x).toBeCloseTo(0.4);
  expect(source.offset.x).toBe(0.2);
  const dispose = vi.spyOn(animated, "dispose");
  apply.applyMaterialState.call(renderer, mesh, { ior: 1.8 });
  const physical = mesh.material as THREE.MeshPhysicalMaterial;
  expect(physical.isMeshPhysicalMaterial).toBe(true);
  apply.applyMaterialState.call(renderer, mesh, sourceTexturePatch());
  expect(physical.map).toBe(source);
  expect(dispose).toHaveBeenCalledOnce();
  prototype.updateMaterialUvAnimations!.call(renderer, 1);
  expect(source.offset.toArray()).toEqual([0.2, 0.4]);
  expect(source.rotation).toBe(0.3);
  expect(source.wrapS).toBe(THREE.ClampToEdgeWrapping);
});
