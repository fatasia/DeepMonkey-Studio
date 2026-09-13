import { describe, expect, it, vi } from "vitest";
import { DEEP_PBR_MESH_V1_SHA256 } from "../shaderAbi/index.js";
import { buildDeepShaderPackage } from "../shaderPackage/index.js";
import type { DeepShaderPackageV2 } from "../shaderPackage/index.js";
import { ShaderPackageContentCache } from "./contentCache.js";
import { ShaderDevicePipelineCache } from "./devicePipelineCache.js";
import type { ShaderCacheScope } from "./types.js";

const CODE = [
  "@vertex fn vertexMain() -> @builtin(position) vec4f { return vec4f(); }",
  "@fragment fn fragmentMain() -> @location(0) vec4f { return vec4f(1); }",
].join("\n");

function packageValue(id = "deep.pipeline.one"): DeepShaderPackageV2 {
  const built = buildDeepShaderPackage({
    packageId: id, packageVersion: "1.0.0", compilerVersion: "0.2.0",
    passes: [{
      techniqueId: "pbr", passId: "forward", kind: "forward",
      module: { label: id, code: `${CODE}\n// ${id}` },
      entryPoints: { vertex: "vertexMain", fragment: "fragmentMain" },
      pipeline: {
        passVariantId: "forward-plain", attachmentProfileId: "forward-opaque",
        alphaMode: "OPAQUE", rasterMode: "ccw",
      },
    }],
  });
  expect(built.success).toBe(true);
  return built.value!;
}

