import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { isAlphaToCoverageRejection, isDeepAdvancedMaterialsRejection, packetUsesAlphaToCoverage,
  packetUsesDeepAdvancedMaterials, sceneUsesAlphaToCoverage, sceneUsesDeepAdvancedMaterials } from "./studioDeepAdvancedMaterials";

const meshOf = (material: THREE.Material | THREE.Material[]): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(), material);

describe("sceneUsesDeepAdvancedMaterials", () => {
  it("is false for standard and neutral physical materials", () => {
    const root = new THREE.Group();
    root.add(meshOf(new THREE.MeshStandardMaterial()), meshOf(new THREE.MeshPhysicalMaterial({ ior: 1.7 })),
      meshOf(new THREE.MeshPhysicalMaterial({ sheenColor: new THREE.Color(1, 1, 1), thickness: 2 })));
    expect(sceneUsesDeepAdvancedMaterials(root)).toBe(false);
  });

  it.each([{ clearcoat: 0.2 }, { sheen: 0.4 }, { iridescence: 1 }, { transmission: 0.5 }])("detects an active lobe %j", parameters => {
    const root = new THREE.Group();
    root.add(meshOf(new THREE.MeshStandardMaterial()), new THREE.Group().add(meshOf(new THREE.MeshPhysicalMaterial(parameters))));
    expect(sceneUsesDeepAdvancedMaterials(root)).toBe(true);
  });

  it("walks multi-material meshes", () => {
    const root = meshOf([new THREE.MeshStandardMaterial(), new THREE.MeshPhysicalMaterial({ sheen: 1 })]);
    expect(sceneUsesDeepAdvancedMaterials(root)).toBe(true);
  });
});
describe("author packet / rejection detection", () => {
  it("flags packets that need the variant (advanced params, clearcoat or transmission) and ignores stock extended lobes", () => {
    const aniso = { extendedParameters: { clearcoat: { factor: 0 }, transmission: { factor: 0 } } };
    expect(packetUsesDeepAdvancedMaterials({ materials: [{}, aniso] })).toBe(false);
    expect(packetUsesDeepAdvancedMaterials({ materials: [{ advancedParameters: { sheen: {} } }] })).toBe(true);
    expect(packetUsesDeepAdvancedMaterials({ materials: [{ extendedParameters: { clearcoat: { factor: 0.2 } } }] })).toBe(true);
    expect(packetUsesDeepAdvancedMaterials({ materials: [{ extendedParameters: { transmission: { factor: 1 } } }] })).toBe(true);
  });

  it("recognizes only the variant-not-enabled rejections", () => {
    expect(isDeepAdvancedMaterialsRejection(new Error("$.m: Three projection does not support MeshPhysicalMaterial non-neutral extensions."))).toBe(true);
    expect(isDeepAdvancedMaterialsRejection(new Error("PBR capability advanced-materials/not-enabled."))).toBe(true);
    expect(isDeepAdvancedMaterialsRejection(new Error("Deep WebGPU device was lost."))).toBe(false);
    expect(isDeepAdvancedMaterialsRejection("material.clearcoatMap")).toBe(false);
  });
});

describe("sceneUsesAlphaToCoverage", () => {
  it("is false for default standard materials (alphaToCoverage 缺省 false,不透传任何字段)", () => {
    const root = new THREE.Group();
    root.add(meshOf(new THREE.MeshStandardMaterial()), meshOf(new THREE.MeshStandardMaterial({ alphaTest: 0.4 })));
    expect(sceneUsesAlphaToCoverage(root)).toBe(false);
  });

  it("detects the request on nested and multi-material meshes", () => {
    const nested = new THREE.Group().add(meshOf(new THREE.MeshStandardMaterial({ alphaToCoverage: true })));
    expect(sceneUsesAlphaToCoverage(nested)).toBe(true);
    expect(sceneUsesAlphaToCoverage(meshOf([
      new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial({ alphaToCoverage: true }),
    ]))).toBe(true);
  });
});

describe("packetUsesAlphaToCoverage", () => {
  it("flags only packets whose materials request alpha-to-coverage", () => {
    expect(packetUsesAlphaToCoverage({ materials: [{}] })).toBe(false);
    expect(packetUsesAlphaToCoverage({ materials: [{ alphaToCoverage: false }] })).toBe(false);
    expect(packetUsesAlphaToCoverage({ materials: [{}, { alphaToCoverage: true }] })).toBe(true);
  });
});

describe("isAlphaToCoverageRejection", () => {
  it("matches exactly the capability-gate rejection, not the BLEND semantic rejection", () => {
    expect(isAlphaToCoverageRejection(new Error("$.m: Three projection does not support material alphaToCoverage."))).toBe(true);
    // transparent 组合是无定义语义,必须原路径失败,不得触发受控重建。
    expect(isAlphaToCoverageRejection(new Error("Three projection does not support material alphaToCoverage with transparent."))).toBe(false);
    expect(isAlphaToCoverageRejection(new Error("Deep WebGPU device was lost."))).toBe(false);
  });
});