import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { prepareRenderPacket } from "../renderPacket.js";
import { decodeTexturedGlb } from "./decodeTexturedGlb.js";
import { parseGlb } from "./parseGlb.js";
import type { GltfImageDecoder } from "./textureTypes.js";
import { GltfImportError, type JsonObject } from "./validation.js";

const sourceUrl = new URL("../../lab/assets/BoxTextured.glb", import.meta.url);
const normalTangentSourceUrl = new URL("../../lab/assets/NormalTangentTest.glb", import.meta.url);
const pixels = () => new Uint8Array([12, 34, 56, 255, 78, 90, 123, 255]);

function decoder(data = pixels()): GltfImageDecoder {
  return { decode: vi.fn(async () => ({ width: 2, height: 1, data })) };
}

function encodedGlb(document: unknown, binary: Uint8Array): Uint8Array {
  const text = JSON.stringify(document), jsonPadding = (4 - new TextEncoder().encode(text).length % 4) % 4;
  const json = new TextEncoder().encode(text + " ".repeat(jsonPadding));
  const binaryLength = binary.length + (4 - binary.length % 4) % 4;
  const result = new Uint8Array(12 + 8 + json.length + 8 + binaryLength), view = new DataView(result.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, result.length, true);
  view.setUint32(12, json.length, true); view.setUint32(16, 0x4e4f534a, true); result.set(json, 20);
  const binaryHeader = 20 + json.length;
  view.setUint32(binaryHeader, binaryLength, true); view.setUint32(binaryHeader + 4, 0x004e4942, true);
  result.set(binary, binaryHeader + 8);
  return result;
}

function changedOfficial(change: (document: JsonObject) => void): Uint8Array {
  const parsed = parseGlb(readFileSync(sourceUrl)), document = parsed.json as JsonObject;
  change(document);
  return encodedGlb(document, parsed.buffers[0]!);
}

