import { validateDeepShaderPackage } from "../shaderPackage/index.js";
import type { DeepShaderPackageV2, ShaderPackagePass } from "../shaderPackage/index.js";
import { SharedOperations } from "./async.js";
import {
  assertPackageMatchesScope, shaderCacheIdentity, shaderPipelineCacheKey,
  shaderPipelineIdentity, validateDeviceEpoch, validateShaderCacheScope,
  validateShaderPipelineCacheKey,
} from "./identity.js";
import { BoundedLru } from "./lru.js";
import { runAllowlistedPrewarm } from "./prewarm.js";
import { ShaderCacheAbortError, ShaderCacheError } from "./types.js";
import type {
  ShaderDevicePipelineCacheOptions, ShaderDevicePipelineCacheStats,
  ShaderPipelineCandidate, ShaderPrewarmOptions, ShaderPrewarmResult,
} from "./types.js";

interface ResolvedCandidate<T extends object> {
  readonly key: string;
  readonly packageValue: DeepShaderPackageV2;
  readonly pass: ShaderPackagePass;
  readonly create: ShaderPipelineCandidate<T>["create"];
}

function validateEntries(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_536) {
    throw new ShaderCacheError("Pipeline cache maxEntries must be an integer from 1 through 65536.", "invalid-config");
  }
  return value;
}

export class ShaderDevicePipelineCache<T extends object> {
  readonly scope;
  private readonly memory: BoundedLru<string, T>;
  private readonly operations = new SharedOperations<T>();
  private readonly disposeValue;
  private epoch: string;
  private generation = 0;

  constructor(options: ShaderDevicePipelineCacheOptions<T>) {
    if (!options || typeof options !== "object") {
      throw new ShaderCacheError("Shader device pipeline cache options are required.", "invalid-config");
    }
    this.scope = validateShaderCacheScope(options.scope);
    this.epoch = validateDeviceEpoch(options.deviceEpoch);
    const entries = validateEntries(options.maxEntries ?? 256);
    this.memory = new BoundedLru(entries, entries);
    if (options.dispose !== undefined && typeof options.dispose !== "function") {
      throw new ShaderCacheError("Pipeline dispose callback must be a function.", "invalid-config");
    }
    this.disposeValue = options.dispose;
  }

  get stats(): ShaderDevicePipelineCacheStats {
    return Object.freeze({
      entries: this.memory.size,
      pendingOperations: this.operations.size,
      deviceEpoch: this.epoch,
    });
  }

  keyFor(packageInput: unknown, passCacheKey: string): string {
    const { packageValue, pass } = this.resolvePackagePass(packageInput, passCacheKey);
    const packageIdentity = shaderCacheIdentity(this.scope, packageValue.packageCacheKey);
    return shaderPipelineCacheKey(shaderPipelineIdentity(packageIdentity, pass.cacheKey, this.epoch));
  }

  getOrCreate(
    packageInput: unknown,
    passCacheKey: string,
    create: ShaderPipelineCandidate<T>["create"],
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new ShaderCacheAbortError());
    }
    const resolved = this.resolveCandidate({ package: packageInput, passCacheKey, create });
    const cached = this.memory.get(resolved.key);
    if (cached !== undefined) return Promise.resolve(cached);
    const generation = this.generation;
    return this.operations.run(resolved.key, async (operationSignal) => {
      const candidate = await resolved.create(resolved.packageValue, resolved.pass, operationSignal);
      if (candidate === null || typeof candidate !== "object") {
        throw new ShaderCacheError("Pipeline factory returned an invalid device object.", "invalid-config");
      }
      if (operationSignal.aborted || generation !== this.generation) {
        this.disposeSafely(candidate);
        throw new ShaderCacheError("Pipeline candidate was invalidated before publication.", "invalidated");
      }
      const evicted = this.memory.set(resolved.key, candidate);
      for (const entry of evicted) this.disposeSafely(entry.value);
      return candidate;
    }, signal);
  }

  prewarm(
    candidates: readonly ShaderPipelineCandidate<T>[],
    options: ShaderPrewarmOptions,
  ): Promise<ShaderPrewarmResult> {
    if (!Array.isArray(candidates) || candidates.length > 512) {
      throw new RangeError("Pipeline prewarm requires at most 512 candidates.");
    }
    const resolved = candidates.map((candidate) => this.resolveCandidate(candidate));
    const byKey = new Map(resolved.map((candidate) => [candidate.key, candidate]));
    if (byKey.size !== resolved.length) throw new TypeError("Pipeline prewarm candidates must be unique.");
    for (const key of options.allowlist) validateShaderPipelineCacheKey(key);
    return runAllowlistedPrewarm(
      resolved.map((candidate) => candidate.key),
      options,
      async (key, signal) => {
        const candidate = byKey.get(key)!;
        await this.getOrCreate(
          candidate.packageValue,
          candidate.pass.cacheKey,
          candidate.create,
          signal,
        );
        return true;
      },
    );
  }

  advanceDeviceEpoch(deviceEpoch: string): void {
    const next = validateDeviceEpoch(deviceEpoch);
    if (next === this.epoch) return;
    this.epoch = next;
    this.invalidateDeviceLocal();
  }

  clearDeviceLocal(): void { this.invalidateDeviceLocal(); }

  private invalidateDeviceLocal(): void {
    this.generation += 1;
    this.operations.abortAll(new ShaderCacheAbortError("Shader device pipeline cache was invalidated."));
    for (const value of this.memory.clear()) this.disposeSafely(value);
  }

  private disposeSafely(value: T): void {
    try { this.disposeValue?.(value); } catch { /* Disposal cannot revive or poison a cache entry. */ }
  }

  private resolveCandidate(candidate: ShaderPipelineCandidate<T>): ResolvedCandidate<T> {
    if (!candidate || typeof candidate !== "object" || typeof candidate.create !== "function") {
      throw new ShaderCacheError("Pipeline cache candidate is invalid.", "invalid-config");
    }
    const { packageValue, pass } = this.resolvePackagePass(candidate.package, candidate.passCacheKey);
    const packageIdentity = shaderCacheIdentity(this.scope, packageValue.packageCacheKey);
    const identity = shaderPipelineIdentity(packageIdentity, pass.cacheKey, this.epoch);
    return Object.freeze({
      key: shaderPipelineCacheKey(identity),
      packageValue,
      pass,
      create: candidate.create,
    });
  }

  private resolvePackagePass(
    input: unknown,
    passCacheKey: string,
  ): { readonly packageValue: DeepShaderPackageV2; readonly pass: ShaderPackagePass } {
    const validation = validateDeepShaderPackage(input);
    if (!validation.valid || !validation.value) {
      throw new ShaderCacheError("Pipeline cache package failed strict validation.", "invalid-package");
    }
    assertPackageMatchesScope(validation.value, this.scope);
    const pass = validation.value.passes.find((candidate) => candidate.cacheKey === passCacheKey);
    if (!pass) throw new ShaderCacheError("Pipeline cache pass does not belong to the package.", "missing-pass");
    return { packageValue: validation.value, pass };
  }
}
