import { afterEach, describe, expect, it, vi } from "vitest";
import { PbrShadowState } from "./pbrShadowState.js";
import type { DeviceSession } from "./deviceSession.js";
import type { Pipelines } from "./pipelines.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(exact = true, budget = 4096 ** 2 * 4) {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 4, COPY_DST: 8 });
  const owned = new Set<{ destroy(): void }>();
  const textures: Array<{ destroy: ReturnType<typeof vi.fn>; createView: ReturnType<typeof vi.fn> }> = [];
  const drained = deferred<void>();
  const device = {
    limits: { maxTextureDimension2D: 4096, maxTextureArrayLayers: 8 },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null as GPUError | null),
    queue: { writeBuffer: vi.fn(), onSubmittedWorkDone: vi.fn(() => drained.promise) },
    createTexture: vi.fn(() => { const texture = { destroy: vi.fn(), createView: vi.fn(() => ({})) }; textures.push(texture); return texture; }),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })), createSampler: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
  };
  const session = { state: "ready", device,
    own<T extends { destroy(): void }>(resource: T) { owned.add(resource); return resource; },
    release(resource: { destroy(): void }) { if (owned.delete(resource)) resource.destroy(); } };
  const pipelines = { cascadedShadowLayout: {}, shadow: { getBindGroupLayout: () => ({}) } } as unknown as Pipelines;
  const state = new PbrShadowState(session as unknown as DeviceSession, pipelines,
    exact ? { exactProfile: { cascadeCount: 1, shadowMapSize: 1024 }, maxDepthTextureBytes: budget } : {});
  return { state, session, device, textures, owned, drained };
}
afterEach(() => vi.unstubAllGlobals());

