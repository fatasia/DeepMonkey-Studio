import type { DeepShaderPackageV2, ShaderPackagePass } from "../shaderPackage/index.js";
import type { DeepPbrMeshShaderAbiId } from "../shaderAbi/index.js";
import type { ResidencyDiagnosticsHooks } from "../residencyDiagnostics.js";

export const DEEP_SHADER_CACHE_SCHEMA = "deep.shader-cache-record" as const;
export const DEEP_SHADER_CACHE_SCHEMA_VERSION = 1 as const;

export interface ShaderCacheScope {
  readonly namespace: string;
  readonly packageSchemaVersion: 2;
  readonly targetProfile: "webgpu-wgsl-pipeline-2";
  readonly compilerVersion: string;
  readonly shaderAbiId: DeepPbrMeshShaderAbiId;
  readonly shaderAbiHash: string;
}

export interface ShaderCacheIdentity extends ShaderCacheScope {
  readonly packageCacheKey: string;
}

export interface ShaderPipelineIdentity extends ShaderCacheIdentity {
  readonly passCacheKey: string;
  readonly deviceEpoch: string;
}

export interface ShaderPackageCacheRecord {
  readonly schema: typeof DEEP_SHADER_CACHE_SCHEMA;
  readonly schemaVersion: typeof DEEP_SHADER_CACHE_SCHEMA_VERSION;
  readonly identity: ShaderCacheIdentity;
  readonly storedAtMs: number;
  readonly expiresAtMs: number;
  readonly package: DeepShaderPackageV2;
}

/** `commit` must atomically replace one complete record; partial candidates must never be readable. */
export interface ShaderPackageCacheStore {
  read(key: string, signal: AbortSignal): Promise<unknown | undefined>;
  commit(key: string, candidate: ShaderPackageCacheRecord, signal: AbortSignal): Promise<void>;
  delete(key: string, signal: AbortSignal): Promise<void>;
}

export interface ShaderPackageContentCacheOptions {
  readonly scope: ShaderCacheScope;
  readonly maxEntries?: number;
  /** Upper bound for accounted serialized UTF-8 bytes retained by the in-memory LRU. */
  readonly maxBytes?: number;
  readonly ttlMs?: number;
  readonly store?: ShaderPackageCacheStore;
  readonly now?: () => number;
}

export interface ShaderPackageCacheStats {
  readonly memoryEntries: number;
  readonly memoryBytes: number;
  readonly pendingOperations: number;
}

export interface ShaderPrewarmOptions {
  readonly allowlist: readonly string[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
}

export type ShaderPrewarmItemStatus = "warmed" | "missing" | "denied" | "failed" | "aborted";

export interface ShaderPrewarmItemResult {
  readonly key: string;
  readonly status: ShaderPrewarmItemStatus;
  readonly message?: string;
}

export interface ShaderPrewarmResult {
  readonly items: readonly ShaderPrewarmItemResult[];
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export interface ShaderDevicePipelineCacheOptions<T extends object> {
  readonly scope: ShaderCacheScope;
  readonly deviceEpoch: string;
  readonly maxEntries?: number;
  readonly dispose?: (value: T) => void;
}

export interface ShaderDevicePipelineCachePoolOptions<T extends object> {
  readonly namespace: string;
  readonly deviceEpoch: string;
  readonly maxEntries?: number;
  readonly dispose?: (value: T) => void;
  /** Omit to keep diagnostics disabled with no clock reads or sample allocations. */
  readonly diagnostics?: ResidencyDiagnosticsHooks;
}

export interface ShaderPipelineAtomicBatch<T extends object> {
  readonly package: unknown;
  readonly passCacheKeys: readonly string[];
  readonly create: (
    packageValue: DeepShaderPackageV2,
    missingPasses: readonly ShaderPackagePass[],
    signal: AbortSignal,
  ) => Promise<readonly T[]>;
}

export interface ShaderPipelineCandidate<T extends object> {
  readonly package: unknown;
  readonly passCacheKey: string;
  readonly create: (
    packageValue: DeepShaderPackageV2,
    pass: ShaderPackagePass,
    signal: AbortSignal,
  ) => Promise<T>;
}

export interface ShaderDevicePipelineCacheStats {
  readonly entries: number;
  readonly pendingOperations: number;
  readonly deviceEpoch: string;
}

export class ShaderCacheError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid-config"
      | "invalid-identity"
      | "invalid-package"
      | "scope-mismatch"
      | "missing-pass"
      | "invalidated",
  ) {
    super(message);
    this.name = "ShaderCacheError";
  }
}

export class ShaderCacheAbortError extends Error {
  constructor(message = "Shader cache operation was aborted.") {
    super(message);
    this.name = "AbortError";
  }
}

export type ShaderIndexedDbErrorCode =
  | "indexeddb-unavailable"
  | "invalid-config"
  | "invalid-record"
  | "capacity-exceeded"
  | "open-blocked"
  | "version-unsupported"
  | "schema-mismatch"
  | "quota-exceeded"
  | "transaction-failed"
  | "closed";

export class ShaderIndexedDbError extends Error {
  constructor(
    message: string,
    readonly code: ShaderIndexedDbErrorCode,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ShaderIndexedDbError";
  }
}

export interface IndexedDbShaderPackageCacheStoreOptions {
  /** Separate databases are recommended for production and preview namespaces. */
  readonly databaseName: string;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  /** Test/worker injection point. Omitted values resolve `globalThis.indexedDB` at creation time. */
  readonly factory?: IDBFactory;
}

export interface IndexedDbShaderPackageCacheStoreStats {
  readonly entries: number;
  readonly bytes: number;
  readonly accessSequence: number;
}

export interface IndexedDbShaderPackageCacheStore extends ShaderPackageCacheStore {
  inspect(signal?: AbortSignal): Promise<IndexedDbShaderPackageCacheStoreStats>;
  close(): void;
}
