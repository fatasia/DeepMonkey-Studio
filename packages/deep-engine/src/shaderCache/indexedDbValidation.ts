import { validateDeepShaderPackage } from "../shaderPackage/index.js";
import {
  DEEP_SHADER_CACHE_SCHEMA, DEEP_SHADER_CACHE_SCHEMA_VERSION, ShaderIndexedDbError,
} from "./types.js";
import type { ShaderCacheIdentity, ShaderPackageCacheRecord } from "./types.js";
import {
  shaderCacheIdentity, shaderPackageStoreKey, validateShaderCacheScope,
} from "./identity.js";

export const ENTRY_FIELDS = ["key", "byteLength", "accessSequence", "record"] as const;
const RECORD_FIELDS = ["schema", "schemaVersion", "identity", "storedAtMs", "expiresAtMs", "package"];
const IDENTITY_FIELDS = [
  "namespace", "packageSchemaVersion", "targetProfile", "compilerVersion",
  "shaderAbiId", "shaderAbiHash", "packageCacheKey",
];
const STORE_KEY = /^deep-shader-cache\/v1\/[0-9a-f]{64}$/;

export interface IndexedDbCacheEntry {
  readonly key: string;
  readonly byteLength: number;
  readonly accessSequence: number;
  readonly record: ShaderPackageCacheRecord;
}

export interface IndexedDbCacheState {
  readonly key: "state";
  readonly accessSequence: number;
  readonly entries: number;
  readonly bytes: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exact = (value: object, fields: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
};

const safeNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const serializedRecordBytes = (value: unknown): number => {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch (cause) { throw new ShaderIndexedDbError("Shader cache record is not serializable.", "invalid-record", cause); }
};

export function validateStoreKey(key: string): string {
  if (typeof key !== "string" || !STORE_KEY.test(key)) {
    throw new ShaderIndexedDbError("Shader cache store key is not canonical.", "invalid-record");
  }
  return key;
}

export function validatePersistentRecord(
  key: string,
  candidate: unknown,
): ShaderPackageCacheRecord | undefined {
  if (!object(candidate) || !exact(candidate, RECORD_FIELDS)
    || candidate.schema !== DEEP_SHADER_CACHE_SCHEMA
    || candidate.schemaVersion !== DEEP_SHADER_CACHE_SCHEMA_VERSION
    || !safeNonnegative(candidate.storedAtMs) || !safeNonnegative(candidate.expiresAtMs)
    || candidate.expiresAtMs <= candidate.storedAtMs) return undefined;
  const identity = candidate.identity;
  if (!object(identity) || !exact(identity, IDENTITY_FIELDS)) return undefined;
  try {
    const scope = validateShaderCacheScope({
      namespace: identity.namespace,
      packageSchemaVersion: identity.packageSchemaVersion,
      targetProfile: identity.targetProfile,
      compilerVersion: identity.compilerVersion,
      shaderAbiId: identity.shaderAbiId,
      shaderAbiHash: identity.shaderAbiHash,
    } as ShaderCacheIdentity);
    const expected = shaderCacheIdentity(scope, String(identity.packageCacheKey));
    if (shaderPackageStoreKey(expected) !== key) return undefined;
    const result = validateDeepShaderPackage(candidate.package);
    if (!result.valid || !result.value
      || result.value.packageCacheKey !== expected.packageCacheKey) return undefined;
  } catch { return undefined; }
  return candidate as unknown as ShaderPackageCacheRecord;
}

export function parseEntry(key: string, value: unknown): IndexedDbCacheEntry | undefined {
  if (!object(value) || !exact(value, ENTRY_FIELDS) || value.key !== key
    || !safeNonnegative(value.byteLength) || value.byteLength < 1
    || !safeNonnegative(value.accessSequence) || value.accessSequence < 1) return undefined;
  const record = validatePersistentRecord(key, value.record);
  try {
    if (!record || serializedRecordBytes(record) !== value.byteLength) return undefined;
  } catch { return undefined; }
  return value as unknown as IndexedDbCacheEntry;
}

export function parseState(value: unknown): IndexedDbCacheState | undefined {
  if (!object(value) || !exact(value, ["key", "accessSequence", "entries", "bytes"])
    || value.key !== "state" || !safeNonnegative(value.accessSequence)
    || !safeNonnegative(value.entries) || !safeNonnegative(value.bytes)) return undefined;
  return value as unknown as IndexedDbCacheState;
}
