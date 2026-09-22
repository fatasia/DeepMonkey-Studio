import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { sourceMaterialPatch } from "./sourceMaterialReset";
import { mergeMaterialPatch, restoreMaterialSourceColors } from "./materialSlots";
import { applySourceMaterialOverrides } from "../delivery/sceneMaterialOverrides";

it("restores exact linear source colors instead of the rounded UI hex values", () => {
  const color: [number, number, number] = [0.1234567, 0.3456789, 0.5678912];
  const emissive: [number, number, number] = [0.2345678, 0.4567891, 0.6789123];
  const material = new THREE.MeshStandardMaterial();
  material.userData.studioSourceLinearColors = { color, emissive };
  const restore = sourceMaterialPatch({ color: "#62629f", emissive: "#232323" });
  restoreMaterialSourceColors(material, restore);
  expect(material.color.toArray()).toEqual(color);
  expect(material.emissive.toArray()).toEqual(emissive);
  const source = { id: "asset/material/0", baseColor: color, emissiveFactor: emissive, metallic: 0, roughness: 0.5 };
  const published = applySourceMaterialOverrides(source, { color: "#ff0000", slotOverrides: { "gltf:0": restore } }, "model");
  expect(published.baseColor).toEqual(color);
  expect(published.emissiveFactor).toEqual(emissive);
});

describe("editing restored material parameters", () => {
  it("replaces source intent for the edited color only and preserves other slot overrides", () => {
    const previous = { slotOverrides: { "gltf:0": { sourceColor: true, sourceEmissive: true }, "gltf:1": { roughness: 0.2 } } };
    const next = mergeMaterialPatch(previous, { slotOverrides: { "gltf:0": { color: "#00ff00" } } });
    expect(next.slotOverrides).toEqual({ "gltf:0": { sourceColor: false, sourceEmissive: true, color: "#00ff00" }, "gltf:1": { roughness: 0.2 } });
    expect(previous.slotOverrides["gltf:0"].sourceColor).toBe(true);
  });
});
