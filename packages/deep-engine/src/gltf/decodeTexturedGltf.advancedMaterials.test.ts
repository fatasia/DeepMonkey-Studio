import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prepareRenderPacket } from "../renderPacket.js";
import { decodeTexturedGltf } from "./decodeTexturedGltf.js";
import { parseGlb } from "./parseGlb.js";
import type { JsonObject } from "./validation.js";

const boxUrl = new URL("../../lab/assets/BoxTextured.glb", import.meta.url);

function untexturedLobeFixture(extensions: JsonObject) {
  const parsed = parseGlb(readFileSync(boxUrl));
  const document = structuredClone(parsed.json) as JsonObject;
  delete document.images; delete document.textures; delete document.samplers;
  document.extensionsUsed = Object.keys(extensions);
  document.materials = [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.5 }, extensions }];
  return { document, buffers: parsed.buffers };
}

const lobes: JsonObject = {
  KHR_materials_clearcoat: { clearcoatFactor: 0.7, clearcoatRoughnessFactor: 0.2 },
  KHR_materials_sheen: { sheenColorFactor: [0.5, 0.25, 1], sheenRoughnessFactor: 0.4 },
  KHR_materials_iridescence: { iridescenceFactor: 0.8, iridescenceIor: 1.5, iridescenceThicknessMinimum: 150, iridescenceThicknessMaximum: 320 },
  KHR_materials_transmission: { transmissionFactor: 0.6 },
  KHR_materials_volume: { thicknessFactor: 0.5, attenuationColor: [0.5, 1, 0.5], attenuationDistance: 2 },
};

describe("glTF KHR_materials_* with the advancedMaterials renderer capability", () => {
  it("default import keeps the explicit fallback: untextured lobes are dropped with a profile loss", async () => {
    const source = untexturedLobeFixture(lobes);
    const packet = await decodeTexturedGltf(source.document, source.buffers, undefined, { resourcePrefix: "g" });
    expect(packet.materials[0]!.extendedParameters).toBeUndefined();
    expect(packet.materials[0]!.advancedParameters).toBeUndefined();
    expect(packet.materialLosses?.some(loss => loss.code === "material-profile-unsupported")).toBe(true);
    expect(packet.materialLosses?.some(loss => loss.assetPath.endsWith("KHR_materials_sheen"))).toBe(true);
  });

  it("maps clearcoat / sheen / iridescence / transmission / volume onto an untextured material", async () => {
    const source = untexturedLobeFixture(lobes);
    const packet = await decodeTexturedGltf(source.document, source.buffers, undefined, { resourcePrefix: "g", advancedMaterials: true });
    const material = packet.materials[0]!;
    expect(material.extendedParameters).toMatchObject({ clearcoat: { factor: Math.fround(0.7), roughness: Math.fround(0.2) },
      transmission: { factor: Math.fround(0.6) } });
    expect(material.advancedParameters).toEqual({
      sheen: { color: [0.5, 0.25, 1], roughness: Math.fround(0.4) },
      iridescence: { factor: Math.fround(0.8), ior: 1.5, thickness: 320 },
      volume: { thickness: 0.5, attenuationColor: [0.5, 1, 0.5], attenuationDistance: 2 } });
    // 已映射扩展不再登记"回退"loss;不存在 profile 受限 loss。
    expect(packet.materialLosses ?? []).toEqual([]);
    const prepared = prepareRenderPacket(packet);
    expect(prepared.batches[0]!.textures).toMatchObject({ advanced: { sheen: { roughness: Math.fround(0.4) } } });
  });

  it("drops volume without transmission and keeps stock materials untouched", async () => {
    const volumeOnly = untexturedLobeFixture({ KHR_materials_volume: lobes.KHR_materials_volume as JsonObject });
    const packet = await decodeTexturedGltf(volumeOnly.document, volumeOnly.buffers, undefined, { resourcePrefix: "g", advancedMaterials: true });
    expect(packet.materials[0]!.advancedParameters).toBeUndefined();
    const plain = untexturedLobeFixture({});
    const stock = await decodeTexturedGltf(plain.document, plain.buffers, undefined, { resourcePrefix: "g", advancedMaterials: true });
    expect(stock.materials[0]!.extendedParameters).toBeUndefined();
    expect(stock.materials[0]!.advancedParameters).toBeUndefined();
  });

  it("records texture inputs of mapped lobes as losses instead of dropping them silently", async () => {
    const source = untexturedLobeFixture({ KHR_materials_sheen: { sheenColorFactor: [1, 1, 1], sheenColorTexture: { index: 0 } } });
    const packet = await decodeTexturedGltf(source.document, source.buffers, undefined, { resourcePrefix: "g", advancedMaterials: true });
    expect(packet.materialLosses).toEqual([expect.objectContaining({ code: "material-texture-unsupported",
      assetPath: "materials[0].extensions.KHR_materials_sheen.sheenColorTexture" })]);
  });
});