import { canonicalShaderPackageJson, sha256Utf8 } from "../shaderPackage/index.js";
import type { DeepShaderPackageV2 } from "../shaderPackage/index.js";
import { ShaderCacheError } from "./types.js";
import type { ShaderCacheIdentity, ShaderCacheScope, ShaderPipelineIdentity } from "./types.js";

const HASH = /^[0-9a-f]{64}$/;
const NAMESPACE = /^[a-z][a-z0-9._-]{0,63}$/;
const VERSION = /^[0-9A-Za-z](?:[0-9A-Za-z._+-]{0,63})$/;
const EPOCH = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/;
const SCOPE_FIELDS = [
  "namespace", "packageSchemaVersion", "targetProfile", "compilerVersion",
  "shaderAbiId", "shaderAbiHash",
];

function invalid(message: string): never {
  throw new ShaderCacheError(message, "invalid-identity");
}

export function validateShaderCacheScope(scope: ShaderCacheScope): ShaderCacheScope {
  if (!scope || typeof scope !== "object") invalid("Shader cache scope must be an object.");
  const keys = Object.keys(scope);
  if (keys.length !== SCOPE_FIELDS.length || keys.some((key) => !SCOPE_FIELDS.includes(key))) {
    invalid("Shader cache scope contains unknown or missing fields.");
  }
  if (typeof scope.namespace !== "string" || !NAMESPACE.test(scope.namespace)) invalid("Shader cache namespace is not canonical.");
  if (scope.packageSchemaVersion !== 2) invalid("Shader cache requires package schema v2.");
  if (scope.targetProfile !== "webgpu-wgsl-pipeline-2") invalid("Shader cache target profile is unsupported.");
  if (typeof scope.compilerVersion !== "string" || !VERSION.test(scope.compilerVersion)) invalid("Shader cache compiler version is not canonical.");
  if (scope.shaderAbiId !== "deep.pbr.mesh.v1" && scope.shaderAbiId !== "deep.pbr.mesh.v2") {
    invalid("Shader cache ABI ID is unsupported.");
  }
  if (typeof scope.shaderAbiHash !== "string" || !HASH.test(scope.shaderAbiHash)) invalid("Shader cache ABI hash is not canonical SHA-256.");
  return Object.freeze({ ...scope });
}

export function assertPackageMatchesScope(
  packageValue: DeepShaderPackageV2,
  scope: ShaderCacheScope,
): void {
  if (packageValue.schemaVersion !== scope.packageSchemaVersion
    || packageValue.targetProfile !== scope.targetProfile
    || packageValue.compilerVersion !== scope.compilerVersion
    || packageValue.shaderAbi.id !== scope.shaderAbiId
    || packageValue.shaderAbi.contentHash.value !== scope.shaderAbiHash) {
    throw new ShaderCacheError("Shader package does not match cache compiler, target, or ABI scope.", "scope-mismatch");
  }
}

export function shaderCacheIdentity(
  scope: ShaderCacheScope,
  packageCacheKey: string,
): ShaderCacheIdentity {
  if (typeof packageCacheKey !== "string" || !HASH.test(packageCacheKey)) invalid("Shader package cache key is not canonical SHA-256.");
  return Object.freeze({ ...scope, packageCacheKey });
}

export function shaderPackageStoreKey(identity: ShaderCacheIdentity): string {
  return `deep-shader-cache/v1/${sha256Utf8(canonicalShaderPackageJson(identity))}`;
}

export function validateDeviceEpoch(deviceEpoch: string): string {
  if (typeof deviceEpoch !== "string" || !EPOCH.test(deviceEpoch)) invalid("Shader device epoch is not canonical.");
  return deviceEpoch;
}

export function shaderPipelineIdentity(
  identity: ShaderCacheIdentity,
  passCacheKey: string,
  deviceEpoch: string,
): ShaderPipelineIdentity {
  if (typeof passCacheKey !== "string" || !HASH.test(passCacheKey)) invalid("Shader pass cache key is not canonical SHA-256.");
  validateDeviceEpoch(deviceEpoch);
  return Object.freeze({ ...identity, passCacheKey, deviceEpoch });
}

export function shaderPipelineCacheKey(identity: ShaderPipelineIdentity): string {
  return `deep-pipeline-cache/v1/${sha256Utf8(canonicalShaderPackageJson(identity))}`;
}

export function validateShaderPipelineCacheKey(key: string): string {
  if (typeof key !== "string" || !/^deep-pipeline-cache\/v1\/[0-9a-f]{64}$/.test(key)) {
    invalid("Shader pipeline allowlist key is not a canonical complete identity.");
  }
  return key;
}

export function sameShaderCacheIdentity(a: ShaderCacheIdentity, b: ShaderCacheIdentity): boolean {
  return a.namespace === b.namespace
    && a.packageSchemaVersion === b.packageSchemaVersion
    && a.targetProfile === b.targetProfile
    && a.compilerVersion === b.compilerVersion
    && a.shaderAbiId === b.shaderAbiId
    && a.shaderAbiHash === b.shaderAbiHash
    && a.packageCacheKey === b.packageCacheKey;
}