const SCOPE: ShaderCacheScope = Object.freeze({
  namespace: "deep.production",
  packageSchemaVersion: 2,
  targetProfile: "webgpu-wgsl-pipeline-2",
  compilerVersion: "0.2.0",
  shaderAbiId: "deep.pbr.mesh.v1",
  shaderAbiHash: DEEP_PBR_MESH_V1_SHA256,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("ShaderDevicePipelineCache", () => {
  it("deduplicates same identity creation and never publishes failed candidates", async () => {
    const value = packageValue();
    const passKey = value.passes[0]!.cacheKey;
    const gate = deferred<{ id: number }>();
    const create = vi.fn(() => gate.promise);
    const cache = new ShaderDevicePipelineCache({ scope: SCOPE, deviceEpoch: "gpu-1" });
    const a = cache.getOrCreate(value, passKey, create);
    const b = cache.getOrCreate(value, passKey, create);
    await Promise.resolve();
    expect(create).toHaveBeenCalledOnce();
    gate.resolve({ id: 1 });
    await expect(Promise.all([a, b])).resolves.toEqual([{ id: 1 }, { id: 1 }]);
    expect(cache.stats.entries).toBe(1);

    const failing = new ShaderDevicePipelineCache<{ id: number }>({ scope: SCOPE, deviceEpoch: "gpu-1" });
    await expect(failing.getOrCreate(value, passKey, async () => {
      throw new Error("driver rejected");
    })).rejects.toThrow("driver rejected");
    expect(failing.stats.entries).toBe(0);
    await expect(failing.getOrCreate(value, passKey, async () => ({ id: 2 }))).resolves.toEqual({ id: 2 });
    failing.clearDeviceLocal();
    await expect((failing as any).getOrCreate(value, passKey, async () => undefined))
      .rejects.toThrow("invalid device object");
    expect(failing.stats.entries).toBe(0);
  });

  it("strictly binds a pass to its package and complete device identity", () => {
    const value = packageValue();
    const cache = new ShaderDevicePipelineCache({ scope: SCOPE, deviceEpoch: "gpu-1" });
    const first = cache.keyFor(value, value.passes[0]!.cacheKey);
    cache.advanceDeviceEpoch("gpu-2");
    const second = cache.keyFor(value, value.passes[0]!.cacheKey);
    expect(first).not.toBe(second);
    expect(() => cache.keyFor(value, "0".repeat(64))).toThrow("does not belong");
    const wrongCompiler: any = JSON.parse(JSON.stringify(value));
    wrongCompiler.compilerVersion = "0.3.0";
    expect(() => cache.keyFor(wrongCompiler, value.passes[0]!.cacheKey)).toThrow("strict validation");
  });

  it("bounds GPU-local LRU, disposes evictions, and preserves content across epochs", async () => {
    const one = packageValue("deep.pipeline.first");
    const two = packageValue("deep.pipeline.second");
    const disposed: Array<{ id: number }> = [];
    const pipelines = new ShaderDevicePipelineCache<{ id: number }>({
      scope: SCOPE, deviceEpoch: "gpu-1", maxEntries: 1,
      dispose: (value) => disposed.push(value),
    });
    const content = new ShaderPackageContentCache({ scope: SCOPE });
    await content.put(one);
    await pipelines.getOrCreate(one, one.passes[0]!.cacheKey, async () => ({ id: 1 }));
    await pipelines.getOrCreate(two, two.passes[0]!.cacheKey, async () => ({ id: 2 }));
    expect(disposed).toEqual([{ id: 1 }]);
    expect(pipelines.stats.entries).toBe(1);

    pipelines.advanceDeviceEpoch("gpu-2");
    expect(disposed).toEqual([{ id: 1 }, { id: 2 }]);
    expect(pipelines.stats.entries).toBe(0);
    expect(content.stats.memoryEntries).toBe(1);
    expect(await content.get(one.packageCacheKey)).toEqual(one);

    const throwingDispose = new ShaderDevicePipelineCache<{ id: number }>({
      scope: SCOPE, deviceEpoch: "gpu-1", maxEntries: 1,
      dispose: () => { throw new Error("dispose failed"); },
    });
    await throwingDispose.getOrCreate(one, one.passes[0]!.cacheKey, async () => ({ id: 1 }));
    await expect(throwingDispose.getOrCreate(
      two, two.passes[0]!.cacheKey, async () => ({ id: 2 }),
    )).resolves.toEqual({ id: 2 });
    expect(() => throwingDispose.advanceDeviceEpoch("gpu-2")).not.toThrow();
  });

  it("discards a late candidate after epoch invalidation and isolates caller cancellation", async () => {
    const value = packageValue();
    const passKey = value.passes[0]!.cacheKey;
    const disposed: Array<{ id: number }> = [];
    const cache = new ShaderDevicePipelineCache<{ id: number }>({
      scope: SCOPE, deviceEpoch: "gpu-1", dispose: (item) => disposed.push(item),
    });
    const late = deferred<{ id: number }>();
    const pending = cache.getOrCreate(value, passKey, () => late.promise);
    await Promise.resolve();
    cache.advanceDeviceEpoch("gpu-2");
    const current = cache.getOrCreate(value, passKey, async () => ({ id: 2 }));
    await expect(current).resolves.toEqual({ id: 2 });
    late.resolve({ id: 1 });
    await expect(pending).rejects.toMatchObject({ code: "invalidated" });
    expect(disposed).toEqual([{ id: 1 }]);
    expect(cache.stats.entries).toBe(1);

    cache.clearDeviceLocal();

    const shared = deferred<{ id: number }>();
    let sharedSignal: AbortSignal | undefined;
    const create = vi.fn((_package, _pass, signal: AbortSignal) => {
      sharedSignal = signal;
      return shared.promise;
    });
    const canceled = new AbortController();
    const a = cache.getOrCreate(value, passKey, create, canceled.signal);
    const b = cache.getOrCreate(value, passKey, create);
    await Promise.resolve();
    canceled.abort(new Error("caller canceled"));
    await expect(a).rejects.toThrow("caller canceled");
    expect(sharedSignal?.aborted).toBe(false);
    shared.resolve({ id: 3 });
    await expect(b).resolves.toEqual({ id: 3 });
    expect(create).toHaveBeenCalledOnce();
  });

  it("prewarms only full identity allowlist entries and honors timeout", async () => {
    const one = packageValue("deep.pipeline.prewarm-one");
    const two = packageValue("deep.pipeline.prewarm-two");
    const cache = new ShaderDevicePipelineCache<{ id: number }>({ scope: SCOPE, deviceEpoch: "gpu-1" });
    const createOne = vi.fn(async () => ({ id: 1 }));
    const createTwo = vi.fn(async () => ({ id: 2 }));
    const candidates = [
      { package: one, passCacheKey: one.passes[0]!.cacheKey, create: createOne },
      { package: two, passCacheKey: two.passes[0]!.cacheKey, create: createTwo },
    ];
    const allowedKey = cache.keyFor(one, one.passes[0]!.cacheKey);
    const result = await cache.prewarm(candidates, { allowlist: [allowedKey] });
    expect(result.items.map((item) => item.status)).toEqual(["warmed", "denied"]);
    expect(createOne).toHaveBeenCalledOnce();
    expect(createTwo).not.toHaveBeenCalled();
    expect(() => cache.prewarm(candidates, { allowlist: ["partial-key"] })).toThrow("complete identity");

    vi.useFakeTimers();
    try {
      const timed = new ShaderDevicePipelineCache<{ id: number }>({ scope: SCOPE, deviceEpoch: "gpu-2" });
      const candidate = {
        package: one,
        passCacheKey: one.passes[0]!.cacheKey,
        create: async (_package: DeepShaderPackageV2, _pass: unknown, signal: AbortSignal) =>
          new Promise<{ id: number }>((_, reject) => signal.addEventListener(
            "abort", () => reject(signal.reason), { once: true },
          )),
      };
      const key = timed.keyFor(one, one.passes[0]!.cacheKey);
      const pending = timed.prewarm([candidate], { allowlist: [key], timeoutMs: 5 });
      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).resolves.toMatchObject({
        timedOut: true, aborted: true, items: [{ status: "aborted" }],
      });
      expect(timed.stats.entries).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
