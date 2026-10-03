import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { validateScene } from "@bim-studio/contracts";
import { applyPhysicalLobes, patchTouchesPhysicalLobes, PHYSICAL_LOBE_SCALARS, preparePhysicalLobes, readPhysicalLobes,
  stateActivatesPhysicalLobes, validatePhysicalLobePatch } from "./materialPhysicalLobes";

const transform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
const sceneWith = (material: unknown) => ({ id: "s", name: "S", camera: { position: { x: 0, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
  models: [{ modelId: "a", name: "A", visible: true, opacity: 1, transform, material }], primitives: [], measurements: [] });
const meshWith = (material: THREE.Material | THREE.Material[]) => { const group = new THREE.Group(); const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material); group.add(mesh); return { group, mesh }; };

describe("physical lobe field table", () => {
  it("hard limits are exactly the persisted contract (accept at the limit, reject just beyond)", () => {
    for (const field of PHYSICAL_LOBE_SCALARS) {
      const [lo, hi] = field.limit;
      const accept = (value: number) => () => validateScene(sceneWith({ [field.key]: value }), "scene");
      expect(accept(Math.min(Math.max(lo, field.min), hi)), field.key).not.toThrow();
      expect(accept(hi), `${field.key} max`).not.toThrow();
      if (hi < Number.MAX_VALUE) expect(accept(hi * 1.01 + 1e-3), `${field.key} over`).toThrow();
      if (lo > 0) expect(accept(lo / 2), `${field.key} under`).toThrow();
      else expect(accept(-0.001), `${field.key} negative`).toThrow();
      // UI 滑块范围是硬范围的子集,且小数位与步长一致。
      expect(field.min).toBeGreaterThanOrEqual(lo); expect(field.max).toBeLessThanOrEqual(hi);
      expect(Number(field.step.toString().split(".")[1]?.length ?? 0)).toBeLessThanOrEqual(field.decimals);
    }
  });
});

describe("physical lobes on three materials", () => {
  it("standard materials read neutral lobes; physical read live values (sparse attenuation distance)", () => {
    expect(readPhysicalLobes(new THREE.MeshStandardMaterial())).toMatchObject({ clearcoat: 0, sheen: 0, sheenRoughness: 1, iridescenceIOR: 1.3, iridescenceThicknessMax: 400, attenuationColor: "#ffffff" });
    expect(readPhysicalLobes(new THREE.MeshBasicMaterial())).toEqual({});
    const physical = new THREE.MeshPhysicalMaterial({ clearcoat: 0.5, attenuationDistance: 2, iridescenceThicknessRange: [100, 320] });
    expect(readPhysicalLobes(physical)).toMatchObject({ clearcoat: 0.5, attenuationDistance: 2, iridescenceThicknessMax: 320 });
    expect(readPhysicalLobes(new THREE.MeshPhysicalMaterial())).not.toHaveProperty("attenuationDistance");
  });

  it("promotes standard → physical only for non-neutral lobes and keeps the owned surface", () => {
    const standard = new THREE.MeshStandardMaterial({ color: 0x336699, roughness: 0.3 });
    const { group, mesh } = meshWith(standard);
    preparePhysicalLobes(group, { clearcoat: 0, sheenRoughness: 1, sheenColor: "#000000" }, new Map());
    expect(mesh.material).toBe(standard);
    const promoted: Array<[THREE.Material, THREE.Material]> = [];
    preparePhysicalLobes(group, { clearcoat: 0.6 }, new Map(), (a, b) => promoted.push([a, b]));
    const next = mesh.material as THREE.MeshPhysicalMaterial;
    expect(next.isMeshPhysicalMaterial).toBe(true); expect(promoted).toEqual([[standard, next]]);
    expect(next.roughness).toBe(0.3); expect(next.color.getHex()).toBe(standard.color.getHex());
    applyPhysicalLobes(next, { clearcoat: 0.6, clearcoatRoughness: 0.2 });
    expect(next.clearcoat).toBe(0.6); expect(next.clearcoatRoughness).toBe(0.2);
  });

  it("applies every lobe, clamps to hard limits and clears attenuation distance with an explicit undefined", () => {
    const material = new THREE.MeshPhysicalMaterial();
    applyPhysicalLobes(material, { sheen: 0.5, sheenColor: "#ff8000", sheenRoughness: 0.4, iridescence: 1, iridescenceIOR: 1.6,
      iridescenceThicknessMax: 320, transmission: 0.9, thickness: 1.5, attenuationColor: "#80ff80", attenuationDistance: 2 });
    expect(material).toMatchObject({ sheen: 0.5, sheenRoughness: 0.4, iridescence: 1, iridescenceIOR: 1.6, transmission: 0.9, thickness: 1.5, attenuationDistance: 2 });
    expect(material.iridescenceThicknessRange).toEqual([100, 320]);
    expect(material.sheenColor.getHexString()).toBe("ff8000");
    applyPhysicalLobes(material, { attenuationDistance: undefined });
    expect(material.attenuationDistance).toBe(Infinity);
    applyPhysicalLobes(material, { iridescence: 0, transmission: 0, thickness: 0 });
    expect(stateActivatesPhysicalLobes(readPhysicalLobes(new THREE.MeshPhysicalMaterial()))).toBe(false);
    // 不触碰 lobe 的补丁完全不改材质。
    const before = JSON.stringify(readPhysicalLobes(material));
    applyPhysicalLobes(material, { roughness: 0.2 }); expect(JSON.stringify(readPhysicalLobes(material))).toBe(before);
    expect(patchTouchesPhysicalLobes({ roughness: 0.2 })).toBe(false);
  });

  it("validates the whole patch before any mutation (slot overrides included)", () => {
    const standard = new THREE.MeshStandardMaterial(); const { group, mesh } = meshWith(standard);
    expect(() => preparePhysicalLobes(group, { clearcoat: 0.5, slotOverrides: { "gltf:0": { sheen: 2 } } }, new Map())).toThrow();
    expect(mesh.material).toBe(standard);
    expect(() => validatePhysicalLobePatch({ sheenColor: "red" })).toThrow();
    expect(() => validatePhysicalLobePatch({ attenuationDistance: 0 })).toThrow();
    expect(() => validatePhysicalLobePatch({ attenuationDistance: undefined })).not.toThrow();
  });

  it("slot-scoped patches promote only the addressed material", () => {
    const a = new THREE.MeshStandardMaterial(), b = new THREE.MeshStandardMaterial();
    a.userData.studioGltfMaterialSlot = "gltf:0"; b.userData.studioGltfMaterialSlot = "gltf:1";
    const { group, mesh } = meshWith([a, b]);
    preparePhysicalLobes(group, { slotOverrides: { "gltf:1": { transmission: 1 } } }, new Map());
    const [first, second] = mesh.material as THREE.Material[];
    expect(first).toBe(a); expect((second as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial).toBe(true);
  });
});