describe("textured GLB RenderPacket composition", () => {
  it("composes the fixed official NormalTangentTest through AO, generated TBN and double-sided contracts", async () => {
    const bytes = readFileSync(normalTangentSourceUrl);
    expect(bytes).toHaveLength(1_796_996);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("5ac0932355ae1ea05a7485eeddcc3f1fbe56c678e00b519075feced80e9e9d6a");
    const imageDecoder: GltfImageDecoder = { decode: vi.fn(async image => ({ width: 2, height: 1,
      data: new Uint8Array([image.imageIndex, 64, 128, 255, image.imageIndex, 64, 128, 255]) })) };
    const packet = await decodeTexturedGlb(bytes, imageDecoder, { resourcePrefix: "official-normal-tangent" });
    expect(imageDecoder.decode).toHaveBeenCalledTimes(3);
    expect(packet.geometries).toHaveLength(1); expect(packet.instances).toHaveLength(1);
    expect(packet.geometries[0]!.vertices).toHaveLength(3983 * 6);
    expect(packet.geometries[0]!.indices).toHaveLength(23_322);
    expect(packet.geometries[0]!.tangents).toHaveLength(3983 * 4);
    expect(packet.materials[0]).toMatchObject({ doubleSided: true,
      baseColorTexture: { texture: "official-normal-tangent/texture/0/baseColor" },
      metallicRoughnessTexture: { texture: "official-normal-tangent/texture/1/metallicRoughness" },
      normalTexture: { texture: "official-normal-tangent/texture/2/normal", normalScale: 1 },
      occlusionTexture: { texture: "official-normal-tangent/texture/1/occlusion", strength: 1 } });
    expect(packet.textures!.map(texture => texture.semantic)).toEqual(["baseColor", "metallicRoughness", "normal", "occlusion"]);
    const prepared = prepareRenderPacket(packet);
    expect(prepared.batches[0]).toMatchObject({ count: 1, doubleSided: true,
      textures: { normal: { normalScale: 1 }, occlusion: { strength: 1 } } });
    expect(prepared.textures.map(texture => [texture.semantic, texture.format])).toEqual([
      ["baseColor", "rgba8unorm-srgb"], ["metallicRoughness", "rgba8unorm"],
      ["normal", "rgba8unorm"], ["occlusion", "rgba8unorm"],
    ]);
  });

  it("composes the fixed official BoxTextured geometry, UV0, material slot and owned pixels", async () => {
    const bytes = readFileSync(sourceUrl), decoded = pixels();
    const imageDecoder: GltfImageDecoder = { decode: vi.fn(async image => {
      expect(image.mimeType).toBe("image/png");
      expect(image.data).toHaveLength(3750);
      image.data.fill(0);
      return { width: 2, height: 1, data: decoded };
    }) };
    const packet = await decodeTexturedGlb(bytes, imageDecoder, { resourcePrefix: "official-box" });
    expect(imageDecoder.decode).toHaveBeenCalledOnce();
    expect(packet.geometries[0]!.uv0).toHaveLength(48);
    expect(Math.max(...packet.geometries[0]!.uv0!)).toBe(6);
    expect(packet.materials[0]).toMatchObject({
      id: "official-box/material/0", metallic: 0,
      baseColorTexture: { texture: "official-box/texture/0/baseColor", texCoord: 0 },
    });
    expect(packet.textures).toMatchObject([{ id: "official-box/texture/0/baseColor", semantic: "baseColor", width: 2, height: 1 }]);
    expect(prepareRenderPacket(packet).batches[0]!.textures?.baseColor?.texture).toBe("official-box/texture/0/baseColor");

    decoded.fill(0);
    bytes.fill(0);
    expect([...packet.textures![0]!.data]).toEqual([12, 34, 56, 255, 78, 90, 123, 255]);
    expect(packet.geometries[0]!.vertices.some(value => value !== 0)).toBe(true);
  });

  it("composes a glTF TEXCOORD_1 AO slot into an independently owned packet UV1 stream", async () => {
    const bytes = changedOfficial(document => {
      const primitive = ((document.meshes as JsonObject[])[0]!.primitives as JsonObject[])[0]!;
      const attributes = primitive.attributes as JsonObject;
      attributes.TEXCOORD_1 = attributes.TEXCOORD_0;
      (document.materials as JsonObject[])[0]!.occlusionTexture = { index: 0, texCoord: 1, strength: 0.4 };
    });
    const packet = await decodeTexturedGlb(bytes, decoder());
    expect(packet.geometries[0]!.uv1).toEqual(packet.geometries[0]!.uv0);
    expect(packet.geometries[0]!.uv1).not.toBe(packet.geometries[0]!.uv0);
    expect(packet.materials[0]!.baseColorTexture?.texCoord).toBe(0);
    expect(packet.materials[0]!.occlusionTexture).toMatchObject({ texCoord: 1, strength: 0.4 });
    const prepared = prepareRenderPacket(packet);
    expect(prepared.batches[0]!.textures?.baseColor?.texCoord).toBe(0);
    expect(prepared.batches[0]!.textures?.occlusion?.texCoord).toBe(1);
  });

  it("preserves PBR factors beside the texture slot", async () => {
    const bytes = changedOfficial(document => {
      const material = (document.materials as JsonObject[])[0]!;
      const pbr = material.pbrMetallicRoughness as JsonObject;
      pbr.baseColorFactor = [0.25, 0.5, 0.75, 0.2];
      pbr.metallicFactor = 0.4;
      pbr.roughnessFactor = 0.6;
    });
    const packet = await decodeTexturedGlb(bytes, decoder());
    expect(packet.materials[0]).toMatchObject({
      baseColor: [0.25, 0.5, 0.75], metallic: 0.4, roughness: 0.6,
      baseColorTexture: { texture: "gltf/texture/0/baseColor" },
    });
  });

  it("composes supported alpha material state while still exposing unsupported primitive features", async () => {
    const materialBytes = changedOfficial(document => {
      (document.materials as JsonObject[])[0]!.alphaMode = "BLEND";
    });
    const materialDecoder = decoder();
    await expect(decodeTexturedGlb(materialBytes, materialDecoder)).resolves.toMatchObject({
      materials: [{ alphaMode: "BLEND", baseColorAlpha: 1, baseColorTexture: { texture: "gltf/texture/0/baseColor" } }],
    });
    expect(materialDecoder.decode).toHaveBeenCalledOnce();

    const primitiveBytes = changedOfficial(document => {
      const primitive = (((document.meshes as JsonObject[])[0]!.primitives as JsonObject[])[0]!);
      (primitive.attributes as JsonObject).COLOR_0 = 3;
    });
    await expect(decodeTexturedGlb(primitiveBytes, decoder())).rejects.toMatchObject({
      code: "unsupported", path: expect.stringContaining("COLOR_0"),
    });
  });

  it("composes AO, emissive and double-sided intent without weakening texture validation", async () => {
    const bytes = changedOfficial(document => {
      const material = (document.materials as JsonObject[])[0]!;
      document.extensionsUsed = ["KHR_materials_emissive_strength"];
      document.extensionsRequired = ["KHR_materials_emissive_strength"];
      material.extensions = { KHR_materials_emissive_strength: { emissiveStrength: 8 } };
      material.occlusionTexture = { index: 0, strength: 0.25 };
      material.emissiveTexture = { index: 0 };
      material.emissiveFactor = [0.1, 0.2, 0.3];
      material.alphaMode = "MASK"; material.alphaCutoff = 0.25;
      (material.pbrMetallicRoughness as JsonObject).baseColorFactor = [1, 1, 1, 0.3];
      material.doubleSided = true;
    });
    const imageDecoder = decoder(), packet = await decodeTexturedGlb(bytes, imageDecoder);
    expect(imageDecoder.decode).toHaveBeenCalledOnce();
    expect(packet.materials[0]).toMatchObject({ doubleSided: true, alphaMode: "MASK", alphaCutoff: 0.25, baseColorAlpha: 0.3,
      occlusionTexture: { texture: "gltf/texture/0/occlusion", strength: 0.25 },
      emissiveFactor: [0.1, 0.2, 0.3], emissiveStrength: 8,
      emissiveTexture: { texture: "gltf/texture/0/emissive" } });
    expect(packet.textures!.map(texture => texture.semantic)).toEqual(["baseColor", "occlusion", "emissive"]);
    const prepared = prepareRenderPacket(packet);
    expect(prepared.textures.map(texture => [texture.semantic, texture.format])).toEqual([
      ["baseColor", "rgba8unorm-srgb"], ["occlusion", "rgba8unorm"], ["emissive", "rgba8unorm-srgb"],
    ]);
    expect(prepared.batches[0]).toMatchObject({ doubleSided: true, alphaMode: "MASK",
      textures: { emissiveStrength: 8, occlusion: { strength: 0.25 }, emissive: { texture: "gltf/texture/0/emissive" } } });
    expect(prepared.batches[0]!.data[29]).toBe(0.25); expect(prepared.batches[0]!.data[31]).toBe(3);
    expect(prepared.batches[0]!.data[35]).toBeCloseTo(0.3);
  });

  it("generates a real tangent basis when a normal-mapped glTF omits TANGENT", async () => {
    const bytes = changedOfficial(document => {
      (document.materials as JsonObject[])[0]!.normalTexture = { index: 0, scale: 0.5 };
    });
    const imageDecoder = decoder();
    const packet = await decodeTexturedGlb(bytes, imageDecoder);
    expect(imageDecoder.decode).toHaveBeenCalledOnce();
    expect(packet.geometries[0]!.tangents).toHaveLength(96);
    for (let index = 0; index < packet.geometries[0]!.tangents!.length; index += 4) {
      const tangent = packet.geometries[0]!.tangents!.slice(index, index + 4);
      expect(Math.hypot(tangent[0]!, tangent[1]!, tangent[2]!)).toBeCloseTo(1, 6);
      expect([-1, 1]).toContain(tangent[3]);
    }
    expect(packet.materials[0]!.normalTexture).toMatchObject({ texture: "gltf/texture/0/normal", normalScale: 0.5 });
    const prepared = prepareRenderPacket(packet);
    expect(prepared.textures.map(texture => [texture.semantic, texture.format])).toEqual([
      ["baseColor", "rgba8unorm-srgb"], ["normal", "rgba8unorm"],
    ]);
    expect(prepared.batches[0]!.textures?.normal?.normalScale).toBe(0.5);
  });

  it("honors cancellation before decode and promptly cancels a decoder that ignores the signal", async () => {
    const bytes = readFileSync(sourceUrl), before = new AbortController();
    before.abort(new Error("before-import"));
    const untouched = decoder();
    await expect(decodeTexturedGlb(bytes, untouched, { signal: before.signal })).rejects.toThrow("before-import");
    expect(untouched.decode).not.toHaveBeenCalled();

    const during = new AbortController();
    let started!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<never>(() => undefined);
    const task = decodeTexturedGlb(bytes, { decode: () => { started(); return pending; } }, { signal: during.signal });
    await didStart;
    during.abort(new Error("during-import"));
    await expect(task).rejects.toThrow("during-import");
  });

  it("wraps decoder failure, keeps source bytes owned and never publishes a partial packet", async () => {
    const bytes = readFileSync(sourceUrl), digest = createHash("sha256").update(bytes).digest("hex");
    let result: unknown;
    try {
      result = await decodeTexturedGlb(bytes, { decode: async image => {
        image.data.fill(0);
        throw new Error("broken PNG");
      } });
    } catch (error) {
      expect(error).toBeInstanceOf(GltfImportError);
      expect(error).toMatchObject({ code: "invalid", path: "images[0]" });
    }
    expect(result).toBeUndefined();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
  });
});
