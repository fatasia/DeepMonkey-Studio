import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PbrFrameReadbackPlan, PBR_FRAME_READBACK_RESOURCES, isPbrFrameReadbackSnapshot } from "./pbrFrameCaptureReadback.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(mapPending = false) {
  const lost = deferred<GPUDeviceLostInfo>();
  const buffers: Array<GPUBuffer & { bytes: Uint8Array }> = [];
  const device = { limits: { maxBufferSize: 1 << 24 }, lost: lost.promise,
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const bytes = new Uint8Array(descriptor.size as number);
      const buffer = { size: descriptor.size, usage: descriptor.usage, mapState: "unmapped", bytes,
        destroy: vi.fn(), unmap: vi.fn(() => { buffer.mapState = "unmapped"; }),
        mapAsync: vi.fn(() => mapPending ? new Promise<void>(() => {}) : Promise.resolve().then(() => { buffer.mapState = "mapped"; })),
        getMappedRange: vi.fn((offset = 0, size = bytes.byteLength) => bytes.buffer.slice(offset, offset + size)),
      } as unknown as GPUBuffer & { bytes: Uint8Array };
      buffers.push(buffer); return buffer;
    }) } as unknown as GPUDevice;
  const encoder = { copyBufferToBuffer: vi.fn(), copyTextureToBuffer: vi.fn(
    (_source: GPUImageCopyTexture, destination: GPUImageCopyBuffer, size: GPUExtent3D) => {
      const target = destination.buffer as GPUBuffer & { bytes: Uint8Array };
      const width = (size as GPUExtent3DDict).width, height = (size as GPUExtent3DDict).height;
      for (let row = 0; row < height; row++) target.bytes.fill(0x11, row * destination.bytesPerRow!, (row + 1) * destination.bytesPerRow!);
    }) } as unknown as GPUCommandEncoder;
  return { device, encoder, buffers, lost };
}

