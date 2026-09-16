import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { prepareRenderPacket } from "../renderPacket.js";
import { decodeTexturedGlb } from "./decodeTexturedGlb.js";
import { decodeTexturedGltf } from "./decodeTexturedGltf.js";
import { parseGlb } from "./parseGlb.js";
import type { GltfImageDecoder } from "./textureTypes.js";
import { GltfImportError, type JsonObject } from "./validation.js";

const sourceUrl = new URL("../../lab/assets/TextureTransformMultiTest.glb", import.meta.url);
const fallbacks = ["KHR_materials_clearcoat", "KHR_materials_unlit"] as const;

function decoder(): GltfImageDecoder {
  return { decode: vi.fn(async image => ({ width: 1, height: 1,
    data: new Uint8Array([image.imageIndex, 64, 128, 255]) })) };
}

describe("official TextureTransformMultiTest vertical slice", () => {
  it("pins the unchanged Khronos asset and proves its MR + transform + UV1 source contract", () => {
    const bytes = readFileSync(sourceUrl);
    expect(bytes).toHaveLength(388_264);
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe("569aedb53822d5721e7e06af5983348683d4b2ffb1d469338ad4f02bf6a74911");
    const document = parseGlb(bytes).json as JsonObject;
    expect(document.extensionsUsed).toEqual([
      "KHR_materials_clearcoat", "KHR_materials_unlit", "KHR_texture_transform",
    ]);
    expect(document.extensionsRequired).toEqual(["KHR_texture_transform"]);
    const materials = document.materials as JsonObject[];
    const pbr = materials[12]!.pbrMetallicRoughness as JsonObject;
    expect(pbr.metallicRoughnessTexture).toMatchObject({ index: 0, texCoord: 1,
      extensions: { KHR_texture_transform: {
        offset: [0.7049999535083774, 0.28500004152502995],
        rotation: 1.5707963705062866,
        scale: [0.3499999940395355, 0.3499999940395355],
      } } });
  });

  it("decodes the original asset through explicit optional core fallbacks", async () => {
    const bytes = readFileSync(sourceUrl), imageDecoder = decoder();
    await expect(decodeTexturedGlb(bytes, imageDecoder)).rejects.toMatchObject({
      code: "unsupported", path: "extensionsUsed[0]", feature: "extension KHR_materials_clearcoat",
    });
    const packet = await decodeTexturedGlb(bytes, imageDecoder, {
      resourcePrefix: "official-transform", optionalMaterialFallbacks: fallbacks,
    });
    expect(imageDecoder.decode).toHaveBeenCalledTimes(3);
    expect(packet.geometries).toHaveLength(29); expect(packet.materials).toHaveLength(29);
    expect(packet.instances).toHaveLength(29); expect(packet.textures).toHaveLength(6);
    expect(packet.geometries[12]).toMatchObject({ id: "official-transform/mesh/12/primitive/0" });
    expect(packet.geometries[12]!.uv0).toBeUndefined();
    expect(packet.geometries[12]!.uv1).toHaveLength(8);
    expect(packet.materials[12]!.metallicRoughnessTexture).toMatchObject({
      texture: "official-transform/texture/0/metallicRoughness", texCoord: 1,
      offset: [0.7049999535083774, 0.28500004152502995],
      scale: [0.3499999940395355, 0.3499999940395355], rotation: 1.5707963705062866,
    });
    expect(packet.textures!.map(texture => [texture.semantic, texture.format])).toEqual([
      ["baseColor", undefined], ["baseColor", undefined], ["emissive", undefined],
      ["normal", undefined], ["metallicRoughness", undefined],
      ["occlusion", undefined],
    ]);
    const prepared = prepareRenderPacket(packet);
    const transformed = prepared.batches.find(batch => batch.geometry === "official-transform/mesh/12/primitive/0");
    expect(transformed?.textures?.metallicRoughness).toMatchObject({
      texture: "official-transform/texture/0/metallicRoughness", texCoord: 1,
    });
    const uvTransform = transformed!.textures!.metallicRoughness!.uvTransform;
    [0, -0.35, 0.705, 0.35, 0, 0.285].forEach((value, index) => {
      expect(uvTransform[index]).toBeCloseTo(value, 6);
    });
    expect(prepared.textures.map(texture => [texture.semantic, texture.format])).toEqual([
      ["baseColor", "rgba8unorm-srgb"], ["baseColor", "rgba8unorm-srgb"],
      ["emissive", "rgba8unorm-srgb"],
      ["normal", "rgba8unorm"], ["metallicRoughness", "rgba8unorm"],
      ["occlusion", "rgba8unorm"],
    ]);
  });

  it("never permits a required extension to use an optional fallback", async () => {
    const parsed = parseGlb(readFileSync(sourceUrl));
    const document = structuredClone(parsed.json) as JsonObject;
    document.extensionsRequired = ["KHR_texture_transform", "KHR_materials_unlit"];
    await expect(decodeTexturedGltf(document, parsed.buffers, undefined, {
      optionalMaterialFallbacks: fallbacks,
    })).rejects.toEqual(expect.objectContaining<GltfImportError>({
      code: "unsupported", path: "extensionsRequired", feature: "required material fallback KHR_materials_unlit",
    }));
  });
});
