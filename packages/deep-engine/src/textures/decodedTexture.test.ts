import { describe, expect, it } from "vitest";
import { planCompressedTextureMips, planTextureMips, prepareTextures, sameTextureContent, type DecodedTexture } from "./decodedTexture.js";

const source = (changes: Partial<DecodedTexture> = {}): DecodedTexture => ({ id: "color", revision: 0,
  semantic: "baseColor", width: 2, height: 2, data: new Uint8Array(16).fill(128), ...changes });

describe("decoded RGBA8 texture contract", () => {
  it("plans rectangular non-power-of-two mips without leaving zero dimensions", () => {
    expect(planTextureMips(7, 3)).toEqual([
      { width: 7, height: 3, bytesPerRow: 28, byteLength: 84 },
      { width: 3, height: 1, bytesPerRow: 12, byteLength: 12 },
      { width: 1, height: 1, bytesPerRow: 4, byteLength: 4 },
    ]);
    expect(planTextureMips(1, 1)).toHaveLength(1);
    expect(planTextureMips(1, 8).map(level => [level.width, level.height])).toEqual([[1, 8], [1, 4], [1, 2], [1, 1]]);
  });
  it("plans complete 4x4 compressed block footprints through sub-block mip levels", () => {
    expect(planCompressedTextureMips(8, 4, "bc7-rgba")).toEqual([
      { width: 8, height: 4, bytesPerRow: 32, byteLength: 32 },
      { width: 4, height: 2, bytesPerRow: 16, byteLength: 16 },
      { width: 2, height: 1, bytesPerRow: 16, byteLength: 16 },
      { width: 1, height: 1, bytesPerRow: 16, byteLength: 16 },
    ]);
    expect(planCompressedTextureMips(8, 4, "bc1-rgba")[0]).toEqual({ width: 8, height: 4, bytesPerRow: 16, byteLength: 16 });
    expect(() => planCompressedTextureMips(6, 5, "bc7-rgba")).toThrow("multiples of four");
  });
  it.each([0, -1, 1.5, NaN, Infinity, 16385])("rejects invalid dimension %s", width => {
    expect(() => planTextureMips(width, 1)).toThrow("width");
    expect(() => planTextureMips(1, width)).toThrow("height");
  });
  it("copies owned pixels, respects subarray offset and strips arbitrary row padding", () => {
    const backing = new Uint8Array(32).fill(77), data = backing.subarray(5, 26);
    data.set([1, 2, 3, 4, 5, 6, 7, 8], 0); data.set([9, 10, 11, 12, 13, 14, 15, 16], 13);
    const prepared = prepareTextures([source({ bytesPerRow: 13, data })])[0]!;
    expect(prepared.levels[0]!.data).toEqual(new Uint8Array(Array.from({ length: 16 }, (_, index) => index + 1)));
    expect(prepared.levels[0]!.bytesPerRow).toBe(8); expect(prepared.byteLength).toBe(16);
    backing.fill(0); expect(prepared.levels[0]!.data[0]).toBe(1);
  });
  it("accepts last-row padding while excluding it from owned data", () => {
    expect(prepareTextures([source({ bytesPerRow: 12, data: new Uint8Array(24) })])[0]!.byteLength).toBe(16);
  });
  it.each(["baseColor", "metallicRoughness", "normal", "occlusion", "emissive"] as const)("assigns %s color space without changing encoded bytes", semantic => {
    const prepared = prepareTextures([source({ semantic })])[0]!;
    expect(prepared.format).toBe(semantic === "baseColor" || semantic === "emissive" ? "rgba8unorm-srgb" : "rgba8unorm");
    expect(prepared.levels[0]!.data).toEqual(source().data);
  });
  it("preserves owned GPU block data and selects semantic-aware compressed formats", () => {
    const padded = new Uint8Array(80).fill(99);
    padded.set(new Uint8Array(32).fill(1), 0); padded.set(new Uint8Array(32).fill(2), 48);
    const color = prepareTextures([source({ width: 8, height: 8, compression: "bc7-rgba", bytesPerRow: 48, data: padded })])[0]!;
    expect(color.format).toBe("bc7-rgba-unorm-srgb");
    expect(color.requiredFeature).toBe("texture-compression-bc");
    expect(color.byteLength).toBe(64);
    expect(color.levels[0]!.data).toEqual(new Uint8Array([...new Uint8Array(32).fill(1), ...new Uint8Array(32).fill(2)]));
    padded.fill(0); expect(color.levels[0]!.data[0]).toBe(1);

    const normal = prepareTextures([source({ id: "normal", semantic: "normal", width: 4, height: 4,
      compression: "astc-4x4-rgba", data: new Uint8Array(16) })])[0]!;
    expect(normal.format).toBe("astc-4x4-unorm");
    expect(normal.requiredFeature).toBe("texture-compression-astc");
  });
  it("rejects malformed compressed block payloads before copying", () => {
    expect(() => prepareTextures([source({ width: 4, height: 4, compression: "etc2-rgba8", bytesPerRow: 17,
      data: new Uint8Array(17) })])).toThrow("texel block");
    expect(() => prepareTextures([source({ width: 4, height: 4, compression: "bc7-rgba", data: new Uint8Array(15) })]))
      .toThrow("row layout");
    expect(() => prepareTextures([source({ compression: "unknown" as DecodedTexture["compression"] })]))
      .toThrow("compression format");
  });
  it("accepts no mips or a complete chain and accounts for all levels", () => {
    expect(prepareTextures([source()])[0]!.levels).toHaveLength(1);
    const mip = { width: 1, height: 1, data: new Uint8Array(4) };
    const prepared = prepareTextures([source({ mipmaps: [mip] })])[0]!;
    expect(prepared.levels).toHaveLength(2); expect(prepared.byteLength).toBe(20);
    mip.data.fill(200); expect(prepared.levels[1]!.data[0]).toBe(0);
  });
  it("rejects incomplete, excessive and wrong-sized mip chains", () => {
    const small = { width: 1, height: 1, data: new Uint8Array(4) };
    expect(() => prepareTextures([source({ width: 4, height: 4, data: new Uint8Array(64), mipmaps: [small] })])).toThrow("complete");
    expect(() => prepareTextures([source({ mipmaps: [small, small] })])).toThrow("complete");
    expect(() => prepareTextures([source({ mipmaps: [{ ...small, width: 2 }] })])).toThrow("dimensions");
  });
  it.each([
    { id: "" }, { id: " " }, { id: "a".repeat(257) }, { revision: -1 }, { revision: 0.5 }, { revision: Infinity },
    { semantic: "srgb" }, { data: new Uint16Array(16) }, { data: new Uint8Array(15) }, { data: new Uint8Array(17) },
    { bytesPerRow: 7 }, { bytesPerRow: 8.5 }, { bytesPerRow: NaN }, { bytesPerRow: 16 }, { mipmaps: null },
  ])("rejects malformed resource %j", changes => {
    expect(() => prepareTextures([source(changes as Partial<DecodedTexture>)])).toThrow();
  });
  it("rejects shared pixels because concurrent source writes cannot produce a coherent snapshot", () => {
    expect(() => prepareTextures([source({ data: new Uint8Array(new SharedArrayBuffer(16)) })])).toThrow("unshared");
  });
  it("rejects sparse resource and mip arrays rather than publishing an incomplete snapshot", () => {
    expect(() => prepareTextures(new Array<DecodedTexture>(1))).toThrow("id");
    expect(() => prepareTextures([source({ mipmaps: new Array(1) })])).toThrow("dimensions");
  });
  it("rejects duplicate ids and enforces aggregate CPU/GPU byte and count limits", () => {
    expect(() => prepareTextures([source(), source()])).toThrow("duplicate");
    expect(() => prepareTextures([source(), source({ id: "other" })], { maxBytes: 31 })).toThrow("budget");
    expect(() => prepareTextures([source({ bytesPerRow: 12, data: new Uint8Array(24) })], { maxBytes: 20 })).toThrow("budget");
    expect(() => prepareTextures([source(), source({ id: "other" })], { maxTextures: 1 })).toThrow("count");
    expect(() => prepareTextures([source()], { maxDimension: 1 })).toThrow("width");
    expect(prepareTextures([])).toEqual([]);
  });
  it("normalizes sampling state without aliasing the caller settings", () => {
    const sampler = { addressModeU: "clamp-to-edge" as const, maxAnisotropy: 4 };
    const prepared = prepareTextures([source({ sampler })])[0]!;
    sampler.maxAnisotropy = 8;
    expect(prepared.sampler).toEqual({ addressModeU: "clamp-to-edge", addressModeV: "repeat", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 4 });
  });
  it.each([
    { addressModeU: "wrap" }, { addressModeV: "edge" }, { magFilter: "cubic" }, { minFilter: "cubic" },
    { mipmapFilter: "cubic" }, { maxAnisotropy: 0 }, { maxAnisotropy: 17 }, { maxAnisotropy: 1.5 },
    { addressModeU: null }, { maxAnisotropy: null },
    { maxAnisotropy: 4, magFilter: "nearest" }, { maxAnisotropy: 4, minFilter: "nearest" }, { maxAnisotropy: 4, mipmapFilter: "nearest" },
  ])("rejects invalid sampler %j", sampler => {
    expect(() => prepareTextures([source({ sampler: sampler as DecodedTexture["sampler"] })])).toThrow();
  });
  it("detects pixel, shape, semantic, sampler and mip changes independent of object identity", () => {
    const base = prepareTextures([source()])[0]!;
    expect(sameTextureContent(base, prepareTextures([source()])[0]!)).toBe(true);
    for (const changed of [source({ semantic: "normal" }), source({ width: 1, height: 4 }),
      source({ data: new Uint8Array(16) }), source({ sampler: { minFilter: "nearest" } }),
      source({ mipmaps: [{ width: 1, height: 1, data: new Uint8Array(4) }] })]) {
      expect(sameTextureContent(base, prepareTextures([changed])[0]!)).toBe(false);
    }
  });
});
