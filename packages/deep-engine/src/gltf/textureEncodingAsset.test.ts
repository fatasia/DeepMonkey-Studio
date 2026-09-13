import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { prepareRenderPacket } from "../renderPacket.js";
import { decodeTexturedGlb } from "./decodeTexturedGlb.js";
import type { GltfImageDecoder } from "./textureTypes.js";

const sourceUrl = new URL("../../lab/assets/TextureEncodingTest.glb", import.meta.url);

describe("Khronos TextureEncodingTest RenderPacket import", () => {
  it("imports all primitives and synthesizes the two omitted normal streams", async () => {
    const bytes = readFileSync(sourceUrl);
    expect(bytes).toHaveLength(21_612);
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe("c2f654bdf918e3cce93db3f8d8c1b008b90d3089e756c9b38149e9306b1338f4");
    const imageDecoder: GltfImageDecoder = { decode: vi.fn(async image => ({ width: 1, height: 1,
      data: new Uint8Array([image.imageIndex, 127, 255, 255]) })) };
    const packet = await decodeTexturedGlb(bytes, imageDecoder, { resourcePrefix: "texture-encoding" });
    expect(imageDecoder.decode).toHaveBeenCalledTimes(8);
    expect(packet.geometries).toHaveLength(14);
    expect(packet.materials).toHaveLength(14);
    expect(packet.instances).toHaveLength(14);
    expect(packet.textures).toHaveLength(13);
    for (const index of [12, 13]) {
      const geometry = packet.geometries.find(value => value.id === `texture-encoding/mesh/${index}/primitive/0`)!;
      expect(geometry.vertices.length).toBeGreaterThan(0);
      for (let offset = 3; offset < geometry.vertices.length; offset += 6) {
        expect(Math.hypot(geometry.vertices[offset]!, geometry.vertices[offset + 1]!, geometry.vertices[offset + 2]!))
          .toBeCloseTo(1, 5);
      }
    }
    const prepared = prepareRenderPacket(packet);
    expect(prepared.batches).toHaveLength(14);
    expect(prepared.textures).toHaveLength(13);
  });
});
