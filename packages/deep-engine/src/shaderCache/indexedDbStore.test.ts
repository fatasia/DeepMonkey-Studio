import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { DEEP_PBR_MESH_V1_SHA256 } from "../shaderAbi/index.js";
import { buildDeepShaderPackage } from "../shaderPackage/index.js";
import type { DeepShaderPackageV2 } from "../shaderPackage/index.js";
import { ShaderPackageContentCache } from "./contentCache.js";
import { shaderCacheIdentity, shaderPackageStoreKey } from "./identity.js";
import { createIndexedDbShaderPackageCacheStore } from "./indexedDbStore.js";
import { serializedRecordBytes } from "./indexedDbValidation.js";
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

describe("IndexedDbShaderPackageCacheStore persistence", () => {
  it("opens only through explicit creation and persists complete validated packages", async () => {
    const factory = new IDBFactory();
    const open = vi.spyOn(factory, "open");
    expect(open).not.toHaveBeenCalled();
    const store = await createIndexedDbShaderPackageCacheStore({ databaseName: "deep-test-persist", factory });
    expect(open).toHaveBeenCalledTimes(1);
    const value = testPackage("deep.cache.persisted");
    await new ShaderPackageContentCache({ scope: TEST_SCOPE, store }).put(value);
    expect(await store.inspect()).toMatchObject({ entries: 1 });
    store.close();

    const reopened = await createIndexedDbShaderPackageCacheStore({ databaseName: "deep-test-persist", factory });
    await expect(new ShaderPackageContentCache({ scope: TEST_SCOPE, store: reopened })
      .get(value.packageCacheKey)).resolves.toEqual(value);
    reopened.close();
  });

  it("serializes concurrent same-key commits without partial or duplicate records", async () => {
    const factory = new IDBFactory();
    const store = await createIndexedDbShaderPackageCacheStore({ databaseName: "deep-test-concurrent", factory });
    const value = testPackage("deep.cache.concurrent");
    const first = new ShaderPackageContentCache({ scope: TEST_SCOPE, store, now: () => 100 });
    const second = new ShaderPackageContentCache({ scope: TEST_SCOPE, store, now: () => 101 });
    const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
    await Promise.all([first.put(value), second.put(value), first.put(value)]);
    expect(await store.inspect()).toMatchObject({ entries: 1 });
    await expect(second.get(value.packageCacheKey)).resolves.toEqual(value);
    expect(getAll).not.toHaveBeenCalled(); getAll.mockRestore();
    store.close();
  });

  it("uses deterministic access-order LRU for entry and byte budgets", async () => {
    const factory = new IDBFactory();
    const store = await createIndexedDbShaderPackageCacheStore({
      databaseName: "deep-test-lru", factory, maxEntries: 2,
    });
    const [a, b, c] = ["a", "b", "c"].map((id) => testPackage(`deep.cache.${id}`));
    const cache = new ShaderPackageContentCache({ scope: TEST_SCOPE, store });
    await cache.put(a!); await cache.put(b!); cache.clearMemory();
    await cache.get(a!.packageCacheKey); await cache.put(c!); cache.clearMemory();
    await expect(cache.get(a!.packageCacheKey)).resolves.toEqual(a);
    cache.clearMemory();
    await expect(cache.get(b!.packageCacheKey)).resolves.toBeUndefined();
    await expect(cache.get(c!.packageCacheKey)).resolves.toEqual(c);
    expect(await store.inspect()).toMatchObject({ entries: 2 });
    store.close();

    const byteFactory = new IDBFactory();
    const sampleStore = await createIndexedDbShaderPackageCacheStore({ databaseName: "deep-test-size-seed", factory: byteFactory });
    const seedCache = new ShaderPackageContentCache({ scope: TEST_SCOPE, store: sampleStore, now: () => 10 });
    await seedCache.put(a!);
    const db = await requestResult(byteFactory.open("deep-test-size-seed", 1));
    const tx = db.transaction("shader-packages", "readonly");
    const raw = await requestResult(tx.objectStore("shader-packages").get(storeKey(a!)));
    await transactionDone(tx); db.close(); sampleStore.close();
    const oneRecordBytes = serializedRecordBytes((raw as { record: unknown }).record);
    const byteStore = await createIndexedDbShaderPackageCacheStore({
      databaseName: "deep-test-bytes", factory: byteFactory, maxBytes: oneRecordBytes + 512,
    });
    const byteCache = new ShaderPackageContentCache({ scope: TEST_SCOPE, store: byteStore });
    await byteCache.put(a!); await byteCache.put(b!);
    expect(await byteStore.inspect()).toMatchObject({ entries: 1 });
    byteCache.clearMemory();
    await expect(byteCache.get(a!.packageCacheKey)).resolves.toBeUndefined();
    await expect(byteCache.get(b!.packageCacheKey)).resolves.toEqual(b);
    byteStore.close();
  });
});
