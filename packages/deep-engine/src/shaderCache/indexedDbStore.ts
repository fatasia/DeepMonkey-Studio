import {
  ACCESS_INDEX, requestValue, openShaderCacheDatabase, runTransaction, ENTRIES_STORE, META_STORE,
} from "./indexedDbAsync.js";
import {
  parseEntry, parseState, serializedRecordBytes, validatePersistentRecord, validateStoreKey,
} from "./indexedDbValidation.js";
import type { IndexedDbCacheEntry, IndexedDbCacheState } from "./indexedDbValidation.js";
import { ShaderCacheAbortError, ShaderIndexedDbError } from "./types.js";
import type {
  IndexedDbShaderPackageCacheStore, IndexedDbShaderPackageCacheStoreOptions,
  IndexedDbShaderPackageCacheStoreStats, ShaderPackageCacheRecord,
} from "./types.js";

const DEFAULT_ENTRIES = 256;
const DEFAULT_BYTES = 128 * 1024 * 1024;
const DATABASE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function bounded(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ShaderIndexedDbError(`${name} must be an integer from 1 through ${maximum}.`, "invalid-config");
  }
  return value;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new ShaderCacheAbortError();
  }
}

const emptyState = (): IndexedDbCacheState => ({ key: "state", accessSequence: 0, entries: 0, bytes: 0 });

function consistentState(value: unknown, count: number): IndexedDbCacheState | undefined {
  if (count === 0 && value === undefined) return emptyState();
  const state = parseState(value);
  return state?.entries === count ? state : undefined;
}

function resetToCandidate(
  entryStore: IDBObjectStore,
  metaStore: IDBObjectStore,
  entry: IndexedDbCacheEntry,
): IndexedDbCacheState {
  entryStore.clear(); metaStore.clear(); entryStore.put(entry);
  return { key: "state", accessSequence: entry.accessSequence, entries: 1, bytes: entry.byteLength };
}

class IndexedDbShaderStore implements IndexedDbShaderPackageCacheStore {
  private closed = false;

