import { describe, expect, it, vi } from "vitest";
import { DEEP_PBR_MESH_V1_SHA256 } from "../shaderAbi/index.js";
import { buildDeepShaderPackage } from "../shaderPackage/index.js";
import type { DeepShaderPackageV2, ShaderPackagePassBuildInput } from "../shaderPackage/index.js";
import { ShaderPackageContentCache } from "./contentCache.js";
import { shaderCacheIdentity, shaderPackageStoreKey } from "./identity.js";
import type {
  ShaderCacheScope, ShaderPackageCacheRecord, ShaderPackageCacheStore,
} from "./types.js";

const CODE = [
  "@vertex fn vertexMain() -> @builtin(position) vec4f { return vec4f(); }",
  "@fragment fn fragmentMain() -> @location(0) vec4f { return vec4f(1); }",
].join("\n");

function pass(code = CODE): ShaderPackagePassBuildInput {
  return {
    techniqueId: "pbr", passId: "forward", kind: "forward",
    module: { label: "cache-test", code },
    entryPoints: { vertex: "vertexMain", fragment: "fragmentMain" },
    pipeline: {
      passVariantId: "forward-plain", attachmentProfileId: "forward-opaque",
      alphaMode: "OPAQUE", rasterMode: "ccw",
    },
  };
}

function packageValue(id = "deep.cache.one", compilerVersion = "0.2.0"): DeepShaderPackageV2 {
  const result = buildDeepShaderPackage({
    packageId: id, packageVersion: "1.0.0", compilerVersion, passes: [pass(`${CODE}\n// ${id}`)],
  });
  expect(result.success).toBe(true);
  return result.value!;
}

const SCOPE: ShaderCacheScope = Object.freeze({
  namespace: "deep.production",
  packageSchemaVersion: 2,
  targetProfile: "webgpu-wgsl-pipeline-2",
  compilerVersion: "0.2.0",
  shaderAbiId: "deep.pbr.mesh.v1",
  shaderAbiHash: DEEP_PBR_MESH_V1_SHA256,
});

class MemoryStore implements ShaderPackageCacheStore {
  readonly values = new Map<string, unknown>();
  reads = 0;
  commits = 0;
  deletes = 0;
  readGate?: Promise<void>;
  commitGate?: Promise<void>;
  commitFailure?: Error;

  async read(key: string, signal: AbortSignal): Promise<unknown | undefined> {
    this.reads += 1;
    if (this.readGate) await Promise.race([
      this.readGate,
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    ]);
    return this.values.get(key);
  }

  async commit(key: string, candidate: ShaderPackageCacheRecord): Promise<void> {
    this.commits += 1;
    if (this.commitGate) await this.commitGate;
    if (this.commitFailure) throw this.commitFailure;
    this.values.set(key, candidate);
  }

