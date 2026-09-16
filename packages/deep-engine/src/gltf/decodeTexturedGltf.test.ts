import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { prepareRenderPacket } from "../renderPacket.js";
import { decodeTexturedGltf } from "./decodeTexturedGltf.js";
import { parseGlb } from "./parseGlb.js";
import { extractGltfTextureManifest } from "./textureManifest.js";
import type { GltfImageDecoder } from "./textureTypes.js";
import type { JsonObject } from "./validation.js";

const boxUrl = new URL("../../lab/assets/BoxTextured.glb", import.meta.url);
const alphaUrl = new URL("../../lab/assets/AlphaBlendModeTest.glb", import.meta.url);

function imageBytes(document: JsonObject, buffers: readonly Uint8Array[], imageIndex: number): Uint8Array {
  const image = (document.images as JsonObject[])[imageIndex]!, view = (document.bufferViews as JsonObject[])[image.bufferView as number]!;
  const source = buffers[view.buffer as number]!, offset = (view.byteOffset as number | undefined) ?? 0;
  return source.subarray(offset, offset + (view.byteLength as number));
}

function dataUriImage(document: JsonObject, buffers: readonly Uint8Array[], imageIndex: number): Uint8Array {
  const image = (document.images as JsonObject[])[imageIndex]!, bytes = imageBytes(document, buffers, imageIndex);
  image.uri = `data:${image.mimeType as string};base64,${Buffer.from(bytes).toString("base64")}`;
  delete image.bufferView; delete image.mimeType;
  return bytes;
}

function texturedGltfFixture() {
  const parsed = parseGlb(readFileSync(boxUrl));
  const document = structuredClone(parsed.json) as JsonObject, encoded = dataUriImage(document, parsed.buffers, 0);
  document.extensionsUsed = ["KHR_texture_transform"];
  const pbr = (document.materials as JsonObject[])[0]!.pbrMetallicRoughness as JsonObject;
  pbr.metallicRoughnessTexture = { index: 0, extensions: { KHR_texture_transform: {
    offset: [0.25, 0.5], scale: [2, 3], rotation: 0.125,
  } } };
  return { document, buffers: parsed.buffers, encoded };
}

describe("textured glTF Data URI import", () => {
  it("imports a real embedded PNG and keeps base color sRGB, MR linear and texture transforms", async () => {
    const source = texturedGltfFixture(), digest = createHash("sha256").update(source.encoded).digest("hex");
    expect(source.encoded).toHaveLength(3750);
    expect(digest).toBe("9c22b05c5b136d03c5621a8765e50a8322be6c35b9de53e9fe22685840d7f469");
    const decoder: GltfImageDecoder = { decode: vi.fn(async image => {
      expect(image.mimeType).toBe("image/png");
      expect(createHash("sha256").update(image.data).digest("hex")).toBe(digest);
      image.data.fill(0);
      return { width: 2, height: 1, data: new Uint8Array([12, 34, 56, 255, 78, 90, 123, 255]) };
    }) };
    const packet = await decodeTexturedGltf(source.document, source.buffers, decoder, { resourcePrefix: "data-uri" });
    expect(decoder.decode).toHaveBeenCalledOnce();
    expect(packet.geometries[0]!.uv0).toHaveLength(48);
    expect(packet.materials[0]).toMatchObject({
      baseColorTexture: { texture: "data-uri/texture/0/baseColor" },
      metallicRoughnessTexture: { texture: "data-uri/texture/0/metallicRoughness",
        offset: [0.25, 0.5], scale: [2, 3], rotation: 0.125 },
    });
    const prepared = prepareRenderPacket(packet);
    expect(prepared.textures.map(texture => [texture.semantic, texture.format])).toEqual([
      ["baseColor", "rgba8unorm-srgb"], ["metallicRoughness", "rgba8unorm"],
    ]);
    expect(createHash("sha256").update(source.encoded).digest("hex")).toBe(digest);
  });

  it("extracts the fixed upstream JPEG bytes from a Data URI without external IO", () => {
    const parsed = parseGlb(readFileSync(alphaUrl)), document = structuredClone(parsed.json) as JsonObject;
    const jpeg = dataUriImage(document, parsed.buffers, 0), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    try {
      expect(jpeg).toHaveLength(1_202_979);
      expect(createHash("sha256").update(jpeg).digest("hex")).toBe("d8891a9c08e375507ac8f1fb260577bda5e90506e79db92ebbfb5caa9216be49");
      const manifest = extractGltfTextureManifest(document, parsed.buffers);
      expect(manifest.images[0]).toMatchObject({ mimeType: "image/jpeg", data: { byteLength: jpeg.length } });
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("fails closed for external, malformed, mismatched and ambiguous image sources", () => {
    const variants = [
      { uri: "texture.png", code: "unsupported", path: "images[0].uri" },
      { uri: "data:image/png;base64,!!!!", code: "invalid", path: "images[0].uri" },
      { uri: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/jpeg", code: "invalid", path: "images[0].mimeType" },
      { uri: "data:image/png;base64,iVBORw0KGgo=", bufferView: 3, code: "invalid", path: "images[0]" },
    ];
    for (const variant of variants) {
      const source = texturedGltfFixture();
      (source.document.images as JsonObject[])[0] = variant;
      expect(() => extractGltfTextureManifest(source.document, source.buffers)).toThrow(expect.objectContaining({
        code: variant.code, path: variant.path,
      }));
    }
  });

  it("enforces encoded-image budget before decode and honors pre-cancellation", async () => {
    const source = texturedGltfFixture(), decode = vi.fn(async () => ({ width: 1, height: 1, data: new Uint8Array(4) }));
    await expect(decodeTexturedGltf(source.document, source.buffers, { decode }, {
      maxBytes: source.encoded.byteLength - 1,
    })).rejects.toMatchObject({ code: "limit", path: "images" });
    expect(decode).not.toHaveBeenCalled();

    const controller = new AbortController(); controller.abort(new Error("cancel-data-uri"));
    await expect(decodeTexturedGltf(source.document, source.buffers, { decode }, { signal: controller.signal }))
      .rejects.toThrow("cancel-data-uri");
    expect(decode).not.toHaveBeenCalled();
  });
});