function texture(overrides: Partial<GPUTexture> = {}): GPUTexture {
  return { width: 2, height: 1, depthOrArrayLayers: 1, mipLevelCount: 1, sampleCount: 1,
    dimension: "2d", format: "rgba8unorm", usage: GPUTextureUsage.COPY_SRC, ...overrides } as GPUTexture;
}

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { COPY_SRC: 1, COPY_DST: 2, MAP_READ: 4 });
  vi.stubGlobal("GPUTextureUsage", { COPY_SRC: 1 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("pbr frame readback plan", () => {
  it("rejects empty, duplicate, and off-whitelist requests at construction", () => {
    expect(() => new PbrFrameReadbackPlan({ requests: [] })).toThrow("between one and whitelist-size");
    expect(() => new PbrFrameReadbackPlan({
      requests: [{ resourceId: "present-color" }, { resourceId: "present-color" }] })).toThrow("must not repeat");
    expect(() => new PbrFrameReadbackPlan({
      requests: [{ resourceId: "swapchain" as never }] })).toThrow("outside the fixed whitelist");
    expect(() => new PbrFrameReadbackPlan({ requests: [{ resourceId: "present-color" }],
      maxBytesPerFrame: 3 })).toThrow("byte budget");
  });

  it("collects snapshots after submit in whitelist request order", async () => {
    const f = fixture();
    const plan = new PbrFrameReadbackPlan({ requests: [{ resourceId: "opaque-hdr" }, { resourceId: "present-color" }] });
    plan.beginFrame("frame-1", f.device, f.encoder, {
      "present-color": texture(), "opaque-hdr": texture({ format: "rgba16float" }) });
    const results = await plan.collectAfterSubmit();
    expect(results.map(result => result.resourceId)).toEqual(["opaque-hdr", "present-color"]);
    for (const result of results) {
      expect(isPbrFrameReadbackSnapshot(result)).toBe(true);
      if (isPbrFrameReadbackSnapshot(result)) expect(result.frameId).toBe("frame-1");
    }
    // The plan is reusable across frames once the previous collection settled.
    plan.beginFrame("frame-2", f.device, f.encoder, { "present-color": texture(), "opaque-hdr": texture() });
    const second = await plan.collectAfterSubmit();
    expect(second.every(result => isPbrFrameReadbackSnapshot(result))).toBe(true);
  });

  it("records explicit unavailability instead of failing when a resource is absent this frame", async () => {
    const f = fixture();
    const plan = new PbrFrameReadbackPlan({ requests: [{ resourceId: "present-color" }, { resourceId: "opaque-hdr" }] });
    plan.beginFrame("frame-3", f.device, f.encoder, { "present-color": undefined, "opaque-hdr": texture() });
    const results = await plan.collectAfterSubmit();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ resourceId: "present-color", reason: "resource is absent this frame" });
    expect(isPbrFrameReadbackSnapshot(results[1]!)).toBe(true);
  });

  it("degrades non-copyable and over-budget resources to explicit reasons before allocating", async () => {
    const f = fixture();
    const plan = new PbrFrameReadbackPlan({ requests: [{ resourceId: "present-color" }, { resourceId: "opaque-hdr" }],
      maxBytesPerFrame: 1024 });
    plan.beginFrame("frame-4", f.device, f.encoder, {
      "present-color": texture({ usage: 0 }), "opaque-hdr": texture({ width: 4096, height: 4096, format: "rgba16float" }) });
    const results = await plan.collectAfterSubmit();
    expect(results[0]).toMatchObject({ resourceId: "present-color", reason: "resource lacks COPY_SRC usage this frame" });
    expect(results[1]).toMatchObject({ resourceId: "opaque-hdr", reason: "resource exceeds the remaining per-frame readback byte budget" });
    expect(f.buffers).toHaveLength(0);
  });

  it("refuses a second encode before collect and refuses collect without encode", async () => {
    const f = fixture();
    const plan = new PbrFrameReadbackPlan({ requests: [{ resourceId: "present-color" }] });
    plan.beginFrame("frame-5", f.device, f.encoder, { "present-color": texture(), "opaque-hdr": undefined });
    expect(() => plan.beginFrame("frame-6", f.device, f.encoder,
      { "present-color": texture(), "opaque-hdr": undefined })).toThrow("still open");
    const collecting = plan.collectAfterSubmit();
    // A submitted frame releases the slot so the render loop keeps encoding while maps settle.
    plan.beginFrame("frame-7", f.device, f.encoder, { "present-color": texture(), "opaque-hdr": undefined });
    await collecting;
    await expect(plan.collectAfterSubmit()).resolves.toHaveLength(1);
    expect(() => plan.collectAfterSubmit()).toThrow("no open frame");
  });

  it("cancels open tickets, releases staging once, and keeps the plan usable", async () => {
    const f = fixture(true);
    const plan = new PbrFrameReadbackPlan({ requests: [{ resourceId: "present-color" }], timeoutMs: 25 });
    plan.beginFrame("frame-8", f.device, f.encoder, { "present-color": texture(), "opaque-hdr": undefined });
    plan.cancel();
    expect(f.buffers[0]!.destroy).toHaveBeenCalledOnce();
    plan.beginFrame("frame-9", f.device, f.encoder, { "present-color": texture(), "opaque-hdr": undefined });
    const results = await plan.collectAfterSubmit();
    expect(results[0]).toMatchObject({ resourceId: "present-color", frameId: "frame-9" });
    expect(isPbrFrameReadbackSnapshot(results[0]!)).toBe(false);
    expect(f.buffers[1]!.destroy).toHaveBeenCalledOnce();
  });
});

describe("pbr frame readback whitelist", () => {
  it("stays fixed to the shipped diagnostic resources", () => {
    expect([...PBR_FRAME_READBACK_RESOURCES]).toEqual(["present-color", "opaque-hdr", "linear-depth"]);
  });

  it("snapshots single-channel depth within the shared budget", async () => {
    const f = fixture();
    const plan = new PbrFrameReadbackPlan({ requests: [{ resourceId: "linear-depth" }] });
    plan.beginFrame("depth-1", f.device, f.encoder, {
      "present-color": undefined, "opaque-hdr": undefined,
      "linear-depth": texture({ format: "r32float" }),
    });
    const results = await plan.collectAfterSubmit();
    expect(results).toHaveLength(1);
    expect(isPbrFrameReadbackSnapshot(results[0]!)).toBe(true);
    if (isPbrFrameReadbackSnapshot(results[0]!)) {
      expect(results[0]!.format).toBe("r32float");
      expect(results[0]!.bytesPerRow).toBe(results[0]!.width * 4);
    }
  });
});
