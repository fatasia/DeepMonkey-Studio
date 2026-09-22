import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { materialIor, prepareMaterialIor } from "./materialIor";
import { readMaterialSlot } from "./materialSlots";
import { applySourceMaterialOverrides } from "../delivery/sceneMaterialOverrides";
import { sourceMaterialPatch } from "./sourceMaterialReset";

describe("instance IOR editing", () => {
  it("preserves source IOR on publish and restores it after a slot override", () => {
    const source = { id: "asset/material/0", baseColor: [1, 1, 1] as [number, number, number], metallic: 0, roughness: 0.4, ior: 2.4 };
    expect(applySourceMaterialOverrides(source, undefined, "model").ior).toBe(2.4);
    expect(applySourceMaterialOverrides(source, { ior: 1.2, slotOverrides: { "gltf:0": { ior: 1.8 } } }, "model").ior).toBe(1.8);
    const restored = sourceMaterialPatch(readMaterialSlot(new THREE.MeshPhysicalMaterial({ ior: 2.4 })));
    expect(applySourceMaterialOverrides(source, { ior: 1.2, slotOverrides: { "gltf:0": restored } }, "model").ior).toBe(2.4);
    expect(source.ior).toBe(2.4);
  });
  it("validates every slot before modifying a physical material", () => {
    const source = new THREE.MeshPhysicalMaterial({ ior: 2.4 });
    const mesh = new THREE.Mesh(undefined, source);
    expect(() => prepareMaterialIor(mesh, { ior: 1.2, slotOverrides: { "gltf:1": { ior: NaN } } }, new Map())).toThrow();
    expect(source.ior).toBe(2.4);
  });
  it("keeps default materials and promotes an edited shared mesh slot once", () => {
    const source = new THREE.MeshStandardMaterial({ roughness: 0.2, metalness: 0.1 });
    const map = new THREE.Texture(); source.map = map;
    source.userData.studioSourceMap = map;
    const dispose = vi.spyOn(source, "dispose");
    const group = new THREE.Group();
    const first = new THREE.Mesh(undefined, source), second = new THREE.Mesh(undefined, source);
    group.add(first, second);
    const collision = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    prepareMaterialIor(group, { ior: 1.5 }, collision);
    expect(first.material).toBe(source);
    prepareMaterialIor(group, { ior: 1.8 }, collision);
    const physical = first.material as THREE.MeshPhysicalMaterial;
    expect(physical.isMeshPhysicalMaterial).toBe(true);
    expect(physical.defines).toHaveProperty("PHYSICAL");
    expect(second.material).toBe(physical);
    expect(physical.map).toBe(map);
    expect(physical.userData.studioSourceMap).toBe(map);
    expect(physical.roughness).toBe(0.2);
    expect(materialIor(physical)).toBe(1.8);
    expect(dispose).toHaveBeenCalledOnce();
    prepareMaterialIor(group, { ior: 1.5 }, collision);
    expect(first.material).toBe(physical);
    expect(physical.ior).toBe(1.5);
  });
  it("updates collision originals, preserving overlays and slot-specific source values", () => {
    const source = new THREE.MeshPhysicalMaterial({ ior: 2.4 });
    source.userData.studioGltfMaterialSlot = "gltf:0";
    const overlay = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(undefined, overlay);
    const collision = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>([[mesh, source]]);
    expect(readMaterialSlot(source).ior).toBe(2.4);
    prepareMaterialIor(mesh, { ior: 1.2, slotOverrides: { "gltf:0": { ior: 2.4 } } }, collision);
    expect(mesh.material).toBe(overlay);
    expect(source.ior).toBe(2.4);
  });
  it.each([0, NaN, Infinity, 1e100])("rejects invalid IOR %s without promoting the material", ior => {
    const source = new THREE.MeshStandardMaterial(); const mesh = new THREE.Mesh(undefined, source);
    expect(() => prepareMaterialIor(mesh, { ior }, new Map())).toThrow();
    expect(mesh.material).toBe(source);
  });
});
