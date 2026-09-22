import { sourceMaterialPatch, sourceTexturePatch } from "./sourceMaterialReset";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { SceneMaterialState } from "@bim-studio/contracts";
import { ViewerEngineObjectState } from "./viewerEngineObjectState";

const apply = ViewerEngineObjectState.prototype as unknown as {
  applyMaterialState: (this: unknown, object: THREE.Object3D, state: SceneMaterialState) => void;
  materialsForMesh: (mesh: THREE.Mesh) => THREE.Material[];
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
