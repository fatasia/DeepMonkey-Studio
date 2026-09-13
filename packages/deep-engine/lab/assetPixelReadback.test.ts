import { afterEach, describe, expect, it, vi } from "vitest";
import { readPresentationPixels } from "./assetPixelReadback.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("real asset presentation readback", () => {
  it("acquires one present texture, strips row padding and normalizes BGRA to RGBA", async () => {
    vi.stubGlobal("GPUBufferUsage", { COPY_DST: 1, MAP_READ: 2 });
    vi.stubGlobal("GPUMapMode", { READ: 1 });
    const mapped = new ArrayBuffer(512), bytes = new Uint8Array(mapped);
    bytes.set([30, 20, 10, 255, 70, 60, 50, 255], 0);
    bytes.set([110, 100, 90, 255, 150, 140, 130, 255], 256);
    let state: GPUBufferMapState = "unmapped";
    const buffer = { mapAsync: vi.fn(async () => { state = "mapped"; }), getMappedRange: () => mapped,
      unmap: vi.fn(() => { state = "unmapped"; }), destroy: vi.fn(), get mapState() { return state; } };
    const encoder = { copyTextureToBuffer: vi.fn(), finish: vi.fn(() => ({})) };
    const context = { getCurrentTexture: vi.fn(() => ({ label: "present" })) };
    const device = { createBuffer: vi.fn(() => buffer), createCommandEncoder: vi.fn(() => encoder),
      queue: { submit: vi.fn() } };
    const result = await readPresentationPixels({ device, context, format: "bgra8unorm" } as never,
      { width: 2, height: 2 } as HTMLCanvasElement);
    expect(context.getCurrentTexture).toHaveBeenCalledOnce();
    expect([...result.rgba]).toEqual([10, 20, 30, 255, 50, 60, 70, 255,
      90, 100, 110, 255, 130, 140, 150, 255]);
    expect(result.checksum).toMatch(/^[a-f0-9]{8}$/);
    expect(encoder.copyTextureToBuffer).toHaveBeenCalledWith({ texture: { label: "present" } },
      { buffer, bytesPerRow: 256, rowsPerImage: 2 }, [2, 2]);
    expect(buffer.unmap).toHaveBeenCalledOnce(); expect(buffer.destroy).toHaveBeenCalledOnce();
  });

  it("fails before allocating when the presentation surface is empty", async () => {
    const createBuffer = vi.fn();
    await expect(readPresentationPixels({ device: { createBuffer } } as never,
      { width: 0, height: 2 } as HTMLCanvasElement)).rejects.toThrow("surface is empty");
    expect(createBuffer).not.toHaveBeenCalled();
  });
});