describe("author shadow resource publication", () => {
  it("keeps the active map until GPU validation and a matching author frame, then retires after submitted work", async () => {
    const f = fixture(), validation = deferred<GPUError | null>();
    f.device.popErrorScope.mockReturnValueOnce(validation.promise);
    const old = f.state.current, activate = vi.fn(), stage = f.state.stage(2048);
    expect(f.state.current).toBe(old); expect(f.state.publish(2048, activate)).toBe(false);
    validation.resolve(null); expect(await stage).toBe("staged");
    expect(f.state.publish(1024, activate)).toBe(false); expect(f.state.publish(undefined, activate)).toBe(false);
    expect(f.state.publish(2048, activate)).toBe(true);
    expect(f.state.current.metrics.shadowMapSize).toBe(2048); expect(activate).toHaveBeenCalledOnce();
    expect(f.textures[0]!.destroy).not.toHaveBeenCalled();
    f.drained.resolve(); await f.drained.promise;
    expect(f.textures[0]!.destroy).toHaveBeenCalledOnce(); f.state.dispose(); expect(f.owned.size).toBe(0);
  });
  it("GPU rejection releases only the candidate and preserves current resources", async () => {
    const f = fixture(), old = f.state.current;
    f.device.popErrorScope.mockResolvedValueOnce({ message: "texture invalid" } as GPUError);
    await expect(f.state.stage(2048)).rejects.toThrow("texture invalid");
    expect(f.state.current).toBe(old); expect(f.textures[1]!.destroy).toHaveBeenCalledOnce();
    expect(f.state.publish(2048, vi.fn())).toBe(false); expect(f.owned.size).toBe(3); f.state.dispose();
  });
  it("validates limits and budget before allocating", async () => {
    const f = fixture();
    for (const size of [0, 63, 128.5, NaN, Infinity, 8192]) await expect(f.state.stage(size)).rejects.toThrow();
    expect(f.textures).toHaveLength(1); f.state.dispose();
    const limited = fixture(true, 1024 ** 2 * 4);
    await expect(limited.state.stage(2048)).rejects.toThrow("budget");
    expect(limited.textures).toHaveLength(1); limited.state.dispose();
  });
  it("reclaims partially constructed candidates when GPU binding creation throws", async () => {
    const f = fixture(); f.device.createBindGroup.mockImplementationOnce(() => { throw new Error("binding failed"); });
    await expect(f.state.stage(2048)).rejects.toThrow("binding failed");
    expect(f.textures[1]!.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(3);
    expect(f.device.popErrorScope).toHaveBeenCalledOnce(); f.state.dispose();
  });
  it("cancels before preparation, during validation and after staging", async () => {
    const f = fixture(), aborted = new AbortController(); aborted.abort();
    await expect(f.state.stage(2048, aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.textures).toHaveLength(1);
    const signal = new AbortController(), validation = deferred<GPUError | null>();
    f.device.popErrorScope.mockReturnValueOnce(validation.promise);
    const stage = f.state.stage(2048, signal.signal); signal.abort(); validation.resolve(null);
    expect(await stage).toBe("superseded"); expect(f.textures[1]!.destroy).toHaveBeenCalledOnce();
    const late = new AbortController(); await f.state.stage(2048, late.signal); late.abort();
    expect(f.state.publish(2048, vi.fn())).toBe(false); expect(f.textures[2]!.destroy).toHaveBeenCalledOnce();
    f.state.dispose(); expect(f.owned.size).toBe(0);
  });
  it("discards superseded preparation even if older validation resolves last", async () => {
    const f = fixture(), validation = deferred<GPUError | null>();
    f.device.popErrorScope.mockReturnValueOnce(validation.promise);
    const first = f.state.stage(2048); expect(await f.state.stage(4096)).toBe("staged");
    validation.resolve(null); expect(await first).toBe("superseded");
    expect(f.state.publish(4096, vi.fn())).toBe(true); expect(f.textures[1]!.destroy).toHaveBeenCalledOnce(); f.state.dispose();
  });
  it("binding activation failure preserves active state and releases candidate", async () => {
    const f = fixture(), old = f.state.current; await f.state.stage(2048);
    expect(() => f.state.publish(2048, () => { throw new Error("bind"); })).toThrow("bind");
    expect(f.state.current).toBe(old); expect(f.textures[1]!.destroy).toHaveBeenCalledOnce(); f.state.dispose();
  });
  it("disposal reclaims pending and in-flight resources without late publication", async () => {
    const f = fixture(), validation = deferred<GPUError | null>();
    f.device.popErrorScope.mockReturnValueOnce(validation.promise);
    const stage = f.state.stage(2048); f.state.dispose(); validation.resolve(null);
    expect(await stage).toBe("superseded"); expect(f.owned.size).toBe(0);
    await expect(f.state.stage(2048)).rejects.toThrow("unavailable");
  });
  it("refuses resizing legacy CSM profiles", async () => {
    const f = fixture(false); await expect(f.state.stage(2048)).rejects.toThrow("one-layer"); f.state.dispose();
  });
  it("releases and settles cancellation without waiting for hung GPU validation", async () => {
    const f = fixture(), validation = deferred<GPUError | null>(), controller = new AbortController();
    f.device.popErrorScope.mockReturnValueOnce(validation.promise);
    const stage = f.state.stage(2048, controller.signal);
    controller.abort();
    expect(f.textures[1]!.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(3);
    expect(await stage).toBe("superseded");
    validation.resolve({ message: "late error" } as GPUError); await validation.promise;
    expect(f.textures[1]!.destroy).toHaveBeenCalledOnce(); f.state.dispose();
  });
  it("superseding and disposing release in-flight maps synchronously", async () => {
    const f = fixture(), firstValidation = deferred<GPUError | null>(), secondValidation = deferred<GPUError | null>();
    f.device.popErrorScope.mockReturnValueOnce(firstValidation.promise).mockReturnValueOnce(secondValidation.promise);
    const first = f.state.stage(2048), second = f.state.stage(4096);
    expect(f.textures[1]!.destroy).toHaveBeenCalledOnce(); expect(await first).toBe("superseded");
    f.state.dispose(); expect(f.owned.size).toBe(0); expect(await second).toBe("superseded");
    firstValidation.resolve(null); secondValidation.resolve(null);
    await Promise.all([firstValidation.promise, secondValidation.promise]);
    expect(f.textures.every(texture => texture.destroy.mock.calls.length === 1)).toBe(true);
  });
  it("does not publish or retire after activation synchronously disposes the state", async () => {
    const f = fixture(); await f.state.stage(2048);
    expect(f.state.publish(2048, () => f.state.dispose())).toBe(false);
    expect(f.owned.size).toBe(0); expect(f.device.queue.onSubmittedWorkDone).not.toHaveBeenCalled();
  });
  it("does not publish a candidate superseded synchronously by activation", async () => {
    const f = fixture(), previous = f.state.current; await f.state.stage(2048);
    let next!: Promise<"staged" | "superseded">;
    expect(f.state.publish(2048, () => { next = f.state.stage(4096); })).toBe(false);
    expect(f.state.current).toBe(previous); expect(f.textures[1]!.destroy).toHaveBeenCalledOnce();
    expect(f.device.queue.onSubmittedWorkDone).not.toHaveBeenCalled();
    expect(await next).toBe("staged"); expect(f.state.publish(4096, vi.fn())).toBe(true); f.state.dispose();
  });
});
