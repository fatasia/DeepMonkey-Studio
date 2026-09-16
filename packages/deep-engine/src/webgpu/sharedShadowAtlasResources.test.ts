import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planSharedShadowAtlas, type SharedShadowAtlasPlan } from "../shadows/sharedShadowAtlas.js";
import type { DeviceSession } from "./deviceSession.js";
import { SharedShadowAtlasResources } from "./sharedShadowAtlasResources.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

interface FakeTexture extends GPUTexture {
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly createView: ReturnType<typeof vi.fn>;
}

function fixture(maxTextureDimension2D = 8192) {
  const owned = new Set<FakeTexture>(), allocated: FakeTexture[] = [];
  const checks: ReturnType<typeof deferred<GPUError | null>>[] = [];
  const descriptors: GPUTextureDescriptor[] = [], viewDescriptors: GPUTextureViewDescriptor[] = [];
  const device = {
    limits: { maxTextureDimension2D },
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => {
      const check = deferred<GPUError | null>(); checks.push(check); return check.promise;
    }),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      descriptors.push(descriptor);
      const texture = {
        destroy: vi.fn(),
        createView: vi.fn((viewDescriptor: GPUTextureViewDescriptor) => {
          viewDescriptors.push(viewDescriptor); return { viewDescriptor } as unknown as GPUTextureView;
        }),
      } as unknown as FakeTexture;
      allocated.push(texture); return texture;
    }),
  };
  const rawSession = {
    state: "ready",
    device,
    own(texture: FakeTexture) { owned.add(texture); return texture; },
    release(texture: FakeTexture) { if (owned.delete(texture)) texture.destroy(); },
  };
  const settle = (start = 0, errorAt = -1) => checks.slice(start, start + 3).forEach((check, index) =>
    check.resolve(index === errorAt ? { message: "driver rejected atlas" } as GPUError : null));
  return { session: rawSession as unknown as DeviceSession, rawSession, device, owned, allocated,
    checks, descriptors, viewDescriptors, settle };
}

const requests = [
  { key: "hero", kind: "point", importance: 5 },
  { key: "fill", kind: "spot", importance: 2 },
] as const;
const atlasPlan = (maxTextureDimension2D = 8192, maxDepthTextureBytes?: number,
  maxShadowViews = 32): SharedShadowAtlasPlan => planSharedShadowAtlas(requests,
  { maxTextureDimension2D, ...(maxDepthTextureBytes === undefined ? {} : { maxDepthTextureBytes }) },
  { maxShadowViews });

