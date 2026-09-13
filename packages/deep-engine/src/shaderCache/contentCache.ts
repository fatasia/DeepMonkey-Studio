import { validateDeepShaderPackage } from "../shaderPackage/index.js";
import type { DeepShaderPackageV2 } from "../shaderPackage/index.js";
import { SharedOperations } from "./async.js";
import {
  assertPackageMatchesScope, sameShaderCacheIdentity, shaderCacheIdentity,
  shaderPackageStoreKey, validateShaderCacheScope,
} from "./identity.js";
import { BoundedLru } from "./lru.js";
import { runAllowlistedPrewarm } from "./prewarm.js";
import {
  DEEP_SHADER_CACHE_SCHEMA, DEEP_SHADER_CACHE_SCHEMA_VERSION, ShaderCacheError,
  ShaderCacheAbortError,
} from "./types.js";
import type {
  ShaderCacheIdentity, ShaderPackageCacheRecord, ShaderPackageCacheStats,
  ShaderPackageContentCacheOptions, ShaderPrewarmOptions, ShaderPrewarmResult,
} from "./types.js";

const DEFAULT_ENTRIES = 64;
const DEFAULT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const RECORD_FIELDS = ["schema", "schemaVersion", "identity", "storedAtMs", "expiresAtMs", "package"];
const IDENTITY_FIELDS = [
  "namespace", "packageSchemaVersion", "targetProfile", "compilerVersion",
  "shaderAbiId", "shaderAbiHash", "packageCacheKey",
];