  async delete(key: string): Promise<void> {
    this.deletes += 1;
    this.values.delete(key);
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("ShaderPackageContentCache", () => {
  it("keys content by the complete namespace, compiler, target, ABI, and package identity", async () => {
    const one = new ShaderPackageContentCache({ scope: SCOPE });
    const packageOne = packageValue();
    await one.put(packageOne);
    expect(await one.get(packageOne.packageCacheKey)).toEqual(packageOne);
    await expect(one.put(packageValue("deep.cache.wrong", "0.3.0"))).rejects.toMatchObject({
      code: "scope-mismatch",
    });
    expect(() => new ShaderPackageContentCache({
      scope: { ...SCOPE, namespace: "Bad Namespace" },
    })).toThrow("namespace");
    await expect(one.get("A".repeat(64))).rejects.toThrow("canonical SHA-256");
    const otherNamespace = shaderPackageStoreKey(shaderCacheIdentity(
      { ...SCOPE, namespace: "deep.preview" }, packageOne.packageCacheKey,
    ));
    const production = shaderPackageStoreKey(shaderCacheIdentity(SCOPE, packageOne.packageCacheKey));
    expect(otherNamespace).not.toBe(production);
  });

  it("uses a bounded entry and serialized-byte LRU", async () => {
    const first = packageValue("deep.cache.first");
    const second = packageValue("deep.cache.second");
    const cache = new ShaderPackageContentCache({ scope: SCOPE, maxEntries: 1 });
    await cache.put(first);
    await cache.put(second);
    expect(cache.stats.memoryEntries).toBe(1);
    expect(await cache.get(first.packageCacheKey)).toBeUndefined();
    expect(await cache.get(second.packageCacheKey)).toBeDefined();

    const byteBound = new ShaderPackageContentCache({ scope: SCOPE, maxBytes: 1 });
    await expect(byteBound.put(first)).resolves.toMatchObject({ packageId: first.packageId });
    expect(byteBound.stats).toMatchObject({ memoryEntries: 0, memoryBytes: 0 });
  });

  it("deduplicates same-key reads and commits only after an atomic store candidate succeeds", async () => {
    const store = new MemoryStore();
    const value = packageValue();
    const seed = new ShaderPackageContentCache({ scope: SCOPE, store });
    await seed.put(value);
    const cache = new ShaderPackageContentCache({ scope: SCOPE, store });
    const [a, b] = await Promise.all([
      cache.get(value.packageCacheKey), cache.get(value.packageCacheKey),
    ]);
    expect(a).toEqual(value);
    expect(b).toEqual(value);
    expect(store.reads).toBe(1);

    let releaseCommit!: () => void;
    const delayedStore = new MemoryStore();
    delayedStore.commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const delayed = new ShaderPackageContentCache({ scope: SCOPE, store: delayedStore });
    const firstWrite = delayed.put(value);
    const secondWrite = delayed.put(value);
    await Promise.resolve(); await Promise.resolve();
    expect(delayedStore.commits).toBe(1);
    expect(delayed.stats.memoryEntries).toBe(0);
    releaseCommit();
    await Promise.all([firstWrite, secondWrite]);
    expect(delayed.stats.memoryEntries).toBe(1);

    const failingStore = new MemoryStore();
    failingStore.commitFailure = new Error("atomic commit rejected");
    const failing = new ShaderPackageContentCache({ scope: SCOPE, store: failingStore });
    await expect(failing.put(value)).rejects.toThrow("atomic commit rejected");
    expect(failing.stats.memoryEntries).toBe(0);
    expect(await failing.get(value.packageCacheKey)).toBeUndefined();
  });

  it("fails closed and requests eviction for corrupt, mismatched, and expired records", async () => {
    const cases: Array<(record: any) => void> = [
      (record) => { record.identity.namespace = "other.scope"; },
      (record) => { record.package.modules[0].source += "\ncorrupt"; },
      (record) => { record.expiresAtMs = record.storedAtMs; },
      (record) => { record.extra = true; },
      (record) => { record.package = record; },
    ];
    for (const corrupt of cases) {
      const store = new MemoryStore();
      const value = packageValue();
      await new ShaderPackageContentCache({ scope: SCOPE, store, now: () => 100 }).put(value);
      const [key, original] = [...store.values.entries()][0]!;
      const damaged = clone(original);
      corrupt(damaged);
      store.values.set(key, damaged);
      const cache = new ShaderPackageContentCache({ scope: SCOPE, store, now: () => 101 });
      expect(await cache.get(value.packageCacheKey)).toBeUndefined();
      expect(store.deletes).toBe(1);
      expect(store.values.has(key)).toBe(false);
    }

    const expiredStore = new MemoryStore();
    const expired = packageValue("deep.cache.expired");
    await new ShaderPackageContentCache({
      scope: SCOPE, store: expiredStore, ttlMs: 10, now: () => 100,
    }).put(expired);
    const expiredCache = new ShaderPackageContentCache({
      scope: SCOPE, store: expiredStore, ttlMs: 10, now: () => 111,
    });
    expect(await expiredCache.get(expired.packageCacheKey)).toBeUndefined();
    expect(expiredStore.deletes).toBe(1);
  });

  it("rechecks the atomic store before evicting an expired in-memory generation", async () => {
    const store = new MemoryStore();
    const value = packageValue("deep.cache.refresh-race");
    let now = 100;
    const staleMemory = new ShaderPackageContentCache({
      scope: SCOPE, store, ttlMs: 10, now: () => now,
    });
    await staleMemory.put(value);
    now = 111;
    await new ShaderPackageContentCache({
      scope: SCOPE, store, ttlMs: 10, now: () => now,
    }).put(value);
    now = 112;
    await expect(staleMemory.get(value.packageCacheKey)).resolves.toEqual(value);
    expect(store.deletes).toBe(0);
  });

  it("prewarms only allowlisted keys and supports timeout cancellation", async () => {
    const store = new MemoryStore();
    const one = packageValue("deep.cache.prewarm-one");
    const two = packageValue("deep.cache.prewarm-two");
    const seed = new ShaderPackageContentCache({ scope: SCOPE, store });
    await seed.put(one); await seed.put(two);
    const cache = new ShaderPackageContentCache({ scope: SCOPE, store });
    const missing = "f".repeat(64);
    const result = await cache.prewarm(
      [one.packageCacheKey, two.packageCacheKey, missing],
      { allowlist: [one.packageCacheKey, missing], concurrency: 2 },
    );
    expect(result.items.map((item) => item.status)).toEqual(["warmed", "denied", "missing"]);

    vi.useFakeTimers();
    try {
      const blockedStore = new MemoryStore();
      blockedStore.values.set([...store.values.keys()][0]!, [...store.values.values()][0]);
      blockedStore.readGate = new Promise(() => undefined);
      const blocked = new ShaderPackageContentCache({ scope: SCOPE, store: blockedStore });
      const pending = blocked.prewarm([one.packageCacheKey], {
        allowlist: [one.packageCacheKey], timeoutMs: 10,
      });
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({
        timedOut: true, aborted: true, items: [{ status: "aborted" }],
      });
    } finally { vi.useRealTimers(); }
  });
});
