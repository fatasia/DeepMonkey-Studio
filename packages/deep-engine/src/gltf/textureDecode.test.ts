import { describe, expect, it, vi } from "vitest";
import { prepareTextures } from "../textures/decodedTexture.js";
import { decodeGltfTextureManifest } from "./textureDecode.js";
import type { GltfEncodedImage, GltfImageDecoder, GltfTextureManifest, GltfTextureResource } from "./textureTypes.js";
import { GltfImportError } from "./validation.js";

const image = (): GltfEncodedImage => ({ id: "asset/image/0", imageIndex: 0, mimeType: "image/png",
  data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
const ktx2Bytes = (): Uint8Array<ArrayBuffer> => {
  const totalSize = 44, data = new Uint8Array(104 + totalSize), view = new DataView(data.buffer), dfdOffset = 104;
  data.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  view.setUint32(20, 4, true); view.setUint32(24, 4, true);
  view.setUint32(36, 1, true); view.setUint32(40, 1, true);
  view.setUint32(48, dfdOffset, true); view.setUint32(52, totalSize, true);
  view.setUint32(dfdOffset, totalSize, true); view.setUint16(dfdOffset + 8, 2, true);
  view.setUint16(dfdOffset + 10, totalSize - 4, true); view.setUint8(dfdOffset + 12, 166);
  view.setUint8(dfdOffset + 31, 3);
  return data;
};
const ktx2Image = (): GltfEncodedImage => ({ id: "asset/image/0", imageIndex: 0, mimeType: "image/ktx2",
  data: ktx2Bytes() });
const sampler = { addressModeU: "repeat", addressModeV: "repeat", magFilter: "linear", minFilter: "linear",
  mipmapFilter: "linear", maxAnisotropy: 1 } as const;
const resource = (semantic: GltfTextureResource["semantic"], changes: Partial<GltfTextureResource> = {}): GltfTextureResource => ({
  id: `asset/texture/0/${semantic}`, textureIndex: 0, image: "asset/image/0", semantic, sampler, ...changes,
});
const manifest = (): GltfTextureManifest => ({ images: [image()], resources: [resource("baseColor"), resource("metallicRoughness"), resource("normal")],
  materials: [], uvSets: [] });

describe("glTF texture host decode boundary", () => {
  it("decodes each image once, strips row padding and returns independent semantic resources", async () => {
    const pixels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 99, 99, 9, 10, 11, 12, 13, 14, 15, 16]);
    const decoder: GltfImageDecoder = { decode: vi.fn(async received => {
      received.data.fill(0); return { width: 2, height: 2, bytesPerRow: 10, data: pixels };
    }) };
    const source = manifest(), original = [...source.images[0]!.data];
    const textures = await decodeGltfTextureManifest(source, decoder);
    expect(decoder.decode).toHaveBeenCalledOnce();
    expect([...source.images[0]!.data]).toEqual(original);
    expect(textures.map(value => value.semantic)).toEqual(["baseColor", "metallicRoughness", "normal"]);
    expect(prepareTextures(textures).map(value => value.format)).toEqual(["rgba8unorm-srgb", "rgba8unorm", "rgba8unorm"]);
    expect([...textures[0]!.data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    pixels.fill(0); textures[0]!.data.fill(22);
    expect(textures[1]!.data[0]).toBe(1);
  });

  it("transcodes a BasisU image once per color space into GPU-native blocks without invoking the bitmap decoder", async () => {
    const transcode = vi.fn(async (_data, request) => ({ target: request.target,
      levels: [{ width: 4, height: 4, data: new Uint8Array(16).fill(request.colorSpace === "srgb" ? 9 : 5) }] }));
    const input = manifest(); input.images = [ktx2Image()] as never;
    const textures = await decodeGltfTextureManifest(input, undefined, {
      ktx2: { transcoder: { transcode }, supportedFeatures: ["texture-compression-bc"] },
    });
    expect(transcode).toHaveBeenCalledTimes(2);
    expect(transcode.mock.calls.map(call => call[1])).toMatchObject([
      { target: "bc7-rgba", colorSpace: "srgb", hasAlpha: true },
      { target: "bc7-rgba", colorSpace: "linear", hasAlpha: true },
    ]);
    expect(textures.map(texture => texture.compression)).toEqual(["bc7-rgba", "bc7-rgba", "bc7-rgba"]);
    expect(prepareTextures(textures).map(texture => texture.format)).toEqual([
      "bc7-rgba-unorm-srgb", "bc7-rgba-unorm", "bc7-rgba-unorm",
    ]);
    textures[0]!.data.fill(0); expect(textures[1]!.data[0]).toBe(5);
  });

  it("fails closed when a BasisU manifest has no injected transcoder", async () => {
    const input = manifest(); input.images = [ktx2Image()] as never;
    await expect(decodeGltfTextureManifest(input, { decode: vi.fn() })).rejects.toMatchObject({
      code: "unsupported", path: "images[0]", feature: "KHR_texture_basisu",
    });
  });

  it("uses an optional core image fallback when no KTX2 transcoder is configured", async () => {
    const input = manifest();
    input.images = [ktx2Image(), { ...image(), id: "asset/image/1", imageIndex: 1 }] as never;
    input.resources = input.resources.map(value => ({ ...value, fallbackImage: "asset/image/1" })) as never;
    const decode = vi.fn(async received => {
      expect(received.id).toBe("asset/image/1");
      return { width: 1, height: 1, data: new Uint8Array([10, 20, 30, 255]) };
    });
    const textures = await decodeGltfTextureManifest(input, { decode });
    expect(decode).toHaveBeenCalledOnce();
    expect(textures).toHaveLength(3);
    expect(textures[0]).toMatchObject({ width: 1, height: 1 });
    expect(textures[0]!.compression).toBeUndefined();
  });

  it("honors cancellation before and after asynchronous decode", async () => {
    const first = new AbortController(); first.abort(new Error("pre-abort"));
    const untouched = { decode: vi.fn(async () => ({ width: 1, height: 1, data: new Uint8Array(4) })) };
    await expect(decodeGltfTextureManifest(manifest(), untouched, { signal: first.signal })).rejects.toThrow("pre-abort");
    expect(untouched.decode).not.toHaveBeenCalled();
    const second = new AbortController(), decoder: GltfImageDecoder = { decode: vi.fn(async () => {
      second.abort(new Error("mid-abort")); return { width: 1, height: 1, data: new Uint8Array(4) };
    }) };
    await expect(decodeGltfTextureManifest(manifest(), decoder, { signal: second.signal })).rejects.toThrow("mid-abort");
  });

  it("returns immediately when a host decoder ignores AbortSignal and safely handles a late rejection", async () => {
    const controller = new AbortController();
    let rejectLate!: (error: Error) => void, markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const pending = new Promise<never>((_resolve, reject) => { rejectLate = reject; });
    const task = decodeGltfTextureManifest(manifest(), { decode: () => { markStarted(); return pending; } }, { signal: controller.signal });
    await started;
    controller.abort(new Error("stop-now"));
    await expect(task).rejects.toThrow("stop-now");
    rejectLate(new Error("late decoder failure"));
    await Promise.resolve();
  });

  it("wraps host decode failures with image identity", async () => {
    const decoder: GltfImageDecoder = { decode: async () => { throw new Error("corrupt PNG"); } };
    await expect(decodeGltfTextureManifest(manifest(), decoder)).rejects.toMatchObject({
      name: "GltfImportError", code: "invalid", path: "images[0]",
    });
  });

  it.each([
    [{ width: 0, height: 1, data: new Uint8Array(4) }, "width"],
    [{ width: 1, height: 2, data: new Uint8Array(4) }, "data"],
    [{ width: 1, height: 1, data: new Uint8Array(new SharedArrayBuffer(4)) }, "data"],
  ])("rejects malformed decoder output %#", async (result, path) => {
    await expect(decodeGltfTextureManifest(manifest(), { decode: async () => result })).rejects.toMatchObject({ path: expect.stringContaining(path as string) });
  });

  it("checks decoded and resource budgets", async () => {
    const decoder: GltfImageDecoder = { decode: async () => ({ width: 2, height: 2, data: new Uint8Array(16) }) };
    await expect(decodeGltfTextureManifest(manifest(), decoder, { maxBytes: 15 })).rejects.toMatchObject({ code: "limit" });
    await expect(decodeGltfTextureManifest(manifest(), decoder, { maxBytes: 32 })).rejects.toMatchObject({ code: "limit", path: "textureManifest.resources" });
    await expect(decodeGltfTextureManifest(manifest(), decoder, { maxTextures: 2 })).rejects.toMatchObject({ code: "limit" });
    await expect(decodeGltfTextureManifest(manifest(), decoder, { maxDimension: 1 })).rejects.toMatchObject({ code: "invalid" });
  });

  it("rejects duplicate identities and missing references before returning textures", async () => {
    const decoder: GltfImageDecoder = { decode: async () => ({ width: 1, height: 1, data: new Uint8Array(4) }) };
    const a = manifest(); a.images = [image(), image()] as never;
    await expect(decodeGltfTextureManifest(a, decoder)).rejects.toBeInstanceOf(GltfImportError);
    const b = manifest(); b.resources = [resource("baseColor"), resource("normal", { id: "asset/texture/0/baseColor" })] as never;
    await expect(decodeGltfTextureManifest(b, decoder)).rejects.toMatchObject({ path: expect.stringContaining("id") });
    const c = manifest(); c.resources = [resource("baseColor", { image: "missing" })] as never;
    await expect(decodeGltfTextureManifest(c, decoder)).rejects.toMatchObject({ path: expect.stringContaining("image") });
    const sparseImages = { ...manifest(), images: new Array(1) } as GltfTextureManifest;
    await expect(decodeGltfTextureManifest(sparseImages, decoder)).rejects.toMatchObject({ path: expect.stringContaining("images") });
    const sparseResources = { ...manifest(), resources: new Array(1) } as GltfTextureManifest;
    await expect(decodeGltfTextureManifest(sparseResources, decoder)).rejects.toMatchObject({ path: expect.stringContaining("resources") });
    const invalidSampler = manifest(), decode = vi.fn(decoder.decode);
    invalidSampler.resources = [resource("baseColor", { sampler: { ...sampler, maxAnisotropy: 2, minFilter: "nearest" } })] as never;
    await expect(decodeGltfTextureManifest(invalidSampler, { decode })).rejects.toMatchObject({ path: expect.stringContaining("sampler") });
    expect(decode).not.toHaveBeenCalled();
  });
});
