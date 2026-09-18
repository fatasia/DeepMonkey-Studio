import { afterEach, expect, it, vi } from "vitest";
import { browserImageDecoder } from "./browserImageDecoder";
import type { GltfEncodedImage } from "@bim-studio/deep-engine/gltf";

const source = { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" } as GltfEncodedImage;
afterEach(() => vi.unstubAllGlobals());
function fixture(context = true) {
  const close = vi.fn(), pixels = new Uint8ClampedArray([10, 20, 30, 40]);
  const bitmap = vi.fn(async () => ({ width: 1, height: 1, close }));
  vi.stubGlobal("createImageBitmap", bitmap);
  vi.stubGlobal("OffscreenCanvas", class { getContext() { return context ? {
    clearRect() {}, drawImage() {}, getImageData() { return { data: pixels }; },
  } : null; } });
  return { close, bitmap, pixels };
}
it("copies RGBA bytes with explicit decode settings and closes the bitmap", async () => {
  const f = fixture(), result = await browserImageDecoder.decode(source);
  expect(result.data).toEqual(new Uint8Array([10, 20, 30, 40]));
  f.pixels[0] = 99; expect(result.data[0]).toBe(10);
  expect(f.bitmap).toHaveBeenCalledWith(expect.any(Blob), { colorSpaceConversion: "none", imageOrientation: "none", premultiplyAlpha: "none" });
  expect(f.close).toHaveBeenCalledTimes(1);
});
it("closes the bitmap when the pixel context is unavailable", async () => {
  const f = fixture(false);
  await expect(browserImageDecoder.decode(source)).rejects.toThrow(/上下文/);
  expect(f.close).toHaveBeenCalledTimes(1);
});
it("rejects cancellation after bitmap decoding and releases the bitmap", async () => {
  const f = fixture(), controller = new AbortController();
  f.bitmap.mockImplementation(async () => { controller.abort(); return { width: 1, height: 1, close: f.close }; });
  await expect(browserImageDecoder.decode(source, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(f.close).toHaveBeenCalledTimes(1);
  await expect(browserImageDecoder.decode(source, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(f.bitmap).toHaveBeenCalledTimes(1);
});
