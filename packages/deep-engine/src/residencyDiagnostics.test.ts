import { describe, expect, it, vi } from "vitest";
import { ShaderDevicePipelineCachePool } from "./shaderCache/index.js";
import { buildDeepShaderPackage } from "./shaderPackage/index.js";
import { ResidencyDiagnosticsWindow } from "./residencyDiagnostics.js";

const CODE = [
  "@vertex fn vertexMain() -> @builtin(position) vec4f { return vec4f(); }",
  "@fragment fn fragmentMain() -> @location(0) vec4f { return vec4f(1); }",
].join("\n");

function shaderPackage(id: string) {
  const built = buildDeepShaderPackage({ packageId: id, packageVersion: "1.0.0",
    compilerVersion: "0.2.0", passes: [{ techniqueId: "pbr", passId: "forward", kind: "forward",
      module: { label: id, code: `${CODE}\n// ${id}` },
      entryPoints: { vertex: "vertexMain", fragment: "fragmentMain" }, pipeline: {
        passVariantId: "forward-plain", attachmentProfileId: "forward-opaque",
        alphaMode: "OPAQUE", rasterMode: "ccw",
      } }] });
  expect(built.success).toBe(true);
  return built.value!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("ResidencyDiagnosticsWindow", () => {
  it("keeps disabled cache paths from reading clocks or emitting samples", async () => {
    const recorder = new ResidencyDiagnosticsWindow(4);
    const clock = { now: vi.fn(() => 1) };
    const cache = new ShaderDevicePipelineCachePool<{ id: number }>({ namespace: "test",
      deviceEpoch: "gpu-1", diagnostics: { recorder, clock } });
    const value = shaderPackage("deep.telemetry.disabled"), pass = value.passes[0]!;
    await cache.getOrCreateAtomic({ package: value, passCacheKeys: [pass.cacheKey],
      create: async () => [{ id: 1 }] });
    await cache.getOrCreateAtomic({ package: value, passCacheKeys: [pass.cacheKey],
      create: async () => [{ id: 2 }] });
    expect(clock.now).not.toHaveBeenCalled();
    expect(recorder.snapshot()).toMatchObject({ enabled: false, generation: null,
      retainedSamples: 0, lateSamples: 0 });
  });

  it("bounds the window and reports activity, residency pressure, and warm quantiles", () => {
    const recorder = new ResidencyDiagnosticsWindow(6, true);
    recorder.beginGeneration({ generation: 1, deviceEpoch: "gpu-a" });
    const scope = { generation: 1, deviceEpoch: "gpu-a" } as const;
    recorder.record({ ...scope, kind: "timing", domain: "pipeline",
      operation: "compile", outcome: "success", durationMs: 100 });
    for (const durationMs of [5, 1, 4, 2, 3]) recorder.record({ ...scope,
      kind: "timing", domain: "pipeline", operation: "compile", outcome: "success", durationMs });
    recorder.record({ ...scope, kind: "activity", domain: "resource", activity: "evict", count: 2 });
    recorder.record({ ...scope, kind: "residency", domain: "resource", residentBytes: 90, budgetBytes: 100 });
    recorder.record({ ...scope, kind: "residency", domain: "resource", residentBytes: 70, budgetBytes: 100 });

    const snapshot = recorder.snapshot();
    expect(snapshot).toMatchObject({ retainedSamples: 6, timings: { compile: {
      coldMs: 100, warm: { samples: 3, p50Ms: 3, p95Ms: 4, p99Ms: 4 },
      outcomes: { success: 3, aborted: 0, failure: 0 },
    } } });
    expect(snapshot.domains.resource).toMatchObject({ activity: { evict: 2 },
      residentBytes: 70, peakResidentBytes: 90, budgetBytes: 100,
      budgetPressure: 0.7, peakBudgetPressure: 0.9 });
  });

  it("isolates late generations and counts abort and failure without polluting timings", () => {
    const recorder = new ResidencyDiagnosticsWindow(8, true);
    recorder.beginGeneration({ generation: 1, deviceEpoch: "gpu-a" });
    recorder.record({ kind: "timing", domain: "resource", operation: "upload",
      outcome: "success", durationMs: 8, generation: 1, deviceEpoch: "gpu-a" });
    recorder.beginGeneration({ generation: 2, deviceEpoch: "gpu-b" });
    recorder.record({ kind: "timing", domain: "resource", operation: "upload",
      outcome: "success", durationMs: 99, generation: 1, deviceEpoch: "gpu-a" });
    recorder.record({ kind: "timing", domain: "resource", operation: "upload",
      outcome: "aborted", durationMs: 2, generation: 2, deviceEpoch: "gpu-b" });
    recorder.record({ kind: "timing", domain: "resource", operation: "upload",
      outcome: "failure", durationMs: 3, generation: 2, deviceEpoch: "gpu-b" });
    expect(recorder.snapshot()).toMatchObject({ generation: 2, deviceEpoch: "gpu-b",
      retainedSamples: 2, lateSamples: 1, timings: { upload: { coldMs: null, warm: null,
        outcomes: { success: 0, aborted: 1, failure: 1 } } } });
    expect(() => recorder.beginGeneration({ generation: 1, deviceEpoch: "gpu-b" })).toThrow("backwards");
  });

  it("observes the real pipeline pool for hits, misses, in-flight reuse, compile, and eviction", async () => {
    const recorder = new ResidencyDiagnosticsWindow(32, true);
    let time = 0;
    const cache = new ShaderDevicePipelineCachePool<{ id: number }>({ namespace: "test",
      deviceEpoch: "gpu-1", maxEntries: 1, diagnostics: { recorder, clock: { now: () => time } } });
    const first = shaderPackage("deep.telemetry.first"), second = shaderPackage("deep.telemetry.second");
    const gate = deferred<readonly { id: number }[]>();
    const batch = { package: first, passCacheKeys: [first.passes[0]!.cacheKey],
      create: async () => { time = 5; return gate.promise; } };
    const one = cache.getOrCreateAtomic(batch), shared = cache.getOrCreateAtomic(batch);
    await Promise.resolve(); gate.resolve([{ id: 1 }]);
    await expect(Promise.all([one, shared])).resolves.toHaveLength(2);
    await cache.getOrCreateAtomic({ package: first, passCacheKeys: [first.passes[0]!.cacheKey],
      create: async () => [{ id: 9 }] });
    await cache.getOrCreateAtomic({ package: second, passCacheKeys: [second.passes[0]!.cacheKey],
      create: async () => { time = 7; return [{ id: 2 }]; } });

    const snapshot = recorder.snapshot();
    expect(snapshot.domains.pipeline.activity).toMatchObject({ hit: 1, miss: 3, reuse: 2, evict: 1 });
    expect(snapshot.timings.compile).toMatchObject({ coldMs: 5,
      warm: { samples: 1, p50Ms: 2, p95Ms: 2, p99Ms: 2 },
      outcomes: { success: 2, aborted: 0, failure: 0 } });
    cache.advanceDeviceEpoch("gpu-2");
    expect(recorder.snapshot()).toMatchObject({ generation: 1, deviceEpoch: "gpu-2",
      domains: { pipeline: { activity: { evict: 1 } } } });
  });
});
