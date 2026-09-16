import { sha256Utf8, validateDeepShaderPackage } from "../shaderPackage/index.js";
import type { DeepShaderPackageV2, ShaderPackagePass } from "../shaderPackage/index.js";
import type {
  ResidencyCacheActivity, ResidencyDiagnosticsHooks, ResidencyOperationOutcome,
} from "../residencyDiagnostics.js";
import { SharedOperations } from "./async.js";
import {
  shaderCacheIdentity, shaderPipelineCacheKey, shaderPipelineIdentity,
  validateDeviceEpoch, validateShaderCacheScope,
} from "./identity.js";
import { BoundedLru } from "./lru.js";
import { ShaderCacheAbortError, ShaderCacheError } from "./types.js";
import type {
  ShaderCacheScope, ShaderDevicePipelineCachePoolOptions, ShaderPipelineAtomicBatch,
} from "./types.js";

interface ResolvedPass {
  readonly key: string;
  readonly pass: ShaderPackagePass;
}

interface BatchEntry<T> {
  readonly key: string;
  readonly value: T;
}

function maxEntries(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_536) {
    throw new ShaderCacheError("Pipeline cache maxEntries must be an integer from 1 through 65536.", "invalid-config");
  }
  return value;
}

/** One globally bounded GPU-local LRU across exact compiler/target/ABI scopes. */
export class ShaderDevicePipelineCachePool<T extends object> {
  private readonly memory: BoundedLru<string, T>;
  private readonly operations = new SharedOperations<readonly BatchEntry<T>[]>();
  private readonly namespace: string;
  private readonly disposeValue;
  private diagnostics: ResidencyDiagnosticsHooks | undefined;
  private epoch: string;
  private generation = 0;

  constructor(options: ShaderDevicePipelineCachePoolOptions<T>) {
    if (!options || typeof options !== "object") {
      throw new ShaderCacheError("Shader device pipeline pool options are required.", "invalid-config");
    }
    this.epoch = validateDeviceEpoch(options.deviceEpoch);
    this.namespace = validateShaderCacheScope({
      namespace: options.namespace,
      packageSchemaVersion: 2,
      targetProfile: "webgpu-wgsl-pipeline-2",
      compilerVersion: "identity-check",
      shaderAbiId: "deep.pbr.mesh.v1",
      shaderAbiHash: "0".repeat(64),
    }).namespace;
    const limit = maxEntries(options.maxEntries ?? 256);
    this.memory = new BoundedLru(limit, limit);
    if (options.dispose !== undefined && typeof options.dispose !== "function") {
      throw new ShaderCacheError("Pipeline dispose callback must be a function.", "invalid-config");
    }
    this.disposeValue = options.dispose;
    this.diagnostics = enabledDiagnostics(options.diagnostics);
    this.safely(() => this.diagnostics!.recorder.beginGeneration({
      generation: this.generation, deviceEpoch: this.epoch,
    }));
  }

  get size(): number { return this.memory.size; }
  get deviceEpoch(): string { return this.epoch; }
  get pendingOperations(): number { return this.operations.size; }

  async getOrCreateAtomic(
    batch: ShaderPipelineAtomicBatch<T>,
    signal?: AbortSignal,
  ): Promise<readonly T[]> {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new ShaderCacheAbortError();
    const { packageValue, passes } = this.resolve(batch);
    const resolved = passes.map((pass) => ({ key: this.keyFor(packageValue, pass), pass }));
    if (this.diagnostics) {
      let hits = 0;
      for (const entry of resolved) if (this.memory.has(entry.key)) hits += 1;
      if (hits) { this.activity("hit", hits); this.activity("reuse", hits); }
      if (hits < resolved.length) this.activity("miss", resolved.length - hits);
    }
    const first = this.readAll(resolved);
    if (first) return first;
    const operationKey = `deep-pipeline-batch/v1/${sha256Utf8(
      resolved.map((entry) => entry.key).slice().sort().join("\n"),
    )}`;
    if (this.diagnostics && this.operations.has(operationKey)) this.activity("reuse", resolved.length);
    const generation = this.generation;
    const deviceEpoch = this.epoch;
    const entries = await this.operations.run(operationKey, async (operationSignal) => {
      const existing = new Map<string, T>();
      for (const entry of resolved) {
        const value = this.memory.get(entry.key);
        if (value !== undefined) existing.set(entry.key, value);
      }
      const missing = resolved.filter((entry) => !existing.has(entry.key));
      if (missing.length === 0) return resolved.map((entry) => ({ key: entry.key, value: existing.get(entry.key)! }));
      let created: readonly T[];
      const startedAt = this.readClock();
      try {
        created = await batch.create(packageValue, missing.map((entry) => entry.pass), operationSignal);
        if (!Array.isArray(created) || created.length !== missing.length
          || created.some((value) => value === null || typeof value !== "object")) {
          for (const value of created ?? []) if (value && typeof value === "object") this.disposeSafely(value);
          throw new ShaderCacheError("Atomic pipeline factory returned an invalid candidate set.", "invalid-config");
        }
      } catch (error) {
        this.timing(operationSignal.aborted ? "aborted" : "failure", startedAt, generation, deviceEpoch);
        throw error;
      }
      if (operationSignal.aborted || generation !== this.generation) {
        this.timing("aborted", startedAt, generation, deviceEpoch);
        for (const value of created) this.disposeSafely(value);
        throw new ShaderCacheError("Atomic pipeline batch was invalidated before publication.", "invalidated");
      }
      this.timing("success", startedAt, generation, deviceEpoch);
      const createdByKey = new Map(missing.map((entry, index) => [entry.key, created[index]!]));
      for (const entry of missing) {
        const concurrent = this.memory.get(entry.key);
        if (concurrent === undefined) continue;
        this.disposeSafely(createdByKey.get(entry.key)!);
        createdByKey.set(entry.key, concurrent);
      }
      // Publication is one synchronous section. A failed factory publishes none. A batch larger than
      // the LRU still succeeds but is not cached, so eviction never invalidates the returned objects.
      if (resolved.length <= this.memory.maxEntries) {
        missing.forEach((entry, index) => {
          if (this.memory.has(entry.key)) return;
          for (const evicted of this.memory.set(entry.key, createdByKey.get(entry.key) ?? created[index]!)) {
            this.activity("evict", 1);
            this.disposeSafely(evicted.value);
          }
        });
      }
      return resolved.map((entry) => ({
        key: entry.key,
        value: this.memory.get(entry.key) ?? createdByKey.get(entry.key)!,
      }));
    }, signal);
    const byKey = new Map(entries.map((entry) => [entry.key, entry.value]));
    return Object.freeze(resolved.map((entry) => byKey.get(entry.key)!));
  }

