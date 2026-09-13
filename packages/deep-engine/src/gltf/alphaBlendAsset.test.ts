import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { prepareRenderPacket } from "../renderPacket.js";
import { decodeTexturedGlb } from "./decodeTexturedGlb.js";
import type { GltfImageDecoder } from "./textureTypes.js";

const sourceUrl = new URL("../../lab/assets/AlphaBlendModeTest.glb", import.meta.url);

describe("Khronos AlphaBlendModeTest RenderPacket import", () => {
  it("imports every authored tangent and alpha material mode", async () => {
    const bytes = readFileSync(sourceUrl);
    expect(bytes).toHaveLength(2_978_812);
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe("37c3577d143071b42dd46e9d942b157837eb25c6340112171d7faecaa987b14e");
    const imageDecoder = { decode: vi.fn(async (image: { imageIndex: number }) => ({
      width: 1, height: 1, data: new Uint8Array([64 * image.imageIndex, 127, 255, 192]),
    })) };
    const packet = await decodeTexturedGlb(bytes, imageDecoder, { resourcePrefix: "alpha-modes" });
    expect(imageDecoder.decode).toHaveBeenCalledTimes(4);
    expect(packet.geometries).toHaveLength(9);
    expect(packet.materials).toHaveLength(6);
    expect(packet.instances).toHaveLength(9);
    // One image is intentionally reused under base-color and metallic-roughness semantics.
    expect(packet.textures).toHaveLength(5);
    expect(packet.geometries.every(geometry => geometry.tangents?.length === geometry.vertices.length / 6 * 4)).toBe(true);
    expect(packet.materials.filter(material => material.alphaMode === "BLEND")).toHaveLength(1);
    expect(packet.materials.filter(material => material.alphaMode === "MASK")).toHaveLength(3);
    const prepared = prepareRenderPacket(packet);
    expect(prepared.batches).toHaveLength(9);
    expect(prepared.batches.filter(batch => batch.alphaMode === "BLEND")).toHaveLength(2);
    expect(prepared.batches.filter(batch => batch.alphaMode === "MASK")).toHaveLength(3);
  });
});
