import { expect, it, vi } from "vitest";
import { createBrowserImageDecoder } from "./browserImageDecoder.js";
import type { GltfEncodedImage } from "../gltf/textureTypes.js";

const source: GltfEncodedImage = { id: "image", imageIndex: 0, data: new Uint8Array([1, 2, 3]), mimeType: "image/png" };
function fixture() {
  const bitmap = { width: 1, height: 1, close: vi.fn() };
  const pixels = new Uint8ClampedArray([10, 20, 30, 40]);
  const host = { decode: vi.fn(async (_image: GltfEncodedImage) => bitmap), readPixels: vi.fn(() => pixels) };
  return { bitmap, pixels, host, decoder: createBrowserImageDecoder(host) };
}
it("owns input and output bytes without reading browser globals", async () => {
  const f = fixture();
  const result = await f.decoder.decode(source);
  expect(f.host.decode.mock.calls[0][0]).toEqual(source);
  expect(f.host.decode.mock.calls[0][0].data).not.toBe(source.data);
  f.pixels[0] = 99;
  expect(result).toEqual({ width: 1, height: 1, data: new Uint8Array([10, 20, 30, 40]) });
  expect(f.bitmap.close).toHaveBeenCalledTimes(1);
});
it("rejects before calling a host for an aborted request", async () => {
  const f = fixture(), controller = new AbortController();
  controller.abort();
  await expect(f.decoder.decode(source, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(f.host.decode).not.toHaveBeenCalled();
});
it("releases a late bitmap after cancellation without reading pixels", async () => {
  const f = fixture(), controller = new AbortController();
  f.host.decode.mockImplementation(async () => { controller.abort(); return f.bitmap; });
  await expect(f.decoder.decode(source, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(f.host.readPixels).not.toHaveBeenCalled();
  expect(f.bitmap.close).toHaveBeenCalledTimes(1);
});
it("releases the bitmap when pixel reading fails", async () => {
  const f = fixture();
  f.host.readPixels.mockImplementation(() => { throw new Error("pixel read failed"); });
  await expect(f.decoder.decode(source)).rejects.toThrow("pixel read failed");
  expect(f.bitmap.close).toHaveBeenCalledTimes(1);
});
it("releases the bitmap when cancellation occurs during pixel reading", async () => {
  const f = fixture(), controller = new AbortController();
  f.host.readPixels.mockImplementation(() => { controller.abort(); return f.pixels; });
  await expect(f.decoder.decode(source, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(f.bitmap.close).toHaveBeenCalledTimes(1);
});
it("propagates decoding failures without attempting pixel reads", async () => {
  const f = fixture();
  f.host.decode.mockRejectedValue(new Error("unsupported image"));
  await expect(f.decoder.decode(source)).rejects.toThrow("unsupported image");
  expect(f.host.readPixels).not.toHaveBeenCalled();
  expect(f.bitmap.close).not.toHaveBeenCalled();
});
