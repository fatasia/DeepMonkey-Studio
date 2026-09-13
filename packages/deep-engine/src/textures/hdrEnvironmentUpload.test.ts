import { describe, expect, it } from "vitest";
import { prepareHdrEnvironmentUpload } from "./hdrEnvironmentUpload.js";

const image = (width: number, height: number, values: readonly number[]) => ({
  width, height, data: new Float32Array(values),
});

describe("HDR environment upload packing", () => {
  it("packs RGBA16F into 256-byte aligned rows", () => {
    const result = prepareHdrEnvironmentUpload(image(2, 1, [1, 0.5, 0, 2, 4, 8]));
    expect(result.bytesPerRow).toBe(256);
    expect(result.data.slice(0, 8)).toEqual(new Uint16Array([
      0x3c00, 0x3800, 0, 0x3c00, 0x4000, 0x4400, 0x4800, 0x3c00,
    ]));
    expect(result.data.byteLength).toBe(256);
    expect(result.clampedChannels).toBe(0);
  });

  it("clamps finite highlights explicitly and reports them", () => {
    const result = prepareHdrEnvironmentUpload(image(1, 1, [70_000, 2, 3]));
    expect(result.data[0]).toBe(0x7bff);
    expect(result.clampedChannels).toBe(1);
  });

  it("rejects invalid pixels, layouts, limits, and shared input", () => {
    expect(() => prepareHdrEnvironmentUpload(image(1, 1, [-1, 0, 0]))).toThrow("invalid radiance");
    expect(() => prepareHdrEnvironmentUpload(image(1, 1, [Number.NaN, 0, 0]))).toThrow("invalid radiance");
    expect(() => prepareHdrEnvironmentUpload(image(2, 1, [1, 2, 3]))).toThrow("exact owned");
    expect(() => prepareHdrEnvironmentUpload(image(2, 1, [1, 2, 3, 4, 5, 6]), { maxBytes: 16 })).toThrow("byte limit");
    const shared = { width: 1, height: 1, data: new Float32Array(new SharedArrayBuffer(12)) };
    expect(() => prepareHdrEnvironmentUpload(shared)).toThrow("exact owned");
  });
});
