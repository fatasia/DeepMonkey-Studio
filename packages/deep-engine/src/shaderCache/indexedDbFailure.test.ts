import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { DEEP_PBR_MESH_V1_SHA256 } from "../shaderAbi/index.js";
import { buildDeepShaderPackage } from "../shaderPackage/index.js";
import type { DeepShaderPackageV2 } from "../shaderPackage/index.js";
import { ShaderPackageContentCache } from "./contentCache.js";
import { shaderCacheIdentity, shaderPackageStoreKey } from "./identity.js";
import { createIndexedDbShaderPackageCacheStore } from "./indexedDbStore.js";
import type { ShaderCacheScope } from "./types.js";

const TEST_SCOPE: ShaderCacheScope = Object.freeze({
  namespace: "deep.indexeddb-test", packageSchemaVersion: 2,
  targetProfile: "webgpu-wgsl-pipeline-2", compilerVersion: "0.2.0",
  shaderAbiId: "deep.pbr.mesh.v1", shaderAbiHash: DEEP_PBR_MESH_V1_SHA256,
});
const testPackage = (id: string): DeepShaderPackageV2 => {
  const result = buildDeepShaderPackage({
    packageId: id, packageVersion: "1.0.0", compilerVersion: "0.2.0",
    passes: [{
      techniqueId: "pbr", passId: "forward", kind: "forward",
      module: { label: "idb", code: `@vertex fn vertexMain()->@builtin(position) vec4f{return vec4f();}\n@fragment fn fragmentMain()->@location(0) vec4f{return vec4f(1);}\n//${id}` },
      entryPoints: { vertex: "vertexMain", fragment: "fragmentMain" },
      pipeline: { passVariantId: "forward-plain", attachmentProfileId: "forward-opaque", alphaMode: "OPAQUE", rasterMode: "ccw" },
    }],
  });
  expect(result.success).toBe(true); return result.value!;
};
const storeKey = (value: DeepShaderPackageV2): string => shaderPackageStoreKey(shaderCacheIdentity(TEST_SCOPE, value.packageCacheKey));
const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
});