  constructor(
    private readonly database: IDBDatabase,
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {
    database.onversionchange = () => this.close();
  }

  async read(key: string, signal: AbortSignal): Promise<unknown | undefined> {
    assertNotAborted(signal); validateStoreKey(key); this.assertOpen();
    return runTransaction(this.database, "readwrite", signal, async (transaction) => {
      const entries = transaction.objectStore(ENTRIES_STORE);
      const meta = transaction.objectStore(META_STORE);
      const [raw, rawState, count] = await Promise.all([
        requestValue(entries.get(key)), requestValue(meta.get("state")), requestValue(entries.count()),
      ]);
      if (raw === undefined) return undefined;
      const entry = parseEntry(key, raw);
      if (!entry) { entries.clear(); meta.clear(); return undefined; }
      const state = consistentState(rawState, count);
      if (!state || state.accessSequence < entry.accessSequence || state.bytes < entry.byteLength
        || state.accessSequence === Number.MAX_SAFE_INTEGER) {
        entries.clear(); meta.clear(); return undefined;
      }
      const sequence = state.accessSequence + 1;
      entries.put({ ...entry, accessSequence: sequence });
      meta.put({ ...state, accessSequence: sequence });
      return entry.record;
    });
  }

  async commit(key: string, candidate: ShaderPackageCacheRecord, signal: AbortSignal): Promise<void> {
    assertNotAborted(signal); validateStoreKey(key); this.assertOpen();
    if (!validatePersistentRecord(key, candidate)) {
      throw new ShaderIndexedDbError("Shader cache candidate failed schema or content-hash validation.", "invalid-record");
    }
    const byteLength = serializedRecordBytes(candidate);
    if (byteLength > this.maxBytes) {
      throw new ShaderIndexedDbError("Shader cache candidate exceeds the persistent byte budget.", "capacity-exceeded");
    }
    await runTransaction(this.database, "readwrite", signal, async (transaction) => {
      const entryStore = transaction.objectStore(ENTRIES_STORE);
      const metaStore = transaction.objectStore(META_STORE);
      const [rawExisting, rawState, count] = await Promise.all([
        requestValue(entryStore.get(key)), requestValue(metaStore.get("state")), requestValue(entryStore.count()),
      ]);
      const existing = rawExisting === undefined ? undefined : parseEntry(key, rawExisting);
      let state = consistentState(rawState, count);
      if (!state || (rawExisting !== undefined && !existing)
        || state.accessSequence === Number.MAX_SAFE_INTEGER) {
        const next: IndexedDbCacheEntry = { key, byteLength, accessSequence: 1, record: candidate };
        state = resetToCandidate(entryStore, metaStore, next); metaStore.put(state); return;
      }
      const sequence = state.accessSequence + 1;
      const next: IndexedDbCacheEntry = { key, byteLength, accessSequence: sequence, record: candidate };
      let totalEntries = state.entries + (existing ? 0 : 1);
      let totalBytes = state.bytes - (existing?.byteLength ?? 0) + byteLength;
      entryStore.put(next);
      while (totalEntries > this.maxEntries || totalBytes > this.maxBytes) {
        const cursor = await requestValue(entryStore.index(ACCESS_INDEX).openCursor());
        if (!cursor) {
          state = resetToCandidate(entryStore, metaStore, next);
          metaStore.put(state); return;
        }
        const evicted = parseEntry(String(cursor.primaryKey), cursor.value);
        if (!evicted || evicted.key === key) {
          state = resetToCandidate(entryStore, metaStore, next);
          metaStore.put(state); return;
        }
        cursor.delete(); totalEntries -= 1; totalBytes -= evicted.byteLength;
      }
      metaStore.put({ key: "state", accessSequence: sequence, entries: totalEntries, bytes: totalBytes });
    });
  }

  async delete(key: string, signal: AbortSignal): Promise<void> {
    assertNotAborted(signal); validateStoreKey(key); this.assertOpen();
    await runTransaction(this.database, "readwrite", signal, async (transaction) => {
      const entries = transaction.objectStore(ENTRIES_STORE), meta = transaction.objectStore(META_STORE);
      const [raw, rawState, count] = await Promise.all([
        requestValue(entries.get(key)), requestValue(meta.get("state")), requestValue(entries.count()),
      ]);
      if (raw === undefined) return;
      const entry = parseEntry(key, raw), state = consistentState(rawState, count);
      if (!entry || !state || state.bytes < entry.byteLength) { entries.clear(); meta.clear(); return; }
      entries.delete(key);
      meta.put({ ...state, entries: state.entries - 1, bytes: state.bytes - entry.byteLength });
    });
  }

  async inspect(signal?: AbortSignal): Promise<IndexedDbShaderPackageCacheStoreStats> {
    assertNotAborted(signal); this.assertOpen();
    return runTransaction(this.database, "readonly", signal, async (transaction) => {
      const entries = transaction.objectStore(ENTRIES_STORE);
      const [rawState, count] = await Promise.all([
        requestValue(transaction.objectStore(META_STORE).get("state")), requestValue(entries.count()),
      ]);
      const state = consistentState(rawState, count);
      if (!state) throw new ShaderIndexedDbError("IndexedDB shader cache metadata is corrupt.", "schema-mismatch");
      return Object.freeze({
        entries: state.entries, bytes: state.bytes, accessSequence: state.accessSequence,
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.database.close(); this.database.onversionchange = null;
  }

  private assertOpen(): void {
    if (this.closed) throw new ShaderIndexedDbError("IndexedDB shader cache store is closed.", "closed");
  }
}

export async function createIndexedDbShaderPackageCacheStore(
  options: IndexedDbShaderPackageCacheStoreOptions,
  signal?: AbortSignal,
): Promise<IndexedDbShaderPackageCacheStore> {
  if (!options || typeof options !== "object" || typeof options.databaseName !== "string"
    || !DATABASE_NAME.test(options.databaseName)) {
    throw new ShaderIndexedDbError("IndexedDB shader cache databaseName is not canonical.", "invalid-config");
  }
  const maxEntries = bounded("IndexedDB shader cache maxEntries", options.maxEntries ?? DEFAULT_ENTRIES, 65_536);
  const maxBytes = bounded("IndexedDB shader cache maxBytes", options.maxBytes ?? DEFAULT_BYTES, 1_073_741_824);
  const factory = options.factory ?? globalThis.indexedDB;
  if (!factory) throw new ShaderIndexedDbError("IndexedDB is unavailable in this runtime.", "indexeddb-unavailable");
  const database = await openShaderCacheDatabase(factory, options.databaseName, signal);
  return new IndexedDbShaderStore(database, maxEntries, maxBytes);
}
