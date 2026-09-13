import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { PBR_DEPTH_FORMAT, PBR_OPAQUE_ATTACHMENT_FORMATS, RenderTargets } from "./renderTargets.js";

interface FakeTexture extends GPUTexture { readonly descriptor: GPUTextureDescriptor; readonly destroy: ReturnType<typeof vi.fn> }
function fixture() {
  const owned = new Set<FakeTexture>(), textures: FakeTexture[] = [];
  const device = {
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
  return { session: session as unknown as DeviceSession, device, owned, textures };
}

beforeEach(() => vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("PBR render targets", () => {
  it("allocates shader-readable single-sample HDR/depth/normal/motion attachments", () => {
    const f = fixture(), targets = new RenderTargets(f.session, {} as GPUBindGroupLayout, {} as GPUBuffer);
    targets.resize({ width: 128, height: 72 });
    expect(f.textures).toHaveLength(5); expect(f.owned.size).toBe(5);
    expect(f.textures.slice(0, 4).map(texture => texture.descriptor.format)).toEqual(PBR_OPAQUE_ATTACHMENT_FORMATS);
    for (const texture of f.textures.slice(0, 4)) {
      expect(texture.descriptor.sampleCount).toBe(1);
      expect(texture.descriptor.usage).toBe(GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
    }
    expect(f.textures[4]!.descriptor).toMatchObject({ format: PBR_DEPTH_FORMAT, sampleCount: 1,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    expect(targets.depthTexture).toBe(f.textures[4]);
    expect(targets.color).toBe(targets.hdr); expect(targets.hdrTexture).toBe(f.textures[0]);
    targets.resize({ width: 128, height: 72 }); expect(f.textures).toHaveLength(5);
    targets.dispose(); targets.dispose(); expect(f.owned.size).toBe(0);
  });

  it("commits resize atomically and preserves old targets when binding fails", () => {
    const f = fixture(), targets = new RenderTargets(f.session, {} as GPUBindGroupLayout, {} as GPUBuffer);
    targets.resize({ width: 16, height: 16 }); const previous = targets.hdrTexture;
    f.device.createBindGroup.mockImplementationOnce(() => { throw new Error("binding failed"); });
    expect(() => targets.resize({ width: 32, height: 32 })).toThrow("binding failed");
    expect(targets.hdrTexture).toBe(previous); expect(previous.destroy).not.toHaveBeenCalled(); expect(f.owned.size).toBe(5);
    expect(f.textures.slice(5)).toHaveLength(5); for (const texture of f.textures.slice(5)) expect(texture.destroy).toHaveBeenCalledOnce();
    targets.resize({ width: 32, height: 32 }); expect(previous.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(5);
  });
});
