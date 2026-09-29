import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineCompileCache, pipelineCompileCacheForDevice, renderPipelineFingerprint,
  wgslSourceFingerprint } from "./pipelineCache.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const CODE_A = "fn vs() -> @builtin(position) vec4f { return vec4f(0); }";
const CODE_B = `${CODE_A}\n// changed`;
function descriptor(label: string, moduleValue: object): GPURenderPipelineDescriptor {
  return { label, layout: "auto", vertex: { module: moduleValue as GPUShaderModule, entryPoint: "vs" },
    primitive: { topology: "triangle-list" } };
}
function fixture(record: { calls: number }) {
  const moduleValue = { label: "m" };
  const device = {
    createRenderPipelineAsync: vi.fn(async (value: GPURenderPipelineDescriptor) => {
      record.calls += 1;
      return { descriptor: value } as unknown as GPURenderPipeline;
    }),
  };
  return { device: device as unknown as GPUDevice, moduleValue,
    create: () => (device.createRenderPipelineAsync as ReturnType<typeof vi.fn>)(descriptor("p", moduleValue)) };
}

describe("C26 pipeline compile fingerprint", () => {
  it("gives identical WGSL sources identical fingerprints and different sources different ones", () => {
    expect(wgslSourceFingerprint(CODE_A)).toBe(wgslSourceFingerprint("fn vs() -> @builtin(position) vec4f { return vec4f(0); }"));
    expect(wgslSourceFingerprint(CODE_A)).not.toBe(wgslSourceFingerprint(CODE_B));
    expect(wgslSourceFingerprint(CODE_A)).toMatch(/^wgsl-sha256-[0-9a-f]{64}$/);
  });

  it("changes the pipeline fingerprint when the descriptor drifts (labels, entry points, primitives)", () => {
    const moduleValue = { label: "m" };
    const base = renderPipelineFingerprint([CODE_A], descriptor("p", moduleValue));
    expect(renderPipelineFingerprint([CODE_A], descriptor("p", moduleValue))).toBe(base);
    expect(renderPipelineFingerprint([CODE_B], descriptor("p", moduleValue))).not.toBe(base);
    expect(renderPipelineFingerprint([CODE_A], descriptor("other", moduleValue))).not.toBe(base);
    const moved = { ...descriptor("p", moduleValue), primitive: { topology: "line-list" as GPUPrimitiveTopology } };
    expect(renderPipelineFingerprint([CODE_A], moved)).not.toBe(base);
  });
});

describe("C26 pipeline compile cache", () => {
  it("deduplicates concurrent creations for one fingerprint into a single device call", async () => {
    const state = { calls: 0 };
    const f = fixture(state);
    const cache = new PipelineCompileCache();
    const make = () => cache.create([CODE_A], descriptor("p", f.moduleValue), f.create);
    const [a, b] = await Promise.all([make(), make()]);
    expect(a).toBe(b);
    expect(state.calls).toBe(1);
    expect(cache.stats).toMatchObject({ entries: 1, hits: 1, misses: 1 });
  });

  it("invalidates when the WGSL source changes on the same device (no stale pipeline reuse)", async () => {
    const state = { calls: 0 };
    const f = fixture(state);
    const cache = new PipelineCompileCache();
    const first = await cache.create([CODE_A], descriptor("p", f.moduleValue), f.create);
    const second = await cache.create([CODE_B], descriptor("p", f.moduleValue), f.create);
    expect(first).not.toBe(second);
    expect(state.calls).toBe(2);
  });

  it("never shares GPU pipelines across devices (device rebuild isolation)", async () => {
    const state = { calls: 0 };
    const f = fixture(state);
    const other = fixture({ calls: 0 });
    const deviceCache = pipelineCompileCacheForDevice(f.device);
    const deviceCache2 = pipelineCompileCacheForDevice(other.device);
    const sameDescriptor = () => descriptor("p", f.moduleValue);
    const first = await deviceCache.create([CODE_A], sameDescriptor(), f.create);
    const second = await deviceCache2.create([CODE_A], sameDescriptor(), other.create);
    expect(first).not.toBe(second);
    expect(state.calls).toBe(1);
    expect(pipelineCompileCacheForDevice(f.device)).toBe(deviceCache);
  });

  it("evicts failed creations so the next attempt retries, and records the failure", async () => {
    const moduleValue = { label: "m" };
    const device = {
      createRenderPipelineAsync: vi.fn()
        .mockRejectedValueOnce(new Error("device lost mid-compile"))
        .mockResolvedValueOnce({ ok: true } as unknown as GPURenderPipeline),
    } as unknown as GPUDevice;
    const cache = new PipelineCompileCache();
    const make = () => cache.create([CODE_A], descriptor("p", moduleValue),
      () => device.createRenderPipelineAsync(descriptor("p", moduleValue)));
    await expect(make()).rejects.toThrow("device lost mid-compile");
    const retried = await make();
    expect((retried as { ok: boolean }).ok).toBe(true);
    expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(2);
    expect(cache.records.filter(record => record.failed)).toHaveLength(1);
  });

  it("emits a per-pipeline compile timing ledger with hit flags, and drains it", async () => {
    let now = 0;
    const state = { calls: 0 };
    const f = fixture(state);
    const cache = new PipelineCompileCache({ now: () => now });
    let release: ((value: GPURenderPipeline) => void) | undefined;
    const slow = cache.create([CODE_A], descriptor("slow", f.moduleValue),
      () => new Promise<GPURenderPipeline>(resolve => { release = resolve; }));
    void slow;
    now = 42;
    release!({} as GPURenderPipeline);
    await slow;
    await cache.create([CODE_A], descriptor("slow", f.moduleValue), f.create);
    const drained = cache.drainRecords();
    expect(drained).toHaveLength(2);
    expect(drained[0]).toMatchObject({ label: "slow", durationMs: 42, cacheHit: false, failed: false });
    expect(drained[1]).toMatchObject({ label: "slow", durationMs: 0, cacheHit: true });
    expect(cache.drainRecords()).toHaveLength(0);
    expect(cache.stats.entries).toBe(1);
  });

  it("explicit invalidation drops the entry; clear empties everything", async () => {
    const state = { calls: 0 };
    const f = fixture(state);
    const cache = new PipelineCompileCache();
    const fingerprint = renderPipelineFingerprint([CODE_A], descriptor("p", f.moduleValue));
    await cache.create([CODE_A], descriptor("p", f.moduleValue), f.create);
    expect(cache.invalidate(fingerprint)).toBe(true);
    expect(cache.invalidate(fingerprint)).toBe(false);
    await cache.create([CODE_A], descriptor("p", f.moduleValue), f.create);
    expect(state.calls).toBe(2);
    cache.clear();
    expect(cache.stats.entries).toBe(0);
  });
});