  advanceDeviceEpoch(deviceEpoch: string): void {
    const next = validateDeviceEpoch(deviceEpoch);
    if (next === this.epoch) return;
    this.epoch = next;
    this.clearDeviceLocal();
  }

  clearDeviceLocal(): void {
    this.generation += 1;
    this.operations.abortAll(new ShaderCacheAbortError("Shader device pipeline pool was invalidated."));
    const cleared = this.memory.clear();
    this.safely(() => this.diagnostics!.recorder.beginGeneration({
      generation: this.generation, deviceEpoch: this.epoch,
    }));
    if (cleared.length) this.activity("evict", cleared.length);
    for (const value of cleared) this.disposeSafely(value);
  }

  private resolve(batch: ShaderPipelineAtomicBatch<T>): {
    readonly packageValue: DeepShaderPackageV2; readonly passes: readonly ShaderPackagePass[];
  } {
    if (!batch || typeof batch !== "object" || typeof batch.create !== "function"
      || !Array.isArray(batch.passCacheKeys) || batch.passCacheKeys.length === 0) {
      throw new ShaderCacheError("Atomic pipeline batch is invalid.", "invalid-config");
    }
    const validation = validateDeepShaderPackage(batch.package);
    if (!validation.valid || !validation.value) {
      throw new ShaderCacheError("Pipeline cache package failed strict validation.", "invalid-package");
    }
    if (new Set(batch.passCacheKeys).size !== batch.passCacheKeys.length) {
      throw new ShaderCacheError("Atomic pipeline pass keys must be unique.", "invalid-config");
    }
    const passes = batch.passCacheKeys.map((key) => {
      const pass = validation.value!.passes.find((candidate) => candidate.cacheKey === key);
      if (!pass) throw new ShaderCacheError("Pipeline cache pass does not belong to the package.", "missing-pass");
      return pass;
    });
    return { packageValue: validation.value, passes };
  }

  private keyFor(packageValue: DeepShaderPackageV2, pass: ShaderPackagePass): string {
    const scope: ShaderCacheScope = validateShaderCacheScope({
      namespace: this.namespace,
      packageSchemaVersion: packageValue.schemaVersion,
      targetProfile: packageValue.targetProfile,
      compilerVersion: packageValue.compilerVersion,
      shaderAbiId: packageValue.shaderAbi.id,
      shaderAbiHash: packageValue.shaderAbi.contentHash.value,
    });
    return shaderPipelineCacheKey(shaderPipelineIdentity(
      shaderCacheIdentity(scope, packageValue.packageCacheKey), pass.cacheKey, this.epoch,
    ));
  }

  private readAll(resolved: readonly ResolvedPass[]): readonly T[] | undefined {
    const result = resolved.map((entry) => this.memory.get(entry.key));
    return result.every((value) => value !== undefined) ? Object.freeze(result as T[]) : undefined;
  }

  private disposeSafely(value: T): void {
    try { this.disposeValue?.(value); } catch { /* Disposal cannot poison cache state. */ }
  }

  private activity(activity: ResidencyCacheActivity, count: number): void {
    this.safely(() => this.diagnostics!.recorder.record({ kind: "activity", domain: "pipeline",
      activity, count, generation: this.generation, deviceEpoch: this.epoch }));
  }

  private readClock(): number | undefined {
    if (!this.diagnostics) return undefined;
    try {
      const value = this.diagnostics.clock.now();
      if (!Number.isFinite(value) || value < 0) throw new Error("Invalid diagnostics clock.");
      return value;
    } catch { this.diagnostics = undefined; return undefined; }
  }

  private timing(outcome: ResidencyOperationOutcome, startedAt: number | undefined,
    generation: number, deviceEpoch: string): void {
    if (startedAt === undefined || !this.diagnostics) return;
    const endedAt = this.readClock();
    if (endedAt === undefined || endedAt < startedAt) { this.diagnostics = undefined; return; }
    this.safely(() => this.diagnostics!.recorder.record({ kind: "timing", domain: "pipeline",
      operation: "compile", outcome, durationMs: endedAt - startedAt, generation, deviceEpoch }));
  }

  private safely(operation: () => void): void {
    if (!this.diagnostics) return;
    try { operation(); } catch { this.diagnostics = undefined; }
  }
}

function enabledDiagnostics(value: ResidencyDiagnosticsHooks | undefined): ResidencyDiagnosticsHooks | undefined {
  if (!value) return undefined;
  if (!value.recorder || typeof value.recorder.enabled !== "boolean"
    || typeof value.recorder.beginGeneration !== "function" || typeof value.recorder.record !== "function"
    || typeof value.clock?.now !== "function") {
    throw new ShaderCacheError("Pipeline diagnostics hooks are invalid.", "invalid-config");
  }
  return value.recorder.enabled ? value : undefined;
}
