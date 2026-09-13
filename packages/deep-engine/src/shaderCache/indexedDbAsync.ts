import { ShaderCacheAbortError, ShaderIndexedDbError } from "./types.js";

export const ENTRIES_STORE = "shader-packages";
export const META_STORE = "cache-meta";
export const ACCESS_INDEX = "by-access-sequence";
export const DATABASE_VERSION = 1;

const abortReason = (signal?: AbortSignal): Error =>
  signal?.reason instanceof Error ? signal.reason : new ShaderCacheAbortError();

function mapDatabaseError(error: unknown, fallback: string): Error {
  if (error instanceof ShaderIndexedDbError || error instanceof ShaderCacheAbortError) return error;
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "QuotaExceededError") {
    return new ShaderIndexedDbError("IndexedDB quota rejected the atomic shader cache transaction.", "quota-exceeded", error);
  }
  if (name === "VersionError") {
    return new ShaderIndexedDbError("IndexedDB shader cache uses a newer unsupported version.", "version-unsupported", error);
  }
  return new ShaderIndexedDbError(fallback, "transaction-failed", error);
}

export function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

export function openShaderCacheDatabase(
  factory: IDBFactory,
  databaseName: string,
  signal?: AbortSignal,
): Promise<IDBDatabase> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = factory.open(databaseName, DATABASE_VERSION); }
    catch (cause) {
      reject(mapDatabaseError(cause, "IndexedDB shader cache could not be opened.")); return;
    }
    let settled = false;
    const cleanup = (): void => signal?.removeEventListener("abort", aborted);
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true; cleanup();
      request.onblocked = null;
      request.onerror = () => undefined;
      request.onsuccess = () => request.result.close();
      reject(error);
    };
    const aborted = (): void => {
      try { request.transaction?.abort(); } catch { /* Open requests cannot otherwise be cancelled. */ }
      fail(abortReason(signal));
    };
    signal?.addEventListener("abort", aborted, { once: true });
    request.onupgradeneeded = () => {
      if (settled) { try { request.transaction?.abort(); } catch { /* Already inactive. */ } return; }
      const db = request.result;
      if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
        const entries = db.createObjectStore(ENTRIES_STORE, { keyPath: "key" });
        entries.createIndex(ACCESS_INDEX, ["accessSequence", "key"], { unique: true });
      }
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "key" });
    };
    request.onblocked = () => fail(new ShaderIndexedDbError(
      "IndexedDB shader cache upgrade is blocked by another open connection.", "open-blocked",
    ));
    request.onerror = () => fail(mapDatabaseError(request.error, "IndexedDB shader cache could not be opened."));
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      const validNames = db.objectStoreNames.length === 2
        && db.objectStoreNames.contains(ENTRIES_STORE) && db.objectStoreNames.contains(META_STORE);
      let validKeys = false;
      try {
        const tx = db.transaction([ENTRIES_STORE, META_STORE], "readonly");
        const entries = tx.objectStore(ENTRIES_STORE);
        const indexKey = entries.indexNames.contains(ACCESS_INDEX)
          ? entries.index(ACCESS_INDEX).keyPath : undefined;
        validKeys = entries.keyPath === "key" && entries.indexNames.length === 1
          && Array.isArray(indexKey) && indexKey.join("/") === "accessSequence/key"
          && tx.objectStore(META_STORE).keyPath === "key";
      } catch { validKeys = false; }
      if (!validNames || !validKeys) {
        db.close();
        fail(new ShaderIndexedDbError("IndexedDB shader cache schema does not match v1.", "schema-mismatch"));
        return;
      }
      settled = true; cleanup();
      request.onerror = null; request.onsuccess = null;
      request.onblocked = null; request.onupgradeneeded = null;
      resolve(db);
    };
  });
}

export function runTransaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  signal: AbortSignal | undefined,
  work: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = db.transaction([ENTRIES_STORE, META_STORE], mode); }
    catch (cause) { reject(new ShaderIndexedDbError("IndexedDB shader cache is closed.", "closed", cause)); return; }
    let result: T, failure: unknown, settled = false;
    const cleanup = (): void => signal?.removeEventListener("abort", aborted);
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true; cleanup(); error === undefined ? resolve(result!) : reject(error);
    };
    const aborted = (): void => {
      failure = abortReason(signal);
      try { transaction.abort(); } catch { finish(failure); }
    };
    signal?.addEventListener("abort", aborted, { once: true });
    transaction.oncomplete = () => finish(failure);
    transaction.onabort = () => finish(failure ?? mapDatabaseError(
      transaction.error, "IndexedDB shader cache transaction was aborted.",
    ));
    transaction.onerror = (event) => event.preventDefault();
    void work(transaction).then((value) => { result = value; }, (error) => {
      failure = signal?.aborted
        ? abortReason(signal)
        : mapDatabaseError(error, "IndexedDB shader cache transaction failed.");
      try { transaction.abort(); } catch { finish(failure); }
    });
  });
}
