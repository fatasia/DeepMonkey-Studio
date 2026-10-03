import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { PbrTransientTexturePool, transientTextureBytes } from "./pbrTransientTexturePool.js";
import { PBR_DEPTH_FORMAT, PBR_MAIN_SAMPLE_COUNT, PBR_OPAQUE_ATTACHMENT_FORMATS,
  resolvePbrMsaaSampleCount, RenderTargets } from "./renderTargets.js";

interface FakeTexture extends GPUTexture { readonly descriptor: GPUTextureDescriptor; readonly destroy: ReturnType<typeof vi.fn> }
function fixture(mainSampleCount: 1 | 4 = PBR_MAIN_SAMPLE_COUNT) {
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
    new PbrTransientTexturePool(typed), mainSampleCount);
  return { session, device, owned, textures, targets, resolveLost };
}

beforeEach(() => vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("PBR render targets backed by the frame transient pool", () => {
  it("resolves MSAA requests fail-closed to the 1/4 lattice", () => {
    expect(resolvePbrMsaaSampleCount(undefined)).toBe(PBR_MAIN_SAMPLE_COUNT);
    expect(resolvePbrMsaaSampleCount(1)).toBe(1);
    expect(resolvePbrMsaaSampleCount(4)).toBe(4);
    expect(() => resolvePbrMsaaSampleCount(2)).toThrow(RangeError);
    expect(() => resolvePbrMsaaSampleCount(8)).toThrow(RangeError);
  });

  it("default (MSAA4) builds single-sample main targets plus same-size MSAA attachments", () => {
    const f = fixture(4); f.targets.beginFrame({ width: 128, height: 72 });
    const first = [...f.textures];
    // 1x 主帧 5 张(hdr/linear-depth/view-normal/motion/depth)+ MSAA 附件 5 张。
    expect(first).toHaveLength(10); expect(f.owned.size).toBe(10);
    expect(first.slice(0, 4).map(texture => texture.descriptor.format)).toEqual(PBR_OPAQUE_ATTACHMENT_FORMATS);
    for (const texture of first.slice(0, 5)) expect(texture.descriptor).toMatchObject({ sampleCount: 1,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    expect(f.targets.depthTexture).toBe(first[4]); expect(first[4]!.descriptor.format).toBe(PBR_DEPTH_FORMAT);
    // MSAA 附件:RENDER_ATTACHMENT 语义(池侧命中 TRANSIENT 别名),深度多 TEXTURE_BINDING 供深度 resolve 采样。
    expect(f.targets.msaaActive).toBe(true);
    expect(first.slice(5, 9).map(texture => texture.descriptor.format)).toEqual(PBR_OPAQUE_ATTACHMENT_FORMATS);
    // hdr/view-normal/motion MSAA 附件:纯 RENDER_ATTACHMENT(TRANSIENT 别名);
    // linear-depth MSAA 附件多 TEXTURE_BINDING(linear-depth compute resolve 采样源)。
    for (const texture of [first[5], first[7], first[8]])
      expect(texture!.descriptor).toMatchObject({ sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    expect(first[6]!.descriptor).toMatchObject({ sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    expect(first[9]!.descriptor).toMatchObject({ format: PBR_DEPTH_FORMAT, sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    expect(f.targets.hdrMsaaTexture).toBe(first[5]); expect(f.targets.depthMsaaTexture).toBe(first[9]);
    expect(f.targets.color).toBe(f.targets.hdr); expect(f.targets.hdrTexture).toBe(first[0]);
    f.targets.commitFrame();

    f.targets.beginFrame({ width: 128, height: 72 });
    expect(f.textures).toHaveLength(10); expect(f.targets.hdrTexture).toBe(first[0]);
    expect(f.targets.hdrMsaaTexture).toBe(first[5]);
    expect(f.targets.transientStats).toMatchObject({ acquireCount: 20, hits: 10, misses: 10,
      inFlightCount: 10, freeCount: 0 });
    f.targets.commitFrame(); f.targets.dispose(); f.targets.dispose(); expect(f.owned.size).toBe(0);
  });

  it("1x renderer (capability fallback) builds the legacy five-target frame only", () => {
    const f = fixture(1); f.targets.beginFrame({ width: 128, height: 72 });
    const first = [...f.textures];
    expect(f.targets.msaaActive).toBe(false);
    expect(first).toHaveLength(5);
    for (const texture of first) expect(texture.descriptor.sampleCount).toBe(1);
    expect(f.targets.hdrMsaaTexture).toBeUndefined(); expect(f.targets.depthMsaaTexture).toBeUndefined();
    f.targets.commitFrame(); f.targets.dispose();
  });

  it("directDisplay frames skip MSAA attachment allocation while the renderer stays MSAA4", () => {
    const f = fixture(4); f.targets.beginFrame({ width: 128, height: 72 }, undefined, false, false);
    expect([...f.textures]).toHaveLength(5);
    for (const texture of f.textures) expect(texture.descriptor.sampleCount).toBe(1);
    f.targets.commitFrame();
    // 下一帧回到 HDR 主通路,MSAA 附件照常分配与复用。
    f.targets.beginFrame({ width: 128, height: 72 }, undefined, false, true);
    expect(f.textures).toHaveLength(10);
    f.targets.commitFrame(); f.targets.dispose();
  });

  it("does not allocate MRT attachments removed from the compiled live-resource plan", () => {
    const f = fixture(1);
    f.targets.beginFrame({ width: 128, height: 72 }, [
      { id: "opaque-hdr", descriptor: "rgba16float", external: false, aliasKey: "full-rgba16float",
        firstUse: 0, lastUse: 1, transientSlot: 0 },
      { id: "surface", descriptor: "swapchain", external: true, firstUse: 1, lastUse: 1 },
    ]);
    expect(f.textures.map(texture => texture.descriptor.format)).toEqual(["rgba16float", "depth32float"]);
    expect(f.targets.transientStats).toMatchObject({ acquireCount: 2, misses: 2, inFlightCount: 2 });
    f.targets.commitFrame();
  });

  it("retains the fixed MRT signature when the renderer writes geometry buffers", () => {
    const f = fixture(1);
    f.targets.beginFrame({ width: 128, height: 72 }, [
      { id: "opaque-hdr", descriptor: "rgba16float", external: false, aliasKey: "full-rgba16float",
        firstUse: 0, lastUse: 1, transientSlot: 0 },
    ], true);
    expect(f.textures.slice(0, 4).map(texture => texture.descriptor.format)).toEqual(PBR_OPAQUE_ATTACHMENT_FORMATS);
    expect(f.textures).toHaveLength(5);
    f.targets.commitFrame();
  });

  it("discards every acquired target when bind-group publication fails", () => {
    const f = fixture(1); f.targets.beginFrame({ width: 16, height: 16 }); f.targets.commitFrame();
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
    const f = fixture(1); f.targets.beginFrame({ width: 64, height: 32 });
    const failed = [...f.textures]; f.targets.failFrame();
    expect(f.targets.transientStats).toMatchObject({ frameOpen: false, discardedCount: 5,
      freeCount: 0, inFlightCount: 0 });
    for (const texture of failed) expect(texture.destroy).toHaveBeenCalledOnce();
    f.targets.beginFrame({ width: 64, height: 32 });
    expect(f.textures).toHaveLength(10); expect(f.targets.hdrTexture).not.toBe(failed[0]);
    f.targets.commitFrame();
  });

  it("invalidates free and in-flight targets on resize and device epoch changes", () => {
    const f = fixture(1); f.targets.beginFrame({ width: 16, height: 16 }); f.targets.commitFrame();
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
    const f = fixture(1); f.targets.beginFrame({ width: 16, height: 16 });
    f.session.state = "lost"; f.resolveLost({ reason: "unknown", message: "reset" } as GPUDeviceLostInfo);
    await Promise.resolve();
    expect(f.owned.size).toBe(0);
    expect(f.targets.transientStats).toMatchObject({ frameOpen: false, inFlightCount: 0,
      discardedCount: 5, lastInvalidation: ["device-lost", 1] });
  });

  it("reduces real allocations and estimated bytes across five submitted frames", () => {
    const f = fixture(1), size = { width: 640, height: 360 };
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

  it("MSAA4 frame reuses both tiers across submitted frames and prices MSAA bytes", () => {
    const f = fixture(4), size = { width: 64, height: 32 };
    for (let frame = 0; frame < 3; frame++) { f.targets.beginFrame(size); f.targets.commitFrame(); }
    const tierBytes = (samples: number): number => PBR_OPAQUE_ATTACHMENT_FORMATS.reduce((sum, format) =>
      sum + transientTextureBytes(format, size.width, size.height, samples),
    transientTextureBytes(PBR_DEPTH_FORMAT, size.width, size.height, samples));
    expect(f.textures).toHaveLength(10);
    expect(f.targets.transientStats).toMatchObject({ acquireCount: 30, hits: 20, misses: 10,
      allocatedBytes: tierBytes(1) + tierBytes(4), freeCount: 10, inFlightCount: 0 });
    f.targets.dispose();
  });
});
