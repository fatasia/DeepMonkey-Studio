import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareTextures, type DecodedTexture } from "../textures/decodedTexture.js";
import type { DeviceSession } from "./deviceSession.js";
import { TextureResources } from "./textureResources.js";

function fixture() {
  const owned = new Set<GPUTexture>(), allocated: GPUTexture[] = [];
  const device = {
    limits: { maxTextureDimension2D: 8192 },
    features: new Set<GPUFeatureName>(),
    createTexture: vi.fn((_descriptor: GPUTextureDescriptor) => {
      const texture = { destroy: vi.fn(), createView: vi.fn(() => ({} as GPUTextureView)) } as unknown as GPUTexture;
      allocated.push(texture); return texture;
    }),
    createSampler: vi.fn((_descriptor: GPUSamplerDescriptor) => ({} as GPUSampler)),
    queue: { writeTexture: vi.fn() },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve<GPUError | null>(null)),
  };
  const session = { state: "ready", device, own(texture: GPUTexture) { owned.add(texture); return texture; },
    release(texture: GPUTexture) { if (owned.delete(texture)) texture.destroy(); } };
  const cache = new TextureResources(session as unknown as DeviceSession);
  return { cache, session, device, owned, allocated };
}
const source = (changes: Partial<DecodedTexture> = {}): DecodedTexture => ({ id: "color", revision: 0,
  semantic: "baseColor", width: 2, height: 2, data: new Uint8Array(16).fill(128), ...changes });
