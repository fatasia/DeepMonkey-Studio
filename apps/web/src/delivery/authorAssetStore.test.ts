import { readFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { createAuthorAssetStore } from "./authorAssetStore";
import { authorAssetKey, persistentAuthorModelDecoder } from "./persistentAuthorModelDecoder";
import { decodeAuthorModel, type AuthorModelDecodeResult } from "./authorModelDecode";
import { authorModelTransferBuffers } from "./authorModelTransfer";

const source = new Uint8Array(readFileSync(new URL("../../../../packages/deep-engine/lab/assets/Box.glb", import.meta.url)));
const options = { resourcePrefix: "box", modelId: "box", maxDecodedBytes: 128 * 1024 * 1024 };
const signal = () => new AbortController().signal;
const decode = () => decodeAuthorModel(source, options, signal(), async bytes => bytes.slice(), {
  decode: async () => { throw new Error("Box has no textures"); },
});

describe("persistent author assets", () => {
  it("reuses across workers and survives transfer of the returned buffers", async () => {
    const factory = new IDBFactory(), store = createAuthorAssetStore(factory), compile = vi.fn(decode);
    const first = await persistentAuthorModelDecoder(compile, store)(source, options, signal());
    const expected = structuredClone(first);
    structuredClone(first, { transfer: authorModelTransferBuffers(first) });
    const second = await persistentAuthorModelDecoder(compile, createAuthorAssetStore(factory))(source, options, signal());
    expect(second).toEqual(expected); expect(compile).toHaveBeenCalledOnce();
  });
  it("isolates bytes, resource IDs, budgets, pose and material profiles", async () => {
    const base = await authorAssetKey(source, options);
    for (const patch of [{ resourcePrefix: "other" }, { maxDecodedBytes: 1 }, { textureBudgetBytes: 123 },
      { liveDeformation: true }, { advancedMaterials: true }, { preserveTexCoords: true }]) {
      expect(await authorAssetKey(source, { ...options, ...patch })).not.toBe(base);
    }
    expect(await authorAssetKey(source.slice(1), options)).not.toBe(base);
    expect(await authorAssetKey(source, { ...options, modelId: "instance-two" })).toBe(base);
  });
  it("shares static preprocessing between live WebGPU and bind-pose WASM profiles", async () => {
    const compile = vi.fn(decode), cached = persistentAuthorModelDecoder(compile, createAuthorAssetStore(new IDBFactory()));
    const live = await cached(source, { ...options, liveDeformation: true }, signal());
    const wasm = await cached(source, { ...options, liveDeformation: false }, signal());
    expect(wasm).toEqual(live); expect(compile).toHaveBeenCalledOnce();
  });
  it("evicts least recently used metadata without evicting the newest resident", async () => {
    const store = createAuthorAssetStore(new IDBFactory(), "lru", 100, 2), result = await decode();
    let time = 10; const clock = vi.spyOn(Date, "now").mockImplementation(() => time++);
    try {
      await store.put("a", result, 40); await store.put("b", result, 40); await store.get("a");
      await store.put("c", result, 40);
      expect(await store.get("b")).toBeUndefined(); expect(await store.get("a")).toEqual(result);
      expect(await store.get("c")).toEqual(result);
      await store.put("oversize", result, 101); expect(await store.get("oversize")).toBeUndefined();
    } finally { clock.mockRestore(); }
  });
  it("repairs corrupt entries and falls back on storage denial or quota", async () => {
    const store = createAuthorAssetStore(new IDBFactory()), key = await authorAssetKey(source, options);
    await store.put(key, {} as AuthorModelDecodeResult, 10);
    const compile = vi.fn(decode), cached = persistentAuthorModelDecoder(compile, store);
    expect(await cached(source, options, signal())).toEqual(await decode());
    await cached(source, options, signal()); expect(compile).toHaveBeenCalledOnce();
    const denied = { get: async () => { throw new Error("denied"); }, remove: async () => {},
      put: async () => { throw new Error("quota"); } };
    expect(await persistentAuthorModelDecoder(compile, denied)(source, options, signal())).toEqual(await decode());
  });
  it("does not publish or decode after cancellation during a cache read", async () => {
    const controller = new AbortController(), compile = vi.fn(decode);
    const cached = persistentAuthorModelDecoder(compile, {
      get: async () => { controller.abort(new Error("cancelled")); return undefined; },
      put: async () => {}, remove: async () => {},
    });
    await expect(cached(source, options, controller.signal)).rejects.toThrow("cancelled");
    expect(compile).not.toHaveBeenCalled();
  });
});
