import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { prepareRenderPacket } from "../renderPacket.js";
import { normalizeExtendedMaterialParameters } from "../shader/materialParameters.js";
import { normalizeAdvancedMaterialParameters } from "../shader/materialAdvancedParameters.js";
import { bridge, project } from "./testFixture.js";

const physical = (parameters: THREE.MeshPhysicalMaterialParameters): THREE.Mesh<THREE.BoxGeometry, THREE.MeshPhysicalMaterial> =>
  new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhysicalMaterial({ color: 0x808080, ...parameters }));
const rejected = (target: ReturnType<typeof bridge>, mesh: THREE.Mesh) => {
  mesh.updateWorldMatrix(true, true);
  const result = target.project(mesh, { cameraLayerMask: 1 });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected rejection.");
  return result.issues[0];
};

describe("Three MeshPhysicalMaterial lobes with the advancedMaterials capability", () => {
  it("keeps the fail-closed contract when the renderer capability is absent", () => {
    for (const parameters of [{ clearcoat: 0.5 }, { sheen: 1, sheenColor: new THREE.Color(1, 1, 1) }, { iridescence: 1 }, { transmission: 1 },
      { specularIntensity: .5 }, { specularColor: new THREE.Color(.2, .4, 1) }]) {
      expect(rejected(bridge(), physical(parameters))).toMatchObject({ code: "unsupported", feature: "MeshPhysicalMaterial non-neutral extensions" });
    }
  });

  it("is byte-identical for neutral physical materials with or without the capability", () => {
    const neutral = physical({});
    const a = project(bridge(), neutral).packet.materials[0]!, b = project(bridge(undefined, { advancedMaterials: true }), neutral).packet.materials[0]!;
    expect({ ...b, id: "" }).toEqual({ ...a, id: "" });
    expect(b.extendedParameters).toBeUndefined();
    expect(b.advancedParameters).toBeUndefined();
  });

  it("projects clearcoat (KHR_materials_clearcoat equivalent) into extended parameters", () => {
    const mesh = physical({ clearcoat: 0.8, clearcoatRoughness: 0.25 });
    const material = project(bridge(undefined, { advancedMaterials: true }), mesh).packet.materials[0]!;
    expect(material.extendedParameters).toEqual({ ior: 1.5, clearcoat: { factor: 0.8, roughness: 0.25 },
      anisotropy: { strength: 0, rotation: 0 }, transmission: { factor: 0 } });
    expect(material.advancedParameters).toBeUndefined();
    expect(normalizeExtendedMaterialParameters(material.extendedParameters!).clearcoat.factor).toBe(Math.fround(0.8));
    expect(prepareRenderPacket(project(bridge(undefined, { advancedMaterials: true }), mesh).packet).batches[0]!.textures)
      .toMatchObject({ extendedParameters: { clearcoat: { factor: Math.fround(0.8) } } });
  });

  it("projects sheen with three's sheenColor × sheen scaling, iridescence thickness maximum and volume", () => {
    const mesh = physical({ sheen: 0.5, sheenColor: new THREE.Color(1, 0.5, 0.25), sheenRoughness: 0.4,
      iridescence: 0.75, iridescenceIOR: 1.6, iridescenceThicknessRange: [120, 330],
      transmission: 0.9, thickness: 1.5, attenuationColor: new THREE.Color(0.5, 0.75, 1), attenuationDistance: 2 });
    const material = project(bridge(undefined, { advancedMaterials: true }), mesh).packet.materials[0]!;
    expect(material.advancedParameters).toEqual({
      sheen: { color: [0.5, 0.25, 0.125], roughness: 0.4 },
      iridescence: { factor: 0.75, ior: 1.6, thickness: 330 },
      volume: { thickness: 1.5, attenuationColor: [0.5, 0.75, 1], attenuationDistance: 2 } });
    expect(material.extendedParameters?.transmission.factor).toBe(0.9);
    const normalized = normalizeAdvancedMaterialParameters(material.advancedParameters!);
    expect(normalized.volume.attenuationDistance).toBe(2);
    const prepared = prepareRenderPacket(project(bridge(undefined, { advancedMaterials: true }), mesh).packet);
    expect(prepared.batches[0]!.textures).toMatchObject({ advanced: { iridescence: { thickness: 330 } } });
  });

  it("ignores lobes three itself ignores (zero sheen / iridescence / transmission scalars)", () => {
    const mesh = physical({ sheenColor: new THREE.Color(1, 1, 1), iridescenceIOR: 2, thickness: 3, attenuationDistance: 1 });
    const material = project(bridge(undefined, { advancedMaterials: true }), mesh).packet.materials[0]!;
    expect(material.extendedParameters).toBeUndefined();
    expect(material.advancedParameters).toBeUndefined();
  });

  it("projects independent specular factors and maps in the advanced profile", () => {
    const mesh = physical({ specularIntensity: .5, specularColor: new THREE.Color(2, .5, .25) });
    mesh.material.specularIntensityMap = new THREE.DataTexture(Uint8Array.from([255, 255, 255, 64]), 1, 1);
    mesh.material.specularColorMap = new THREE.DataTexture(Uint8Array.from([64, 128, 255, 255]), 1, 1);
    mesh.material.specularColorMap.colorSpace = THREE.SRGBColorSpace;
    mesh.material.specularIntensityMap.needsUpdate = true;
    mesh.material.specularColorMap.needsUpdate = true;
    const packet = project(bridge(undefined, { advancedMaterials: true }), mesh).packet;
    expect(packet.materials[0]).toMatchObject({ specularFactor: .5, specularColorFactor: [2, .5, .25] });
    expect(packet.textures!.map(texture => texture.semantic)).toEqual(["specular", "specularColor"]);
    expect(packet.textures![0]!.data[3]).toBe(64);
    expect(packet.textures![1]!.data).toEqual(new Uint8Array([64, 128, 255, 255]));
    expect(prepareRenderPacket(packet).batches[0]!.textures).toMatchObject({ specularFactor: .5 });
  });

  it("still fails closed on other maps, anisotropy and dispersion", () => {
    const target = bridge(undefined, { advancedMaterials: true });
    expect(rejected(target, physical({ anisotropy: 0.5 }))).toMatchObject({ code: "unsupported" });
    expect(rejected(target, physical({ dispersion: 0.2 }))).toMatchObject({ code: "unsupported" });
    const withMap = physical({ clearcoat: 1 });
    withMap.material.clearcoatMap = new THREE.DataTexture(Uint8Array.from([255, 255, 255, 255]), 1, 1);
    expect(rejected(target, withMap)).toMatchObject({ code: "unsupported", feature: "material.clearcoatMap" });
  });
});
