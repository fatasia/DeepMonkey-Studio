import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  assertBenchmarkImage, captureWebGpuBenchmarkImage, perceptualSimilarity, summarizeBenchmarkImage,
} from "./benchmarkImage.js";

function image(foreground: number): Uint8ClampedArray<ArrayBuffer> {
  const bytes = new Uint8ClampedArray(8 * 8 * 4);
  for (let pixel = 0; pixel < 64; pixel++) bytes.set(pixel < 32
    ? [12, 16, 22, 255] : [foreground, foreground - 10, foreground - 20, 255], pixel * 4);
  return bytes;
}
function square(offset: number, value = 210): Uint8ClampedArray<ArrayBuffer> {
  const bytes = new Uint8ClampedArray(32 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const active = x >= offset && x < offset + 12 && y >= 10 && y < 22, color = active ? value : 14;
    bytes.set([color, color, color, 255], (y * 32 + x) * 4);
  }
  return bytes;
}

describe("benchmark image equivalence", () => {
  it("hashes complete readback and scores identical non-blank images", async () => {
    const first = await summarizeBenchmarkImage(8, 8, image(180));
    const second = await summarizeBenchmarkImage(8, 8, image(180));
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(perceptualSimilarity(first, second)).toBe(1);
  });

  it("fails closed on blank or differently exposed output", async () => {
    const blank = await summarizeBenchmarkImage(8, 8, new Uint8ClampedArray(8 * 8 * 4));
    const bright = await summarizeBenchmarkImage(8, 8, image(240));
    const dark = await summarizeBenchmarkImage(8, 8, image(80));
    expect(perceptualSimilarity(blank, bright)).toBe(0);
    expect(perceptualSimilarity(bright, dark)).toBeLessThan(0.65);
    expect(() => assertBenchmarkImage(blank, "three-webgpu")).toThrow("blank benchmark capture");
    expect(() => assertBenchmarkImage(bright, "three-webgpu")).not.toThrow();
  });

  it("rejects a smooth background, wrong camera and exposure drift without treating gradients as geometry", async () => {
    const gradientBytes = new Uint8ClampedArray(32 * 32 * 4);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const value = 30 + Math.floor((x + y) / 8); gradientBytes.set([value, value, value, 255], (y * 32 + x) * 4);
    }
    const gradient = await summarizeBenchmarkImage(32, 32, gradientBytes);
    const framed = await summarizeBenchmarkImage(32, 32, square(4));
    const shifted = await summarizeBenchmarkImage(32, 32, square(16));
    const exposed = await summarizeBenchmarkImage(32, 32, square(4, 90));
    expect(gradient.geometryDetailFraction).toBe(0);
    expect(() => assertBenchmarkImage(gradient, "deep-webgpu")).toThrow("blank benchmark capture");
    expect(perceptualSimilarity(framed, shifted)).toBeLessThan(0.92);
    expect(perceptualSimilarity(framed, exposed)).toBeLessThan(0.92);
  });

  it("acquires one present texture before awaiting an explicit BGRA readback", async () => {
    vi.stubGlobal("GPUBufferUsage", { COPY_DST: 1, MAP_READ: 2 }); vi.stubGlobal("GPUMapMode", { READ: 1 });
    const mapped = new ArrayBuffer(512), bytes = new Uint8Array(mapped);
    bytes.set([30, 20, 10, 255, 220, 210, 200, 255], 0);
    bytes.set([220, 210, 200, 255, 220, 210, 200, 255], 256);
    let state: GPUBufferMapState = "unmapped";
    const buffer = { mapAsync: vi.fn(async () => { state = "mapped"; }), getMappedRange: () => mapped,
      unmap: vi.fn(() => { state = "unmapped"; }), destroy: vi.fn(), get mapState() { return state; } };
    const encoder = { copyTextureToBuffer: vi.fn(), finish: vi.fn(() => ({})) };
    const context = { getCurrentTexture: vi.fn(() => ({ label: "present" })) };
    const device = { createBuffer: vi.fn(() => buffer), createCommandEncoder: vi.fn(() => encoder),
      queue: { submit: vi.fn() } };
    const pending = captureWebGpuBenchmarkImage(device as unknown as GPUDevice,
      context as unknown as GPUCanvasContext, "bgra8unorm", 2, 2);
    expect(context.getCurrentTexture).toHaveBeenCalledOnce();
    const result = await pending;
    expect(result.rgba.slice(0, 4)).toEqual(new Uint8ClampedArray([10, 20, 30, 255]));
    expect(result.geometryDetailFraction).toBeGreaterThan(0.01);
    expect(encoder.copyTextureToBuffer).toHaveBeenCalledOnce(); expect(buffer.destroy).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
