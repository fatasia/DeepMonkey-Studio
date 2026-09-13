import { describe, expect, it } from "vitest";
import { decodeRadianceHdr } from "./radianceHdr.js";

const ascii = (value: string): number[] => Array.from(value, character => character.charCodeAt(0));
const file = (resolution: string, payload: readonly number[], format = "32-bit_rle_rgbe"): Uint8Array => new Uint8Array([
  ...ascii(`#?RADIANCE\nFORMAT=${format}\n\n${resolution}\n`), ...payload,
]);
const close = (value: Float32Array): number[] => Array.from(value, item => Number(item.toFixed(6)));

describe("Radiance HDR decoder", () => {
  it("decodes modern channel RLE and maps the common top-left orientation", () => {
    const scanline = (red: number): number[] => [2, 2, 0, 8,
      136, red, 136, 64, 136, 32, 136, 129];
    const decoded = decodeRadianceHdr(file("-Y 2 +X 8", [...scanline(128), ...scanline(32)]));
    expect([decoded.width, decoded.height]).toEqual([8, 2]);
    expect(close(decoded.data.slice(0, 3))).toEqual([1, 0.5, 0.25]);
    expect(close(decoded.data.slice(8 * 3, 8 * 3 + 3))).toEqual([0.25, 0.5, 0.25]);
  });

  it("supports literal packets and both-axis orientation without transposing output", () => {
    const payload = [2, 2, 0, 8,
      8, 1, 2, 3, 4, 5, 6, 7, 8,
      136, 0, 136, 0, 136, 129];
    const decoded = decodeRadianceHdr(file("+X 1 +Y 8", payload));
    expect([decoded.width, decoded.height]).toEqual([1, 8]);
    expect(close(decoded.data.slice(0, 3))).toEqual([0.0625, 0, 0]);
    expect(close(decoded.data.slice(7 * 3, 7 * 3 + 3))).toEqual([0.007813, 0, 0]);
  });

  it("decodes flat pixels and legacy repeated-pixel packets", () => {
    const decoded = decodeRadianceHdr(file("-Y 1 +X 4", [128, 64, 32, 129, 1, 1, 1, 3]));
    expect([decoded.width, decoded.height]).toEqual([4, 1]);
    expect(close(decoded.data)).toEqual([
      1, 0.5, 0.25, 1, 0.5, 0.25, 1, 0.5, 0.25, 1, 0.5, 0.25,
    ]);
  });

  it("decodes a multi-byte legacy run count", () => {
    const decoded = decodeRadianceHdr(file("-Y 1 +X 257", [128, 64, 32, 129,
      1, 1, 1, 0, 1, 1, 1, 1]));
    expect(decoded.data.length).toBe(257 * 3);
    expect(close(decoded.data.slice(-3))).toEqual([1, 0.5, 0.25]);
  });

  it.each([
    ["-Y 2 +X 3", [1, 2, 3, 4, 5, 6]],
    ["-Y 2 -X 3", [3, 2, 1, 6, 5, 4]],
    ["+Y 2 +X 3", [4, 5, 6, 1, 2, 3]],
    ["+Y 2 -X 3", [6, 5, 4, 3, 2, 1]],
    ["+X 3 -Y 2", [1, 4, 2, 5, 3, 6]],
    ["-X 3 -Y 2", [3, 6, 2, 5, 1, 4]],
    ["+X 3 +Y 2", [4, 1, 5, 2, 6, 3]],
    ["-X 3 +Y 2", [6, 3, 5, 2, 4, 1]],
  ] as const)("normalizes %s into top-left row-major pixels", (resolution, sourceOrder) => {
    const payload = sourceOrder.flatMap(red => [red, 0, 0, 136]);
    const decoded = decodeRadianceHdr(file(resolution, payload));
    expect([decoded.width, decoded.height]).toEqual([3, 2]);
    expect(Array.from(decoded.data.filter((_, index) => index % 3 === 0))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rejects invalid headers, dimensions, and malformed RLE", () => {
    expect(() => decodeRadianceHdr(file("-Y 1 +X 1", [0, 0, 0, 0], "other"))).toThrow("requires");
    expect(() => decodeRadianceHdr(file("-Y 3 +X 3", Array(36).fill(0)), { maxPixels: 8 })).toThrow("dimensions");
    expect(() => decodeRadianceHdr(file("-Y 1 +X 8", [2, 2, 0, 8, 137, 1]))).toThrow("exceeds");
    expect(() => decodeRadianceHdr(file("-Y 1 +X 8", [2, 2, 0, 8, 0]))).toThrow("invalid");
  });

  it("requires unshared, complete input and a single format declaration", () => {
    expect(() => decodeRadianceHdr(new Uint8Array())).toThrow("owned nonempty");
    expect(() => decodeRadianceHdr(new Uint8Array(ascii("#?RADIANCE")))).toThrow("truncated");
    const duplicate = new Uint8Array([...ascii("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n"), 0, 0, 0, 0]);
    expect(() => decodeRadianceHdr(duplicate)).toThrow("multiple");
  });
});