beforeEach(() => vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("shared local-light shadow atlas GPU resources", () => {
  it("creates one session-owned depth texture and exposes exact budget evidence", async () => {
    const f = fixture(), resources = new SharedShadowAtlasResources(f.session, "browser-device-1");
    const update = resources.setValidated(atlasPlan(), "browser-device-1");
    expect(resources.current).toBeUndefined();
    expect(f.device.pushErrorScope.mock.calls.map(call => call[0]))
      .toEqual(["validation", "out-of-memory", "internal"]);
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(3);
    f.settle();
    const result = await update;

    expect(result.status).toBe("allocated");
    expect(f.descriptors[0]).toEqual({
      label: "Deep shared local-light shadow atlas",
      size: { width: 4096, height: 4096, depthOrArrayLayers: 1 },
      mipLevelCount: 1, sampleCount: 1, dimension: "2d", format: "depth32float", usage: 3,
    });
    expect(f.viewDescriptors[0]).toMatchObject({ format: "depth32float", dimension: "2d",
      aspect: "depth-only", mipLevelCount: 1, arrayLayerCount: 1 });
    expect(resources.budget).toEqual({
      format: "depth32float", width: 4096, height: 4096, bytesPerDepthTexel: 4,
      allocatedDepthTextureBytes: 64 * 1024 * 1024, deviceMaxTextureDimension2D: 8192,
      tileSize: 512, guardTexels: 2, atlasViewCapacity: 64, pcfSampleCount: 4,
      maxShadowedLights: 16, maxShadowViews: 32, allocatedViewCount: 7,
      rejectedLightCount: 0, downgraded: false,
    });
    expect(result.resource.deviceEpoch).toBe("browser-device-1");
    expect(f.owned.size).toBe(1);
  });

  it("reuses the texture when only allocations and view budget change", async () => {
    const f = fixture(), resources = new SharedShadowAtlasResources(f.session, "gpu-1");
    const first = resources.setValidated(atlasPlan(), "gpu-1"); f.settle(); await first;
    const texture = resources.current!.texture;
    const result = await resources.setValidated(atlasPlan(8192, undefined, 6), "gpu-1");

    expect(result.status).toBe("reused");
    expect(result.resource.texture).toBe(texture);
    expect(result.resource.plan.allocatedViewCount).toBe(6);
    expect(result.resource.budget.maxShadowViews).toBe(6);
    expect(f.device.createTexture).toHaveBeenCalledOnce();
    expect(f.device.pushErrorScope).toHaveBeenCalledTimes(3);
  });

  it("keeps the active atlas until a changed dimension validates, then retires it", async () => {
    const f = fixture(), resources = new SharedShadowAtlasResources(f.session, "gpu-1");
    const first = resources.setValidated(atlasPlan(), "gpu-1"); f.settle(); await first;
    const active = resources.current!, replacement = resources.setValidated(
      atlasPlan(8192, 16 * 1024 * 1024), "gpu-1");

    expect(resources.current).toBe(active);
    expect(f.owned.size).toBe(2);
    expect(active.texture.destroy).not.toHaveBeenCalled();
    f.settle(3);
    expect((await replacement).resource.budget.width).toBe(2048);
    expect(resources.current).not.toBe(active);
    expect(active.texture.destroy).toHaveBeenCalledOnce();
    expect(f.owned.size).toBe(1);
  });

  it("rolls back GPU validation and synchronous view failures without replacing active", async () => {
    const f = fixture(), resources = new SharedShadowAtlasResources(f.session, "gpu-1");
    const first = resources.setValidated(atlasPlan(), "gpu-1"); f.settle(); await first;
    const active = resources.current!;
    const rejected = resources.setValidated(atlasPlan(8192, 16 * 1024 * 1024), "gpu-1");
    f.settle(3, 1);
    await expect(rejected).rejects.toThrow("driver rejected atlas");
    expect(resources.current).toBe(active);
    expect(f.allocated[1]!.destroy).toHaveBeenCalledOnce();

    f.device.createTexture.mockImplementationOnce((descriptor: GPUTextureDescriptor) => {
      f.descriptors.push(descriptor);
      const texture = { destroy: vi.fn(), createView: vi.fn(() => { throw new Error("view failed"); }) } as unknown as FakeTexture;
      f.allocated.push(texture); return texture;
    });
    await expect(resources.setValidated(atlasPlan(8192, 4 * 1024 * 1024), "gpu-1"))
      .rejects.toThrow("view failed");
    expect(resources.current).toBe(active);
    expect(f.allocated[2]!.destroy).toHaveBeenCalledOnce();
  });

  it("lets the latest dimension change win and retires superseded candidates promptly", async () => {
    const f = fixture(), resources = new SharedShadowAtlasResources(f.session, "gpu-1");
    const initial = resources.setValidated(atlasPlan(), "gpu-1"); f.settle(); await initial;
    const stale = resources.setValidated(atlasPlan(8192, 16 * 1024 * 1024), "gpu-1");
    const staleResult = expect(stale).rejects.toMatchObject({ name: "AbortError" });
    const winner = resources.setValidated(atlasPlan(8192, 4 * 1024 * 1024), "gpu-1");

    await staleResult;
    expect(f.allocated[1]!.destroy).toHaveBeenCalledOnce();
    expect(resources.current!.budget.width).toBe(4096);
    f.settle(6);
    expect((await winner).resource.budget.width).toBe(1024);
    f.settle(3); await Promise.allSettled(f.checks.map(check => check.promise));
    expect(f.allocated[0]!.destroy).toHaveBeenCalledOnce();
    expect(f.allocated[2]!.destroy).not.toHaveBeenCalled();
  });

  it("rejects stale epochs, lost sessions, and inconsistent plans before allocation", async () => {
    const f = fixture(), resources = new SharedShadowAtlasResources(f.session, "gpu-1");
    await expect(resources.setValidated(atlasPlan(), "gpu-2")).rejects.toThrow("epoch mismatch");
    const invalid = { ...atlasPlan(), estimatedDepthTextureBytes: 4 } as SharedShadowAtlasPlan;
    await expect(resources.setValidated(invalid, "gpu-1")).rejects.toThrow("depth budget");
    f.rawSession.state = "lost";
    await expect(resources.setValidated(atlasPlan(), "gpu-1")).rejects.toThrow("not ready");
    expect(f.device.createTexture).not.toHaveBeenCalled();
    expect(() => new SharedShadowAtlasResources(f.session, "bad epoch")).toThrow("not canonical");
  });

  it("does not share resources across sessions and releases active and pending atlases on dispose", async () => {
    const a = fixture(), b = fixture();
    const first = new SharedShadowAtlasResources(a.session, "gpu-a");
    const second = new SharedShadowAtlasResources(b.session, "gpu-b");
    const initialA = first.setValidated(atlasPlan(), "gpu-a"); a.settle(); await initialA;
    const initialB = second.setValidated(atlasPlan(), "gpu-b"); b.settle(); await initialB;
    expect(first.current!.texture).not.toBe(second.current!.texture);

    const pending = first.setValidated(atlasPlan(8192, 16 * 1024 * 1024), "gpu-a");
    first.dispose(); first.dispose();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(a.owned.size).toBe(0);
    expect(first.current).toBeUndefined();
    a.settle(3); await Promise.allSettled(a.checks.map(check => check.promise));
    expect(a.allocated.every(texture => texture.destroy.mock.calls.length === 1)).toBe(true);
    second.dispose(); expect(b.owned.size).toBe(0);
  });
});
