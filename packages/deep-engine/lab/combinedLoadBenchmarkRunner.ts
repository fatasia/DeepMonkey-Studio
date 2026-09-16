import { COMBINED_LOAD_SCENARIOS, type CombinedLoadBenchmarkPlan,
  type CombinedLoadScenario } from "./combinedLoadBenchmarkPlan.js";

export interface CombinedLoadResourceSnapshot {
  readonly resourceCount: number;
  readonly residentBytes: number;
  readonly allocatedBytes: number;
}

export interface CombinedLoadFrameObservation extends CombinedLoadResourceSnapshot {
  /** GPU timestamp in milliseconds; null means the device did not expose timestamp-query evidence. */
  readonly gpuFrameMs: number | null;
  readonly passed: boolean;
  readonly errors: readonly string[];
  readonly workload: CombinedLoadGpuWorkloadEvidence;
}

export interface CombinedLoadGpuWorkloadEvidence {
  readonly lodInputCount: number;
  readonly lodRecordCount: number;
  readonly hiZInputCount: number | null;
  readonly hiZVisibleCount: number | null;
  readonly meshletInputCount: number;
  readonly indirectCommandCount: number;
}

export interface CombinedLoadBenchmarkAdapter {
  snapshot(): CombinedLoadResourceSnapshot;
  execute(scenario: CombinedLoadScenario, frame: number, signal?: AbortSignal): Promise<CombinedLoadFrameObservation>;
  unload(): Promise<void>;
  recover(): Promise<void>;
}

export interface CombinedLoadScenarioResult {
  readonly scenario: CombinedLoadScenario;
  readonly sampleCount: number;
  /** End-to-end wall time; it is not presented as CPU-only or GPU-only throughput. */
  readonly frameWallP50Ms: number;
  readonly frameWallP95Ms: number;
  readonly frameWallP99Ms: number;
  readonly gpuFrameP50Ms: number | null;
  readonly gpuFrameP95Ms: number | null;
  readonly gpuFrameP99Ms: number | null;
  readonly peakResourceCount: number;
  readonly peakResidentBytes: number;
  readonly peakAllocatedBytes: number;
  readonly workload: CombinedLoadGpuWorkloadEvidence;
}

export interface CombinedLoadBenchmarkResult {
  readonly schema: 1;
  readonly status: "passed";
  readonly scenarios: readonly CombinedLoadScenarioResult[];
  readonly baseline: CombinedLoadResourceSnapshot;
  readonly afterUnload: CombinedLoadResourceSnapshot;
  readonly resourcesReturnedToBaseline: boolean;
}

/** Runs fixed frames only. The injected monotonic clock and GPU adapter are the sole timing sources. */
export async function runCombinedLoadBenchmark(
  plan: CombinedLoadBenchmarkPlan,
  adapter: CombinedLoadBenchmarkAdapter,
  clock: () => number,
  signal?: AbortSignal,
): Promise<CombinedLoadBenchmarkResult> {
  validateBindings(plan, adapter, clock, signal);
  const baseline = validSnapshot(adapter.snapshot());
  const results: CombinedLoadScenarioResult[] = [];
  try {
    for (const scenario of COMBINED_LOAD_SCENARIOS) {
      const definition = plan.scenarios.find(item => item.scenario === scenario);
      if (!definition) throw new Error(`Combined load plan lacks ${scenario}.`);
      const cpu: number[] = [], gpu: number[] = [];
      let peakResourceCount = baseline.resourceCount;
      let peakResidentBytes = baseline.residentBytes, peakAllocatedBytes = baseline.allocatedBytes;
      let workload: CombinedLoadGpuWorkloadEvidence | undefined;
      for (let sample = 0; sample < plan.profile.samplesPerScenario; sample += 1) {
        throwIfAborted(signal);
        const before = finiteTime(clock()), observed = validObservation(await adapter.execute(
          scenario, definition.frame + sample, signal));
        const elapsed = finiteTime(clock()) - before;
        if (elapsed < 0) throw new Error("Combined load benchmark clock regressed.");
        if (!observed.passed || observed.errors.length) {
          throw new Error(`${scenario} GPU frame failed: ${observed.errors.join("; ") || "probe failed"}.`);
        }
        if (observed.allocatedBytes > plan.profile.maxResidentBytes) {
          throw new Error(`${scenario} exceeded the fixed resident-byte budget.`);
        }
        if (observed.workload.lodInputCount !== plan.profile.objectCount
          || observed.workload.lodRecordCount !== plan.profile.objectCount
          || observed.workload.meshletInputCount !== plan.profile.objectCount
          || observed.workload.indirectCommandCount !== plan.profile.objectCount
          || (scenario === "occluded" && (observed.workload.hiZInputCount !== plan.profile.objectCount
            || observed.workload.hiZVisibleCount !== plan.profile.objectCount / 2))
          || (scenario !== "occluded" && (observed.workload.hiZInputCount !== null
            || observed.workload.hiZVisibleCount !== null))) {
          throw new Error(`${scenario} did not execute the frozen GPU object count.`);
        }
        if (workload && JSON.stringify(workload) !== JSON.stringify(observed.workload)) {
          throw new Error(`${scenario} GPU workload changed across samples.`);
        }
        workload = observed.workload;
        cpu.push(elapsed); if (observed.gpuFrameMs !== null) gpu.push(observed.gpuFrameMs);
        peakResourceCount = Math.max(peakResourceCount, observed.resourceCount);
        peakResidentBytes = Math.max(peakResidentBytes, observed.residentBytes);
        peakAllocatedBytes = Math.max(peakAllocatedBytes, observed.allocatedBytes);
      }
      results.push(Object.freeze({ scenario, sampleCount: cpu.length,
        frameWallP50Ms: percentile(cpu, 0.5), frameWallP95Ms: percentile(cpu, 0.95),
        frameWallP99Ms: percentile(cpu, 0.99),
        gpuFrameP50Ms: gpu.length === cpu.length ? percentile(gpu, 0.5) : null,
        gpuFrameP95Ms: gpu.length === cpu.length ? percentile(gpu, 0.95) : null,
        gpuFrameP99Ms: gpu.length === cpu.length ? percentile(gpu, 0.99) : null,
        peakResourceCount, peakResidentBytes, peakAllocatedBytes, workload: workload! }));
    }
    await adapter.unload();
    const afterUnload = validSnapshot(adapter.snapshot());
    const resourcesReturnedToBaseline = sameSnapshot(baseline, afterUnload);
    if (!resourcesReturnedToBaseline) throw new Error("Combined load resources did not return to baseline.");
    return Object.freeze({ schema: 1, status: "passed", scenarios: Object.freeze(results),
      baseline, afterUnload, resourcesReturnedToBaseline });
  } catch (error) {
    try { await adapter.recover(); }
    catch (recoveryError) {
      throw new AggregateError([error, recoveryError], "Combined load benchmark and recovery failed.");
    }
    throw error;
  }
}