function deferred() {
  let resolve!: (error: GPUError | null) => void;
  const promise = new Promise<GPUError | null>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("texture GPU cache transactions (fake device)", () => {
  it("keeps array-owned sources and samplers without allocating duplicate D2 storage", () => {
    const f = fixture(), prepared = prepareTextures([source()]);
    const staged = f.cache.stagePrepared(prepared, new Set(["color"]));
    expect(f.device.createTexture).not.toHaveBeenCalled();
    expect(f.device.createSampler).toHaveBeenCalledOnce();
    expect(f.cache.stagedArrayEntries(staged)).toHaveLength(1);
    expect(f.cache.stagedArrayLayer(staged, "color").sampler).toBeDefined();
    expect(() => f.cache.stagedBinding(staged, "color")).toThrow("unavailable");
    f.cache.publishPrepared(staged);
    expect(f.cache.get("color")).toBeUndefined();
    const fallback = f.cache.stagePrepared(prepared);
    expect(f.device.createTexture).toHaveBeenCalledOnce();
    f.cache.publishPrepared(fallback);
    expect(f.cache.get("color")).toBeDefined();
    f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("uploads owned compact RGBA8 once and exposes a borrowed sRGB binding", async () => {
    const f = fixture(), input = source(), result = f.cache.setValidated([input]); input.data.fill(0);
    expect(f.cache.get("color")).toBeUndefined();
    expect(await result).toBe(true);
    expect(f.device.createTexture).toHaveBeenCalledWith(expect.objectContaining({ format: "rgba8unorm-srgb", mipLevelCount: 1, usage: 6 }));
    expect(f.device.queue.writeTexture.mock.calls[0]![1]).toEqual(new Uint8Array(16).fill(128));
    expect(f.device.queue.writeTexture.mock.calls[0]![2]).toEqual({ bytesPerRow: 8, rowsPerImage: 2 });
    expect(f.cache.get("color")).toMatchObject({ width: 2, height: 2, mipLevelCount: 1, format: "rgba8unorm-srgb" });
    expect(f.cache.size).toBe(1); expect(f.cache.byteLength).toBe(16);
    expect(await f.cache.setValidated([source()])).toBe(false);
    expect(f.device.createTexture).toHaveBeenCalledTimes(1); expect(f.device.queue.writeTexture).toHaveBeenCalledTimes(1);
  });
  it("uploads compressed blocks only when the matching device feature is enabled", async () => {
    const f = fixture(), compressed = source({ width: 4, height: 4, compression: "bc7-rgba", data: new Uint8Array(16).fill(7) });
    await expect(f.cache.setValidated([compressed])).rejects.toThrow("requires unavailable device feature texture-compression-bc");
    expect(f.device.createTexture).not.toHaveBeenCalled();
    f.device.features.add("texture-compression-bc");
    expect(await f.cache.setValidated([compressed])).toBe(true);
    expect(f.device.createTexture).toHaveBeenCalledWith(expect.objectContaining({
      format: "bc7-rgba-unorm-srgb", size: { width: 4, height: 4, depthOrArrayLayers: 1 }, mipLevelCount: 1,
    }));
    expect(f.device.queue.writeTexture).toHaveBeenCalledWith(expect.objectContaining({ mipLevel: 0 }),
      new Uint8Array(16).fill(7), { bytesPerRow: 16, rowsPerImage: 1 },
      { width: 4, height: 4, depthOrArrayLayers: 1 });
  });
  it("shares samplers across textures and uploads every supplied mip exactly once", async () => {
    const f = fixture(), mipmaps = [{ width: 1, height: 1, data: new Uint8Array(4) }];
    await f.cache.setValidated([source({ mipmaps }), source({ id: "normal", semantic: "normal", mipmaps })]);
    expect(f.device.createSampler).toHaveBeenCalledTimes(1); expect(f.device.createSampler).toHaveBeenCalledWith(expect.objectContaining({ lodMaxClamp: 1 }));
    expect(f.device.queue.writeTexture.mock.calls.map(call => call[0].mipLevel)).toEqual([0, 1, 0, 1]);
    expect(f.cache.get("normal")!.format).toBe("rgba8unorm"); expect(f.cache.byteLength).toBe(40);
    expect(f.cache.get("normal")!.sampler).toBe(f.cache.get("color")!.sampler);
  });
  it("replaces only changed revisions after validation then releases orphan resources", async () => {
    const f = fixture(); await f.cache.setValidated([source(), source({ id: "normal", semantic: "normal" })]);
    const old = f.cache.get("color")!, normal = f.cache.get("normal")!;
    const pending = deferred(); f.device.popErrorScope.mockReturnValueOnce(pending.promise);
    const update = f.cache.setValidated([source({ revision: 1 }), source({ id: "normal", semantic: "normal" })]);
    expect(f.cache.get("color")).toBe(old); expect(f.owned.size).toBe(3); expect(old.texture.destroy).not.toHaveBeenCalled();
    pending.resolve(null); expect(await update).toBe(true);
    expect(f.cache.get("normal")).toBe(normal); expect(old.texture.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(2);
    expect(await f.cache.setValidated([])).toBe(true); expect(f.owned.size).toBe(0); expect(f.cache.byteLength).toBe(0);
    expect(await f.cache.setValidated([])).toBe(false);
    f.cache.dispose(); f.cache.dispose();
    for (const texture of f.allocated) expect(texture.destroy).toHaveBeenCalledOnce();
  });
  it("reuses texture storage across sampler-only revisions and uploads changed pixels", async () => {
    const f = fixture();
    expect(await f.cache.setValidated([source()])).toBe(true);
    const original = f.cache.get("color")!;
    expect(await f.cache.setValidated([source({ revision: 1,
      sampler: { addressModeU: "clamp-to-edge" } })])).toBe(true);
    const resampled = f.cache.get("color")!;
    expect(resampled).not.toBe(original);
    expect(resampled.texture).toBe(original.texture); expect(resampled.view).toBe(original.view);
    expect(resampled.sampler).not.toBe(original.sampler);
    expect(f.device.createTexture).toHaveBeenCalledTimes(1);
    expect(f.device.queue.writeTexture).toHaveBeenCalledTimes(1);
    expect(original.texture.destroy).not.toHaveBeenCalled();

    expect(await f.cache.setValidated([source({ revision: 1,
      sampler: { addressModeU: "clamp-to-edge" } })])).toBe(false);
    expect(f.cache.get("color")).toBe(resampled);
    expect(f.device.createTexture).toHaveBeenCalledTimes(1);
    expect(f.device.queue.writeTexture).toHaveBeenCalledTimes(1);

    expect(await f.cache.setValidated([source({ revision: 2, data: new Uint8Array(16).fill(7),
      sampler: { addressModeU: "clamp-to-edge" } })])).toBe(true);
    expect(f.cache.get("color")!.texture).not.toBe(original.texture);
    expect(f.device.createTexture).toHaveBeenCalledTimes(2);
    expect(f.device.queue.writeTexture).toHaveBeenCalledTimes(2);
    expect(original.texture.destroy).toHaveBeenCalledOnce();
    f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("installs replacements and attempts every retirement when a driver destroy fails", async () => {
    const f = fixture();
    await f.cache.setValidated([source(), source({ id: "normal", semantic: "normal" })]);
    const oldColor = f.cache.get("color")!, oldNormal = f.cache.get("normal")!;
    vi.mocked(oldColor.texture.destroy).mockImplementationOnce(() => { throw new Error("driver destroy failed"); });
    await expect(f.cache.setValidated([source({ revision: 1 }),
      source({ id: "normal", semantic: "normal", revision: 1 })]))
      .rejects.toThrow("Superseded texture retirement failed");
    expect(f.cache.get("color")).not.toBe(oldColor); expect(f.cache.get("normal")).not.toBe(oldNormal);
    expect(oldColor.texture.destroy).toHaveBeenCalledOnce(); expect(oldNormal.texture.destroy).toHaveBeenCalledOnce();
    expect(f.owned.size).toBe(2); f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("rejects stale or reused revisions before GPU allocations and preserves the old binding", async () => {
    const f = fixture(); await f.cache.setValidated([source({ revision: 2 })]); const old = f.cache.get("color");
    await expect(f.cache.setValidated([source({ revision: 1 })])).rejects.toThrow("Stale");
    for (const changed of [source({ revision: 2, data: new Uint8Array(16) }), source({ revision: 2, semantic: "normal" }),
      source({ revision: 2, sampler: { addressModeU: "clamp-to-edge" } })]) {
      await expect(f.cache.setValidated([source({ id: "candidate" }), changed])).rejects.toThrow("without a revision");
    }
    expect(f.device.createTexture).toHaveBeenCalledTimes(1); expect(f.cache.get("color")).toBe(old);
  });
  it("validates all source and device limits before allocating any GPU resource", async () => {
    const f = fixture(); f.device.limits.maxTextureDimension2D = 1;
    await expect(f.cache.setValidated([source()])).rejects.toThrow("width");
    expect(f.device.createTexture).not.toHaveBeenCalled(); expect(f.device.pushErrorScope).not.toHaveBeenCalled();
  });
  it.each(["create", "upload", "view", "sampler"])("rolls back a synchronous %s failure while keeping active content", async failure => {
    const f = fixture(); await f.cache.setValidated([source()]); const old = f.cache.get("color");
    if (failure === "create") f.device.createTexture.mockImplementationOnce(() => { throw new Error("failed create"); });
    if (failure === "upload") f.device.queue.writeTexture.mockImplementationOnce(() => { throw new Error("failed upload"); });
    if (failure === "sampler") f.device.createSampler.mockImplementationOnce(() => { throw new Error("failed sampler"); });
    if (failure === "view") {
      const create = f.device.createTexture.getMockImplementation()!;
      f.device.createTexture.mockImplementationOnce(descriptor => { const texture = create(descriptor); vi.mocked(texture.createView).mockImplementationOnce(() => { throw new Error("failed view"); }); return texture; });
    }
    const changed = source({ revision: 1, sampler: { minFilter: "nearest" },
      ...(failure === "sampler" ? {} : { data: new Uint8Array(16).fill(7) }) });
    await expect(f.cache.setValidated([changed])).rejects.toThrow("failed");
    expect(f.cache.get("color")).toBe(old); expect(f.owned.size).toBe(1);
    for (const texture of f.allocated.slice(1)) expect(texture.destroy).toHaveBeenCalledOnce();
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(6);
  });
  it("releases earlier candidate textures if a later upload fails", async () => {
    const f = fixture(); await f.cache.setValidated([source()]); const old = f.cache.get("color");
    f.device.queue.writeTexture.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("second upload"); });
    await expect(f.cache.setValidated([source({ revision: 1 }), source({ id: "second" })])).rejects.toThrow("second upload");
    expect(f.owned.size).toBe(1); expect(f.cache.get("color")).toBe(old);
    for (const texture of f.allocated.slice(1)) expect(texture.destroy).toHaveBeenCalledOnce();
  });
  it.each([0, 1, 2])("rolls back a GPU error returned by scope %s", async index => {
    const f = fixture(); await f.cache.setValidated([source()]); const old = f.cache.get("color");
    for (let i = 0; i < 3; i++) f.device.popErrorScope.mockResolvedValueOnce(i === index ? { message: "GPU allocation rejected" } : null);
    await expect(f.cache.setValidated([source({ revision: 1 })])).rejects.toThrow("GPU texture preparation failed: GPU allocation rejected");
    expect(f.cache.get("color")).toBe(old); expect(f.owned.size).toBe(1); expect(f.allocated[1]!.destroy).toHaveBeenCalledOnce();
  });
  it("pops all scopes before returning control to the frame and handles rejected scopes", async () => {
    const f = fixture(); f.device.popErrorScope.mockRejectedValueOnce(new Error("scope rejected"));
    const result = f.cache.setValidated([source()]);
    expect(f.device.pushErrorScope.mock.calls.map(call => call[0])).toEqual(["validation", "out-of-memory", "internal"]);
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(3);
    await expect(result).rejects.toThrow("scope rejected"); expect(f.owned.size).toBe(0);
  });
  it("cleans scopes even if push or pop throws synchronously", async () => {
    const f = fixture(); f.device.pushErrorScope.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("scope push"); });
    await expect(f.cache.setValidated([source()])).rejects.toThrow("scope push");
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(1); expect(f.device.createTexture).not.toHaveBeenCalled();
    f.device.popErrorScope.mockImplementationOnce(() => { throw new Error("scope pop"); });
    await expect(f.cache.setValidated([source()])).rejects.toThrow("scope pop");
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(4); expect(f.owned.size).toBe(0);
  });
  it("rejects pre-abort without GPU work, and abort during validation promptly releases candidates", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.cache.setValidated([source()], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.device.createTexture).not.toHaveBeenCalled();
    await f.cache.setValidated([source()]); const old = f.cache.get("color"), pending = deferred(), active = new AbortController();
    f.device.popErrorScope.mockReturnValueOnce(pending.promise);
    const update = f.cache.setValidated([source({ revision: 1 })], active.signal); active.abort();
    expect(f.owned.size).toBe(1); await expect(update).rejects.toMatchObject({ name: "AbortError" });
    expect(f.cache.get("color")).toBe(old);
    pending.resolve({ message: "late GPU rejection" }); await Promise.resolve();
    expect(f.owned.size).toBe(1); expect(f.allocated[1]!.destroy).toHaveBeenCalledOnce();
  });
  it("settles cancellation even when staged texture cleanup fails", async () => {
    const f = fixture(); await f.cache.setValidated([source()]);
    const pending = deferred(), active = new AbortController();
    f.device.popErrorScope.mockReturnValueOnce(pending.promise);
    const update = f.cache.setValidated([source({ revision: 1 })], active.signal);
    vi.mocked(f.allocated[1]!.destroy).mockImplementationOnce(() => { throw new Error("bad staged destroy"); });
    active.abort("camera changed");
    await expect(update).rejects.toMatchObject({
      message: "Texture cancellation cleanup failed.",
      errors: [expect.objectContaining({ name: "AbortError" }), expect.any(AggregateError)],
    });
    expect(f.cache.get("color")).toBeDefined(); expect(f.owned.size).toBe(1);
    pending.resolve(null); await Promise.resolve(); f.cache.dispose();
  });
  it("latest mutation wins even if the older GPU result arrives last", async () => {
    const f = fixture(); await f.cache.setValidated([source()]); const pending = deferred();
    f.device.popErrorScope.mockReturnValueOnce(pending.promise);
    const first = f.cache.setValidated([source({ revision: 1 })]); const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(await f.cache.setValidated([source({ revision: 2 })])).toBe(true); await rejected;
    const winner = f.cache.get("color"); pending.resolve(null); await Promise.resolve();
    expect(f.cache.get("color")).toBe(winner); expect(f.owned.size).toBe(1);
    expect(f.allocated[0]!.destroy).toHaveBeenCalledOnce(); expect(f.allocated[1]!.destroy).toHaveBeenCalledOnce();
  });
  it("dispose cancels a pending operation and releases active and staged textures exactly once", async () => {
    const f = fixture(); await f.cache.setValidated([source()]); const pending = deferred(); f.device.popErrorScope.mockReturnValueOnce(pending.promise);
    const update = f.cache.setValidated([source({ revision: 1 })]); f.cache.dispose(); f.cache.dispose();
    await expect(update).rejects.toMatchObject({ name: "AbortError" }); expect(f.owned.size).toBe(0); expect(f.cache.size).toBe(0);
    pending.resolve(null); await Promise.resolve();
    for (const texture of f.allocated) expect(texture.destroy).toHaveBeenCalledOnce();
    expect(() => f.cache.get("color")).toThrow("not ready"); await expect(f.cache.setValidated([])).rejects.toThrow("not ready");
  });
  it("detaches every active texture even when one destroy fails during disposal", async () => {
    const f = fixture(); await f.cache.setValidated([source(), source({ id: "normal", semantic: "normal" })]);
    vi.mocked(f.allocated[0]!.destroy).mockImplementationOnce(() => { throw new Error("bad texture destroy"); });
    expect(() => f.cache.dispose()).toThrow("Texture resource disposal failed");
    expect(f.owned.size).toBe(0); expect(f.cache.size).toBe(0);
    expect(f.allocated.every(texture => vi.mocked(texture.destroy).mock.calls.length === 1)).toBe(true);
    expect(() => f.cache.dispose()).not.toThrow();
  });
  it("rejects commits after device loss without publishing candidate resources", async () => {
    const f = fixture(), pending = deferred(); f.device.popErrorScope.mockReturnValueOnce(pending.promise);
    const update = f.cache.setValidated([source()]); f.session.state = "lost"; pending.resolve(null);
    await expect(update).rejects.toMatchObject({ name: "AbortError" }); expect(f.owned.size).toBe(0);
    await expect(f.cache.setValidated([])).rejects.toThrow("not ready"); expect(() => f.cache.get("color")).toThrow("not ready");
  });
});
