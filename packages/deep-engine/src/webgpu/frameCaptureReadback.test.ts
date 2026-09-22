import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFrameCaptureBufferReadback, encodeFrameCaptureTextureReadback } from "./frameCaptureReadback.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(mapPending = false) {
  const lost = deferred<GPUDeviceLostInfo>();
  const buffers: Array<GPUBuffer & { bytes: Uint8Array; destroy: ReturnType<typeof vi.fn> }> = [];
  const device = { limits: { maxBufferSize: 1 << 20 }, lost: lost.promise,
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const bytes = new Uint8Array(descriptor.size as number);
      const buffer = { size: descriptor.size, usage: descriptor.usage, mapState: "unmapped", bytes,
        destroy: vi.fn(), unmap: vi.fn(() => { buffer.mapState = "unmapped"; }),
        mapAsync: vi.fn(() => mapPending ? new Promise<void>(() => {}) : Promise.resolve().then(() => { buffer.mapState = "mapped"; })),
        getMappedRange: vi.fn((offset = 0, size = bytes.byteLength) => bytes.buffer.slice(offset, offset + size)),
      } as unknown as GPUBuffer & { bytes: Uint8Array; destroy: ReturnType<typeof vi.fn> };
      buffers.push(buffer); return buffer;
    }) } as unknown as GPUDevice;
  const encoder = { copyBufferToBuffer: vi.fn((source: GPUBuffer & { bytes?: Uint8Array }, sourceOffset: number,
    target: GPUBuffer & { bytes: Uint8Array }, targetOffset: number, size: number) => {
    target.bytes.set(source.bytes!.subarray(sourceOffset, sourceOffset + size), targetOffset);
  }), copyTextureToBuffer: vi.fn((_source: GPUImageCopyTexture, destination: GPUImageCopyBuffer, size: GPUExtent3D) => {
    const target = destination.buffer as GPUBuffer & { bytes: Uint8Array };
    const width = (size as GPUExtent3DDict).width, height = (size as GPUExtent3DDict).height;
    for (let row = 0; row < height; row++) {
      target.bytes.fill(0xee, row * destination.bytesPerRow!, (row + 1) * destination.bytesPerRow!);
      for (let byte = 0; byte < width * 4; byte++) target.bytes[row * destination.bytesPerRow! + byte] = row * 32 + byte;
    }
  }) } as unknown as GPUCommandEncoder;
  return { device, encoder, buffers, lost };
}

function texture(overrides: Partial<GPUTexture> = {}): GPUTexture {
  return { width: 3, height: 2, depthOrArrayLayers: 1, mipLevelCount: 1, sampleCount: 1,
    dimension: "2d", format: "rgba8unorm", usage: GPUTextureUsage.COPY_SRC, ...overrides } as GPUTexture;
}

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { COPY_SRC: 1, COPY_DST: 2, MAP_READ: 4 });
  vi.stubGlobal("GPUTextureUsage", { COPY_SRC: 1 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("bounded frame capture readback", () => {
  it("reads an aligned COPY_SRC buffer once and destroys staging", async () => {
    const f = fixture();
    const source = { size: 8, usage: GPUBufferUsage.COPY_SRC, mapState: "unmapped",
      bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]) } as unknown as GPUBuffer;
    const ticket = encodeFrameCaptureBufferReadback(f.device, f.encoder,
      { frameId: "frame-1", resourceId: "buffer/main", source, byteOffset: 4, byteLength: 4 });
    await expect(ticket.readAfterSubmit()).resolves.toEqual(new Uint8Array([4, 5, 6, 7]));
    await expect(ticket.readAfterSubmit()).rejects.toThrow("only be read once");
    expect(f.buffers[0]!.destroy).toHaveBeenCalledOnce();
  });

  it("strips 256-byte texture row padding", async () => {
    const f = fixture();
    const ticket = encodeFrameCaptureTextureReadback(f.device, f.encoder,
      { frameId: "frame-2", resourceId: "color", source: texture(), width: 3, height: 2 });
    const snapshot = await ticket.readAfterSubmit();
    expect(f.buffers[0]!.size).toBe(512);
    expect(snapshot.bytesPerRow).toBe(12);
    expect([...snapshot.bytes]).toEqual([...Array.from({ length: 12 }, (_, index) => index),
      ...Array.from({ length: 12 }, (_, index) => 32 + index)]);
    expect(snapshot.bytes).not.toContain(0xee);
  });

  it("rejects unsupported, non-copyable, out-of-range, and over-budget textures before allocation", () => {
    const f = fixture();
    const request = { frameId: "frame-3", resourceId: "color", width: 3, height: 2 } as const;
    expect(() => encodeFrameCaptureTextureReadback(f.device, f.encoder,
      { ...request, source: texture({ format: "bc1-rgba-unorm" }) })).toThrow("compressed or unsupported");
    expect(() => encodeFrameCaptureTextureReadback(f.device, f.encoder,
      { ...request, source: texture({ usage: 0 }) })).toThrow("COPY_SRC");
    expect(() => encodeFrameCaptureTextureReadback(f.device, f.encoder,
      { ...request, source: texture(), width: 4 })).toThrow("exceeds its mip");
    expect(() => encodeFrameCaptureTextureReadback(f.device, f.encoder,
      { ...request, source: texture() }, { maxBytes: 128 })).toThrow("staging byte budget");
    expect(f.buffers).toHaveLength(0);
  });

  it("cancels a pending map and releases staging exactly once", async () => {
    const f = fixture(true), controller = new AbortController();
    const ticket = encodeFrameCaptureTextureReadback(f.device, f.encoder,
      { frameId: "frame-4", resourceId: "color", source: texture(), width: 3, height: 2 },
      { signal: controller.signal });
    const reading = ticket.readAfterSubmit(); controller.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(f.buffers[0]!.destroy).toHaveBeenCalledOnce(); ticket.cancel();
    expect(f.buffers[0]!.destroy).toHaveBeenCalledOnce();
  });

  it("bounds abandoned work by timeout and device loss", async () => {
    vi.useFakeTimers();
    const timed = fixture(true);
    const timeoutTicket = encodeFrameCaptureTextureReadback(timed.device, timed.encoder,
      { frameId: "frame-5", resourceId: "color", source: texture(), width: 3, height: 2 }, { timeoutMs: 5 });
    const timeoutRead = expect(timeoutTicket.readAfterSubmit()).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(5); await timeoutRead;
    const lost = fixture(true);
    const lostTicket = encodeFrameCaptureTextureReadback(lost.device, lost.encoder,
      { frameId: "frame-6", resourceId: "color", source: texture(), width: 3, height: 2 });
    const lostRead = expect(lostTicket.readAfterSubmit()).rejects.toThrow("device lost: destroyed");
    lost.lost.resolve({ reason: "destroyed", message: "gone" } as GPUDeviceLostInfo); await Promise.resolve();
    await lostRead;
    expect(lost.buffers[0]!.destroy).toHaveBeenCalledOnce();
  });
});