function percentile(values: readonly number[], quantile: number): number {
  if (!values.length) throw new Error("Combined load benchmark has no samples.");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((sorted.length - 1) * quantile)]!;
}

function validObservation(value: CombinedLoadFrameObservation): CombinedLoadFrameObservation {
  validSnapshot(value);
  if (value.gpuFrameMs !== null && (!Number.isFinite(value.gpuFrameMs) || value.gpuFrameMs < 0)) {
    throw new TypeError("Combined load GPU time is invalid.");
  }
  if (typeof value.passed !== "boolean" || !Array.isArray(value.errors)
    || value.errors.some(error => typeof error !== "string" || !error)
    || !validWorkload(value.workload)) {
    throw new TypeError("Combined load observation is invalid.");
  }
  return value;
}

function validWorkload(value: CombinedLoadGpuWorkloadEvidence): boolean {
  if (!value || typeof value !== "object") return false;
  const required = [value.lodInputCount, value.lodRecordCount,
    value.meshletInputCount, value.indirectCommandCount];
  const optional = [value.hiZInputCount, value.hiZVisibleCount];
  return required.every(item => Number.isSafeInteger(item) && item >= 0)
    && optional.every(item => item === null || (Number.isSafeInteger(item) && item >= 0));
}

function validSnapshot(value: CombinedLoadResourceSnapshot): CombinedLoadResourceSnapshot {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.resourceCount)
    || value.resourceCount < 0 || ![value.residentBytes, value.allocatedBytes]
      .every(item => Number.isSafeInteger(item) && item >= 0)
    || value.residentBytes > value.allocatedBytes) {
    throw new TypeError("Combined load resource snapshot is invalid.");
  }
  return Object.freeze({ ...value });
}

function sameSnapshot(left: CombinedLoadResourceSnapshot, right: CombinedLoadResourceSnapshot): boolean {
  return left.resourceCount === right.resourceCount && left.residentBytes === right.residentBytes
    && left.allocatedBytes === right.allocatedBytes;
}

function finiteTime(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError("Combined load benchmark clock is invalid.");
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Combined load benchmark was aborted.",
    signal.reason === undefined ? undefined : { cause: signal.reason });
  error.name = "AbortError"; throw error;
}

function validateBindings(plan: CombinedLoadBenchmarkPlan, adapter: CombinedLoadBenchmarkAdapter,
  clock: () => number, signal?: AbortSignal): void {
  if (!plan || plan.schema !== 1 || !Array.isArray(plan.scenarios)
    || !adapter || typeof adapter.snapshot !== "function" || typeof adapter.execute !== "function"
    || typeof adapter.unload !== "function" || typeof adapter.recover !== "function"
    || typeof clock !== "function" || (signal !== undefined
      && (typeof signal !== "object" || typeof signal.aborted !== "boolean"))) {
    throw new TypeError("Combined load benchmark bindings are invalid.");
  }
}