describe("IndexedDbShaderPackageCacheStore failure isolation", () => {
  it("clears corrupt envelopes and rejects mismatched keys or package hashes", async () => {
    const factory = new IDBFactory();
    const store = await createIndexedDbShaderPackageCacheStore({ databaseName: "deep-test-corrupt", factory });
    const value = testPackage("deep.cache.corrupt");
    const key = storeKey(value);
    const db = await requestResult(factory.open("deep-test-corrupt", 1));
    const tx = db.transaction("shader-packages", "readwrite");
    tx.objectStore("shader-packages").put({ key, byteLength: 1, accessSequence: 1, record: { bad: true } });
    await transactionDone(tx); db.close();
    await expect(store.read(key, new AbortController().signal)).resolves.toBeUndefined();
    expect(await store.inspect()).toMatchObject({ entries: 0, bytes: 0 });
    await expect(store.read("wrong", new AbortController().signal)).rejects.toMatchObject({ code: "invalid-record" });

    const cache = new ShaderPackageContentCache({ scope: TEST_SCOPE, store, now: () => 10 });
    await cache.put(value); cache.clearMemory();
    const otherKey = `deep-shader-cache/v1/${"f".repeat(64)}`;
    const raw = await store.read(key, new AbortController().signal);
    await expect(store.commit(otherKey, raw as never, new AbortController().signal))
      .rejects.toMatchObject({ code: "invalid-record" });
    await expect(store.commit(key, { ...(raw as object), gpuPipeline: {} } as never, new AbortController().signal))
      .rejects.toMatchObject({ code: "invalid-record" });
    await expect(cache.get(value.packageCacheKey)).resolves.toEqual(value);
    store.close();
  });

  it("clears healthy metadata with a later-corrupted envelope in the same transaction", async () => {
    const factory = new IDBFactory();
    const store = await createIndexedDbShaderPackageCacheStore({ databaseName: "deep-test-late-corrupt", factory });
    const first = testPackage("deep.cache.late-corrupt-first"), second = testPackage("deep.cache.late-corrupt-second");
    const cache = new ShaderPackageContentCache({ scope: TEST_SCOPE, store });
    await cache.put(first); await cache.put(second);
    const key = storeKey(first), db = await requestResult(factory.open("deep-test-late-corrupt", 1));
    const read = db.transaction("shader-packages", "readonly");
    const envelope = await requestResult(read.objectStore("shader-packages").get(key)) as Record<string, unknown>;
    await transactionDone(read);
    const write = db.transaction("shader-packages", "readwrite");
    write.objectStore("shader-packages").put({ ...envelope, byteLength: 1 });
    await transactionDone(write); db.close();
    cache.clearMemory();
    await expect(store.read(key, new AbortController().signal)).resolves.toBeUndefined();
    expect(await store.inspect()).toEqual({ entries: 0, bytes: 0, accessSequence: 0 });
    await expect(store.read(storeKey(second), new AbortController().signal)).resolves.toBeUndefined();
    store.close();
  });

  it("cancels open and transactions and removes abort listeners", async () => {
    const factory = new IDBFactory();
    const openController = new AbortController();
    const openAdded = vi.spyOn(openController.signal, "addEventListener");
    const openRemoved = vi.spyOn(openController.signal, "removeEventListener");
    const pending = createIndexedDbShaderPackageCacheStore({ databaseName: "deep-test-open-abort", factory }, openController.signal);
    openController.abort(new Error("stop open"));
    await expect(pending).rejects.toThrow("stop open");
    expect(openAdded.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);
    expect(openRemoved.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);

    const store = await createIndexedDbShaderPackageCacheStore({ databaseName: "deep-test-abort", factory });
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const inspect = store.inspect(controller.signal);
    controller.abort(new Error("stop transaction"));
    await expect(inspect).rejects.toThrow("stop transaction");
    expect(added.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);
    expect(removed.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);
    const alreadyAborted = new AbortController(); alreadyAborted.abort(new Error("already stopped"));
    const value = testPackage("deep.cache.pre-aborted");
    await expect(store.commit(storeKey(value), {} as never, alreadyAborted.signal))
      .rejects.toThrow("already stopped");
    await expect(store.read(storeKey(value), alreadyAborted.signal)).rejects.toThrow("already stopped");
    await expect(store.delete(storeKey(value), alreadyAborted.signal)).rejects.toThrow("already stopped");
    store.close();
  });

  it("maps quota errors and atomically preserves the last-known-good generation", async () => {
    const factory = new IDBFactory();
    const store = await createIndexedDbShaderPackageCacheStore({ databaseName: "deep-test-quota", factory });
    const first = testPackage("deep.cache.quota-first");
    const cache = new ShaderPackageContentCache({ scope: TEST_SCOPE, store });
    await cache.put(first); cache.clearMemory();
    const key = storeKey(first);
    const previous = await store.read(key, new AbortController().signal) as Record<string, unknown>;
    const refreshed = {
      ...previous,
      storedAtMs: Number(previous.storedAtMs) + 1,
      expiresAtMs: Number(previous.expiresAtMs) + 1,
    };
    const originalPut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (...args) {
      const value = args[0] as { record?: { storedAtMs?: number } };
      if (value.record?.storedAtMs === refreshed.storedAtMs) {
        throw new DOMException("quota", "QuotaExceededError");
      }
      return originalPut.apply(this, args as Parameters<IDBObjectStore["put"]>);
    });
    try {
      await expect(store.commit(key, refreshed as never, new AbortController().signal))
        .rejects.toMatchObject({ code: "quota-exceeded" });
    } finally { put.mockRestore(); }
    const retained = await store.read(key, new AbortController().signal) as Record<string, unknown>;
    expect(retained.storedAtMs).toBe(previous.storedAtMs);
    expect(retained.package).toEqual(first);
    store.close();
  });

  it("clears the CAS atomically when access-order metadata is corrupt", async () => {
    const factory = new IDBFactory();
    const store = await createIndexedDbShaderPackageCacheStore({ databaseName: "deep-test-meta-corrupt", factory });
    const value = testPackage("deep.cache.meta-corrupt");
    await new ShaderPackageContentCache({ scope: TEST_SCOPE, store }).put(value);
    const db = await requestResult(factory.open("deep-test-meta-corrupt", 1));
    const tx = db.transaction("cache-meta", "readwrite");
    tx.objectStore("cache-meta").put({ key: "state", accessSequence: 0, entries: 1, bytes: 1 });
    await transactionDone(tx); db.close();
    await expect(store.read(storeKey(value), new AbortController().signal)).resolves.toBeUndefined();
    expect(await store.inspect()).toMatchObject({ entries: 0, bytes: 0 });
    store.close();
  });

  it("returns structured failures for newer versions and wrong v1 schemas", async () => {
    const newerFactory = new IDBFactory();
    const newer = await requestResult(newerFactory.open("deep-test-newer", 2)); newer.close();
    await expect(createIndexedDbShaderPackageCacheStore({ databaseName: "deep-test-newer", factory: newerFactory }))
      .rejects.toMatchObject({ code: "version-unsupported" });

    const wrongFactory = new IDBFactory();
    const request = wrongFactory.open("deep-test-wrong-schema", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("wrong", { keyPath: "key" });
    const wrong = await requestResult(request); wrong.close();
    await expect(createIndexedDbShaderPackageCacheStore({ databaseName: "deep-test-wrong-schema", factory: wrongFactory }))
      .rejects.toMatchObject({ code: "schema-mismatch" });
  });
});