function exactFields(value: object, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validateConfigInteger(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ShaderCacheError(`${name} must be an integer from ${min} through ${max}.`, "invalid-config");
  }
  return value;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export class ShaderPackageContentCache {
  readonly scope;
  private readonly memory: BoundedLru<string, ShaderPackageCacheRecord>;
  private readonly ttlMs: number;
  private readonly store;
  private readonly now;
  private readonly reads = new SharedOperations<DeepShaderPackageV2 | undefined>();
  private readonly writes = new SharedOperations<DeepShaderPackageV2>();

  constructor(options: ShaderPackageContentCacheOptions) {
    if (!options || typeof options !== "object") {
      throw new ShaderCacheError("Shader content cache options are required.", "invalid-config");
    }
    this.scope = validateShaderCacheScope(options.scope);
    const maxEntries = validateConfigInteger("Shader cache maxEntries", options.maxEntries ?? DEFAULT_ENTRIES, 1, 65_536);
    const maxBytes = validateConfigInteger("Shader cache maxBytes", options.maxBytes ?? DEFAULT_BYTES, 1, 1_073_741_824);
    this.ttlMs = validateConfigInteger("Shader cache ttlMs", options.ttlMs ?? DEFAULT_TTL_MS, 1, 31_536_000_000);
    this.memory = new BoundedLru(maxEntries, maxBytes);
    if (options.store && (typeof options.store.read !== "function"
      || typeof options.store.commit !== "function" || typeof options.store.delete !== "function")) {
      throw new ShaderCacheError("Shader package store must implement read, commit, and delete.", "invalid-config");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new ShaderCacheError("Shader cache clock must be a function.", "invalid-config");
    }
    this.store = options.store;
    this.now = options.now ?? Date.now;
  }

  get stats(): ShaderPackageCacheStats {
    return Object.freeze({
      memoryEntries: this.memory.size,
      memoryBytes: this.memory.bytes,
      pendingOperations: this.reads.size + this.writes.size,
    });
  }

  async put(input: unknown, signal?: AbortSignal): Promise<DeepShaderPackageV2> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new ShaderCacheAbortError();
    }
    const packageValue = this.validatePackage(input);
    const identity = shaderCacheIdentity(this.scope, packageValue.packageCacheKey);
    const key = shaderPackageStoreKey(identity);
    return this.writes.run(key, async (operationSignal) => {
      const now = this.currentTime();
      const expiresAtMs = now + this.ttlMs;
      if (!Number.isSafeInteger(expiresAtMs)) {
        throw new ShaderCacheError("Shader cache expiry exceeds the safe clock range.", "invalid-config");
      }
      const record: ShaderPackageCacheRecord = Object.freeze({
        schema: DEEP_SHADER_CACHE_SCHEMA,
        schemaVersion: DEEP_SHADER_CACHE_SCHEMA_VERSION,
        identity,
        storedAtMs: now,
        expiresAtMs,
        package: packageValue,
      });
      await this.store?.commit(key, record, operationSignal);
      if (operationSignal.aborted) throw operationSignal.reason;
      this.memory.set(key, record, serializedBytes(record));
      return packageValue;
    }, signal);
  }

  async get(packageCacheKey: string, signal?: AbortSignal): Promise<DeepShaderPackageV2 | undefined> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new ShaderCacheAbortError();
    }
    const identity = shaderCacheIdentity(this.scope, packageCacheKey);
    const key = shaderPackageStoreKey(identity);
    const cached = this.memory.get(key);
    if (cached) {
      if (cached.expiresAtMs > this.currentTime()) return cached.package;
      this.memory.delete(key);
    }
    if (!this.store) return undefined;
    return this.reads.run(key, (operationSignal) => this.load(key, identity, operationSignal), signal);
  }

  async delete(packageCacheKey: string, signal?: AbortSignal): Promise<void> {
    const key = shaderPackageStoreKey(shaderCacheIdentity(this.scope, packageCacheKey));
    this.memory.delete(key);
    if (!this.store) return;
    const controller = new AbortController();
    const aborted = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
    try { await this.store.delete(key, controller.signal); }
    finally { signal?.removeEventListener("abort", aborted); }
  }

  clearMemory(): void { this.memory.clear(); }

  prewarm(
    packageCacheKeys: readonly string[],
    options: ShaderPrewarmOptions,
  ): Promise<ShaderPrewarmResult> {
    for (const key of [...packageCacheKeys, ...options.allowlist]) shaderCacheIdentity(this.scope, key);
    return runAllowlistedPrewarm(
      packageCacheKeys,
      options,
      async (key, signal) => (await this.get(key, signal)) !== undefined,
    );
  }

  private validatePackage(input: unknown): DeepShaderPackageV2 {
    const result = validateDeepShaderPackage(input);
    if (!result.valid || !result.value) {
      throw new ShaderCacheError("Shader package failed strict validation.", "invalid-package");
    }
    assertPackageMatchesScope(result.value, this.scope);
    return result.value;
  }

  private validateRecord(
    input: unknown,
    expected: ShaderCacheIdentity,
  ): ShaderPackageCacheRecord | undefined {
    const record = asRecord(input);
    if (!record || !exactFields(record, RECORD_FIELDS)
      || record.schema !== DEEP_SHADER_CACHE_SCHEMA
      || record.schemaVersion !== DEEP_SHADER_CACHE_SCHEMA_VERSION) return undefined;
    const identity = asRecord(record.identity);
    if (!identity || !exactFields(identity, IDENTITY_FIELDS)
      || !sameShaderCacheIdentity(identity as unknown as ShaderCacheIdentity, expected)) return undefined;
    const now = this.currentTime();
    if (!safeInteger(record.storedAtMs) || !safeInteger(record.expiresAtMs)
      || record.expiresAtMs <= record.storedAtMs
      || record.expiresAtMs - record.storedAtMs > this.ttlMs
      || record.storedAtMs > now + 300_000
      || record.expiresAtMs <= now) return undefined;
    try {
      const packageValue = this.validatePackage(record.package);
      if (packageValue.packageCacheKey !== expected.packageCacheKey) return undefined;
      return Object.freeze({
        schema: DEEP_SHADER_CACHE_SCHEMA,
        schemaVersion: DEEP_SHADER_CACHE_SCHEMA_VERSION,
        identity: expected,
        storedAtMs: record.storedAtMs,
        expiresAtMs: record.expiresAtMs,
        package: packageValue,
      });
    } catch { return undefined; }
  }

  private async load(
    key: string,
    identity: ShaderCacheIdentity,
    signal: AbortSignal,
  ): Promise<DeepShaderPackageV2 | undefined> {
    let candidate: unknown;
    try { candidate = await this.store!.read(key, signal); }
    catch (error) { if (signal.aborted) throw error; throw error; }
    if (candidate === undefined) return undefined;
    let record: ShaderPackageCacheRecord | undefined;
    try { record = this.validateRecord(candidate, identity); } catch { record = undefined; }
    if (!record) {
      await this.evictStore(key);
      return undefined;
    }
    if (signal.aborted) throw signal.reason;
    this.memory.set(key, record, serializedBytes(record));
    return record.package;
  }

  private async evictStore(key: string): Promise<void> {
    this.memory.delete(key);
    if (!this.store) return;
    try { await this.store.delete(key, new AbortController().signal); } catch { /* Fail closed. */ }
  }

  private currentTime(): number {
    const value = this.now();
    if (!safeInteger(value)) {
      throw new ShaderCacheError("Shader cache clock returned an invalid value.", "invalid-config");
    }
    return value;
  }
}
