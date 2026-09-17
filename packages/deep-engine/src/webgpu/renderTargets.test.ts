import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { PbrTransientTexturePool, transientTextureBytes } from "./pbrTransientTexturePool.js";
import { PBR_DEPTH_FORMAT, PBR_OPAQUE_ATTACHMENT_FORMATS, RenderTargets } from "./renderTargets.js";

interface FakeTexture extends GPUTexture { readonly descriptor: GPUTextureDescriptor; readonly destroy: ReturnType<typeof vi.fn> }
function fixture() {
  const owned = new Set<FakeTexture>(), textures: FakeTexture[] = [];
  let resolveLost!: (value: GPUDeviceLostInfo) => void;
  const lost = new Promise<GPUDeviceLostInfo>(resolve => { resolveLost = resolve; });
  const device = {
    lost,
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const value = { ...descriptor, descriptor, width: (descriptor.size as GPUExtent3DDict).width,
        height: (descriptor.size as GPUExtent3DDict).height, depthOrArrayLayers: 1, dimension: "2d", mipLevelCount: 1,
        destroy: vi.fn(), createView: vi.fn(() => ({ texture: value })) } as unknown as FakeTexture;
      textures.push(value); return value;
    }),
    createSampler: vi.fn(() => ({})), createBindGroup: vi.fn(({ entries }) => ({ entries })),
  };
  const session = { state: "ready", device, own<T extends FakeTexture>(value: T) { owned.add(value); return value; },
    release(value: FakeTexture) { if (owned.delete(value)) value.destroy(); } };
  const typed = session as unknown as DeviceSession;
  const targets = new RenderTargets(typed, {} as GPUBindGroupLayout, {} as GPUBuffer,
    new PbrTransientTexturePool(typed));
  return { session, device, owned, textures, targets, resolveLost };
}

beforeEach(() => vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("PBR render targets backed by the frame transient pool", () => {
  it("uses the planned formats and reuses the same real textures after queue commit", () => {
    const f = fixture(); f.targets.beginFrame({ width: 128, height: 72 });
    const first = [...f.textures];
    expect(first).toHaveLength(5); expect(f.owned.size).toBe(5);
    expect(first.slice(0, 4).map(texture => texture.descriptor.format)).toEqual(PBR_OPAQUE_ATTACHMENT_FORMATS);
    for (const texture of first) expect(texture.descriptor).toMatchObject({ sampleCount: 1,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    expect(f.targets.depthTexture).toBe(first[4]); expect(first[4]!.descriptor.format).toBe(PBR_DEPTH_FORMAT);
    expect(f.targets.color).toBe(f.targets.hdr); expect(f.targets.hdrTexture).toBe(first[0]);
    f.targets.commitFrame();

    f.targets.beginFrame({ width: 128, height: 72 });
    expect(f.textures).toHaveLength(5); expect(f.targets.hdrTexture).toBe(first[0]);
    expect(f.targets.transientStats).toMatchObject({ acquireCount: 10, hits: 5, misses: 5,
      inFlightCount: 5, freeCount: 0 });
    f.targets.commitFrame(); f.targets.dispose(); f.targets.dispose(); expect(f.owned.size).toBe(0);
  });

  it("discards every acquired target when bind-group publication fails", () => {
    const f = fixture(); f.targets.beginFrame({ width: 16, height: 16 }); f.targets.commitFrame();
    const previous = [...f.textures];
    f.device.createBindGroup.mockImplementationOnce(() => { throw new Error("binding failed"); });
    expect(() => f.targets.beginFrame({ width: 16, height: 16 })).toThrow("binding failed");
    expect(f.owned.size).toBe(0); for (const texture of previous) expect(texture.destroy).toHaveBeenCalledOnce();
    expect(f.targets.transientStats).toMatchObject({ discardedCount: 5, freeCount: 0, frameOpen: false });
    f.targets.beginFrame({ width: 16, height: 16 });
    expect(f.textures).toHaveLength(10); expect(f.targets.hdrTexture).not.toBe(previous[0]);
    f.targets.failFrame(); expect(f.owned.size).toBe(0);
  });

  it("destroys the open production targets when frame submission fails", () => {
    const f = fixture(); f.targets.beginFrame({ width: 64, height: 32 });
    const failed = [...f.textures]; f.targets.failFrame();
    expect(f.targets.transientStats).toMatchObject({ frameOpen: false, discardedCount: 5,
      freeCount: 0, inFlightCount: 0 });
    for (const texture of failed) expect(texture.destroy).toHaveBeenCalledOnce();
    f.targets.beginFrame({ width: 64, height: 32 });
    expect(f.textures).toHaveLength(10); expect(f.targets.hdrTexture).not.toBe(failed[0]);
    f.targets.commitFrame();
  });

  it("invalidates free and in-flight targets on resize and device epoch changes", () => {
    const f = fixture(); f.targets.beginFrame({ width: 16, height: 16 }); f.targets.commitFrame();
    const first = [...f.textures];
    f.targets.beginFrame({ width: 32, height: 16 });
    for (const texture of first) expect(texture.destroy).toHaveBeenCalledOnce();
    expect(f.targets.transientStats).toMatchObject({ epoch: 1, evictedCount: 5, misses: 10, frameOpen: true });
    const resized = f.textures.slice(5); f.targets.commitFrame(); f.targets.invalidateDeviceEpoch();
    for (const texture of resized) expect(texture.destroy).toHaveBeenCalledOnce();
    expect(f.targets.transientStats).toMatchObject({ epoch: 2, evictedCount: 10, freeCount: 0 });
    f.targets.beginFrame({ width: 32, height: 16 });
    expect(f.textures).toHaveLength(15); f.targets.failFrame();
  });

  it("destroys an open frame when the production device epoch is lost", async () => {
    const f = fixture(); f.targets.beginFrame({ width: 16, height: 16 });
    f.session.state = "lost"; f.resolveLost({ reason: "unknown", message: "reset" } as GPUDeviceLostInfo);
    await Promise.resolve();
    expect(f.owned.size).toBe(0);
    expect(f.targets.transientStats).toMatchObject({ frameOpen: false, inFlightCount: 0,
      discardedCount: 5, lastInvalidation: ["device-lost", 1] });
  });

  it("reduces real allocations and estimated bytes across five submitted frames", () => {
    const f = fixture(), size = { width: 640, height: 360 };
    for (let frame = 0; frame < 5; frame++) { f.targets.beginFrame(size); f.targets.commitFrame(); }
    const perFrameBytes = PBR_OPAQUE_ATTACHMENT_FORMATS.reduce((sum, format) =>
      sum + transientTextureBytes(format, size.width, size.height, 1),
    transientTextureBytes(PBR_DEPTH_FORMAT, size.width, size.height, 1));
    expect(f.textures).toHaveLength(5);
    expect(f.targets.transientStats).toMatchObject({ acquireCount: 25, hits: 20, misses: 5,
      allocatedBytes: perFrameBytes, reusedBytes: perFrameBytes * 4, peakResidentBytes: perFrameBytes,
      freeCount: 5, inFlightCount: 0 });
    expect(f.targets.transientStats.allocatedBytes).toBeLessThan(perFrameBytes * 5);
  });
});
