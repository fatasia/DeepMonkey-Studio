import { describe, expect, it } from "vitest";
import type { RenderPacket } from "@bim-studio/deep-engine";
import { applySourceMaterialOverrides, assertStaticMaterialOverrides } from "./sceneMaterialOverrides";
import { projectPhysicalLobes } from "./scenePhysicalLobeProjection";
import { sceneHexToLinearRgb } from "./sceneNeutralAppearance";

type Material = RenderPacket["materials"][number];
const source: Material = { id: "gltf/material/0", baseColor: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5 };

describe("scene material lobes → render packet", () => {
  it("neutral/default lobe fields (as saved by the editor) leave the material untouched and are not rejected", () => {
    const neutral = { clearcoat: 0, clearcoatRoughness: 0, sheen: 0, sheenRoughness: 1, sheenColor: "#000000", iridescence: 0,
      iridescenceIOR: 1.3, iridescenceThicknessMax: 400, transmission: 0, thickness: 0, attenuationColor: "#ffffff" };
    expect(() => assertStaticMaterialOverrides(neutral, "m")).not.toThrow();
    expect(applySourceMaterialOverrides(source, neutral, "m")).toEqual(source);
    expect(applySourceMaterialOverrides(source, undefined, "m")).toBe(source);
  });

  it("projects active lobes with three semantics (sheenColor × sheen, linear color, thickness upper bound, volume only with transmission)", () => {
    const material = applySourceMaterialOverrides(source, { clearcoat: 0.8, clearcoatRoughness: 0.25, sheen: 0.5, sheenColor: "#ffffff", sheenRoughness: 0.4,
      iridescence: 0.75, iridescenceIOR: 1.6, iridescenceThicknessMax: 330, transmission: 0.9, thickness: 1.5, attenuationColor: "#80ff80", attenuationDistance: 2 }, "m");
    expect(material.extendedParameters).toMatchObject({ ior: 1.5, clearcoat: { factor: 0.8, roughness: 0.25 }, transmission: { factor: 0.9 } });
    expect(material.advancedParameters?.sheen).toEqual({ color: [0.5, 0.5, 0.5], roughness: 0.4 });
    expect(material.advancedParameters?.iridescence).toEqual({ factor: 0.75, ior: 1.6, thickness: 330 });
    expect(material.advancedParameters?.volume).toEqual({ thickness: 1.5, attenuationColor: sceneHexToLinearRgb("#80ff80"), attenuationDistance: 2 });
    const noTransmission = projectPhysicalLobes(source, { transmission: 0, thickness: 2 }, 1.5);
    expect(noTransmission).toEqual({});
  });

  it("round-trips through JSON (no Infinity) and an explicit undefined attenuation distance means none", () => {
    const material = applySourceMaterialOverrides(source, { transmission: 1, thickness: 1, attenuationDistance: undefined }, "m");
    expect(material.advancedParameters?.volume).not.toHaveProperty("attenuationDistance");
    expect(JSON.parse(JSON.stringify(material.advancedParameters))).toEqual(material.advancedParameters);
  });

  it("source (glTF-decoded) lobes survive unless the state overrides them; a state zero removes them", () => {
    const decoded: Material = { ...source, extendedParameters: { ior: 1.5, clearcoat: { factor: 0.4, roughness: 0.1 }, anisotropy: { strength: 0, rotation: 0 }, transmission: { factor: 0 } },
      advancedParameters: { sheen: { color: [0.2, 0.2, 0.2], roughness: 0.3 } } };
    const kept = applySourceMaterialOverrides(decoded, { roughness: 0.6 }, "m");
    expect(kept.extendedParameters).toEqual(decoded.extendedParameters); expect(kept.advancedParameters).toEqual(decoded.advancedParameters);
    const cleared = applySourceMaterialOverrides(decoded, { clearcoat: 0, sheen: 0 }, "m");
    expect(cleared.extendedParameters).toBeUndefined(); expect(cleared.advancedParameters).toBeUndefined();
  });

  it("an IOR-only override keeps the extended IOR consistent with the instance IOR", () => {
    const decoded: Material = { ...source, extendedParameters: { ior: 1.5, clearcoat: { factor: 0.4, roughness: 0.1 }, anisotropy: { strength: 0, rotation: 0 }, transmission: { factor: 0 } } };
    expect(applySourceMaterialOverrides(decoded, { ior: 1.8 }, "m").extendedParameters?.ior).toBe(1.8);
  });

  it("rejects malformed lobe values with the object id", () => {
    expect(() => assertStaticMaterialOverrides({ sheen: 2 }, "m")).toThrow(/对象 m/);
    expect(() => assertStaticMaterialOverrides({ attenuationColor: "white" }, "m")).toThrow(/对象 m/);
  });
});