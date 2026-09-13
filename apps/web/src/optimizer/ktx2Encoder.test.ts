import { describe, expect, it } from "vitest";
import { Document } from "@gltf-transform/core";
import { compressKtx2Textures, ktx2Dimensions } from "./ktx2Encoder";

describe("offline KTX2 preparation", () => {
  it("enforces glTF block alignment without exceeding the selected texture budget", () => {
    expect(ktx2Dimensions(4097, 2049, 1024)).toEqual([1024, 512]);
    expect(ktx2Dimensions(1, 3, 512)).toEqual([4, 4]);
    expect(ktx2Dimensions(512, 512, 2048)).toEqual([512, 512]);
  });
  it("preserves compressed input bytes rather than sending them to a PNG decoder", async () => {
    const document = new Document(), bytes = new Uint8Array([0xab, 0x4b, 0x54, 0x58]);
    const texture = document.createTexture().setMimeType("image/ktx2").setImage(bytes);
    await compressKtx2Textures(document, "ktx2-etc1s", 1024);
    expect(texture.getImage()).toEqual(bytes); expect(texture.getMimeType()).toBe("image/ktx2");
  });
});
