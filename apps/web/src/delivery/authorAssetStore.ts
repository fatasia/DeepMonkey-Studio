import type { AuthorModelDecodeResult } from "./authorModelDecode";

interface Entry { key: string; bytes: number; touched: number }
export interface AuthorAssetStore {
  get(key: string): Promise<AuthorModelDecodeResult | undefined>;
  put(key: string, result: AuthorModelDecodeResult, bytes: number): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Worker-only disk cache. Metadata has its own store so eviction never reads pixel planes. */
export function createAuthorAssetStore(factory: IDBFactory, name = "deep-author-assets-v1",
  budget = 256 * 1024 * 1024, maxEntries = 8): AuthorAssetStore {
  let opening: Promise<IDBDatabase> | undefined;
  const open = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 1);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Asset cache open timed out")), 1000);
    function finish(error?: Error) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(request.result);
    }
    request.onupgradeneeded = () => {
      request.result.createObjectStore("assets");
      request.result.createObjectStore("metadata", { keyPath: "key" });
    };
    request.onblocked = () => finish(new Error("Asset cache upgrade blocked"));
    request.onerror = () => finish(request.error ?? new Error("Asset cache unavailable"));
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      request.result.onversionchange = () => { request.result.close(); opening = undefined; };
      finish();
    };
  }).catch(error => { opening = undefined; throw error; });
  async function transact<T>(body: (assets: IDBObjectStore, metadata: IDBObjectStore,
    done: (value: T) => void) => void): Promise<T> {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(["assets", "metadata"], "readwrite");
      let value: T;
      const timer = setTimeout(() => { try { tx.abort(); } catch { /* already settled */ } }, 2000);
      tx.oncomplete = () => { clearTimeout(timer); resolve(value); };
      tx.onabort = tx.onerror = () => { clearTimeout(timer); reject(tx.error ?? new Error("Asset cache transaction failed")); };
      try { body(tx.objectStore("assets"), tx.objectStore("metadata"), result => { value = result; }); }
      catch (error) { clearTimeout(timer); tx.abort(); reject(error); }
    });
  }
  return {
    get: key => transact((assets, metadata, done) => {
      const request = assets.get(key);
      request.onsuccess = () => {
        done(request.result as AuthorModelDecodeResult | undefined);
        if (request.result === undefined) return;
        const meta = metadata.get(key);
        meta.onsuccess = () => { if (meta.result) metadata.put({ ...meta.result, touched: Date.now() }); };
      };
    }),
    put: async (key, result, bytes) => {
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > budget) return;
      await transact<void>((assets, metadata, done) => {
        const request = metadata.getAll();
        request.onsuccess = () => {
          const entries = (request.result as Entry[]).filter(entry => entry.key !== key)
            .sort((a, b) => a.touched - b.touched);
          let total = entries.reduce((sum, entry) => sum + entry.bytes, bytes);
          while (entries.length && (total > budget || entries.length >= maxEntries)) {
            const evicted = entries.shift()!;
            total -= evicted.bytes; assets.delete(evicted.key); metadata.delete(evicted.key);
          }
          assets.put(result, key);
          metadata.put({ key, bytes, touched: Date.now() } satisfies Entry); done();
        };
      });
    },
    remove: key => transact<void>((assets, metadata, done) => { assets.delete(key); metadata.delete(key); done(); }),
  };
}
