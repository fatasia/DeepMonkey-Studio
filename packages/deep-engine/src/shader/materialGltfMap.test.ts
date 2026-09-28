import { describe, expect, it } from "vitest";
import { buildCapabilityInventory, summarizeCapabilityInventory, type CapabilityInventory } from "../gltf/capabilityInventory.js";
import { DEFAULT_EXTENDED_MATERIAL_PARAMETERS, serializeMaterialParameters } from "./materialParameters.js";
import {
  FALLBACK_MATERIAL_EXTENSIONS, mapGltfMaterialExtensions, MAPPED_MATERIAL_EXTENSIONS,
} from "./materialGltfMap.js";

const PATH = "materials[0]";

describe("glTF material extension mapping (T08 slice 1)", () => {
  it("maps the four supported extensions onto the parameter schema", () => {
    const mapping = mapGltfMaterialExtensions({
      extensions: {
        KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatRoughnessFactor: 0.45 },
        KHR_materials_anisotropy: { anisotropyStrength: 0.8, anisotropyRotation: 0.6 },
        KHR_materials_transmission: { transmissionFactor: 0.25 },
        KHR_materials_ior: { ior: 1.52 },
      },
    }, PATH);
    expect(mapping.mapped).toEqual([...MAPPED_MATERIAL_EXTENSIONS]);
    expect(mapping.fallback).toEqual([]);
    expect(mapping.losses).toEqual([]);
    expect(mapping.params).toEqual({
      ior: Math.fround(1.52), clearcoat: { factor: 1, roughness: Math.fround(0.45) },
      anisotropy: { strength: Math.fround(0.8), rotation: Math.fround(0.6) },
      transmission: { factor: Math.fround(0.25) },
    });
    expect(mapping.packed).toEqual(serializeMaterialParameters(mapping.params));
  });

  it("falls back to defaults and records losses when textures or volumes are declared", () => {
    const mapping = mapGltfMaterialExtensions({
      extensions: {
        KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatNormalTexture: { index: 0 } },
        KHR_materials_transmission: { transmissionTexture: { index: 1 } },
        KHR_materials_volume: { thicknessFactor: 0.5 },
        KHR_materials_sheen: { sheenColorFactor: [1, 0, 0] },
        KHR_materials_iridescence: { iridescenceFactor: 1 },
        KHR_materials_specular: { specularColorFactor: [1, 1, 1] },
        KHR_materials_dispersion: { dispersion: 0.2 },
        KHR_materials_emissive_strength: { emissiveStrength: 2 },
        KHR_materials_unlit: {},
        vendor_acme_warp: { strength: 1 },
      },
    }, PATH);
    expect(mapping.mapped).toEqual(["KHR_materials_clearcoat", "KHR_materials_transmission"]);
    expect(mapping.params.clearcoat.factor).toBe(1);
    const codes = mapping.losses.map((entry) => entry.code);
    expect(codes.filter((code) => code === "material-texture-unsupported")).toHaveLength(2);
    expect(codes.filter((code) => code === "extension-fallback")).toHaveLength(7);
    expect(codes).toContain("extension-unknown");
    for (const entry of mapping.losses) {
      expect(entry.stage === "material" || entry.stage === "extension").toBe(true);
      expect(entry.assetPath.startsWith(PATH)).toBe(true);
      expect(entry.detail.length).toBeGreaterThan(8);
    }
  });

  it("records explicit losses for every known-but-unsupported extension family", () => {
    const extensions: Record<string, unknown> = {};
    for (const name of FALLBACK_MATERIAL_EXTENSIONS) extensions[name] = {};
    const mapping = mapGltfMaterialExtensions({ extensions }, PATH);
    expect(mapping.fallback).toEqual([...FALLBACK_MATERIAL_EXTENSIONS]);
    expect(mapping.losses).toHaveLength(FALLBACK_MATERIAL_EXTENSIONS.length);
    expect(mapping.params).toEqual(DEFAULT_EXTENDED_MATERIAL_PARAMETERS);
  });

  it("recovers invalid scalars to defaults with a locating loss, or throws under failClosed", () => {
    const lossy = mapGltfMaterialExtensions({ extensions: {
      KHR_materials_clearcoat: { clearcoatFactor: 4 },
      KHR_materials_ior: { ior: Number.NaN },
    } }, PATH);
    expect(lossy.losses.map((entry) => entry.code)).toEqual(["material-value-invalid", "material-value-invalid"]);
    expect(lossy.params).toEqual(DEFAULT_EXTENDED_MATERIAL_PARAMETERS);
    expect(() => mapGltfMaterialExtensions({ extensions: { KHR_materials_ior: { ior: 0.5 } } }, PATH, { failClosed: true }))
      .toThrow(RangeError);
  });

  it("rejects non-object materials and extension payloads through the loss ledger", () => {
    const material = mapGltfMaterialExtensions("not-an-object", PATH);
    expect(material.params).toEqual(DEFAULT_EXTENDED_MATERIAL_PARAMETERS);
    expect(material.losses).toHaveLength(1);
    const payload = mapGltfMaterialExtensions({ extensions: { KHR_materials_clearcoat: 3 } }, PATH);
    expect(payload.losses[0]?.code).toBe("material-value-invalid");
    expect(payload.mapped).toEqual([]);
  });

  it("returns pure defaults for a material without extensions", () => {
    const mapping = mapGltfMaterialExtensions({ pbrMetallicRoughness: {} }, PATH);
    expect(mapping.params).toEqual(DEFAULT_EXTENDED_MATERIAL_PARAMETERS);
    expect(mapping.mapped).toEqual([]);
    expect(mapping.fallback).toEqual([]);
    expect(mapping.losses).toEqual([]);
    expect(mapping.packed).toEqual(serializeMaterialParameters(DEFAULT_EXTENDED_MATERIAL_PARAMETERS));
  });

  it("loss entries satisfy the shipped capability-inventory contract end to end", () => {
    const mapping = mapGltfMaterialExtensions({
      extensions: {
        KHR_materials_volume: { thicknessFactor: 1 },
        vendor_acme_warp: {},
        KHR_materials_clearcoat: { clearcoatNormalTexture: { index: 0 } },
      },
    }, PATH);
    const inventory: CapabilityInventory = buildCapabilityInventory({
      schema: "deep-engine.capability-inventory", schemaVersion: 1, assetId: "asset.t08-golden", path: "direct",
      objects: [{ objectId: "materials[0]", renderable: true, semanticsPreserved: true, failures: [...mapping.losses] }],
    });
    const summary = summarizeCapabilityInventory(inventory);
    expect(summary.failuresByFrequency.length).toBeGreaterThanOrEqual(2);
    expect(summary.renderable).toBe(1);
    for (const entry of summary.failuresByFrequency) {
      expect(["material", "extension"]).toContain(entry.stage);
    }
  });
});
