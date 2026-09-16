/// <reference types="@webgpu/types" />
import type { DeviceSession } from "@bim-studio/deep-engine/webgpu";
import { createCombinedLoadBenchmarkPlan, type CombinedLoadScenario } from "./combinedLoadBenchmarkPlan.js";
import { runCombinedLoadBenchmark, type CombinedLoadBenchmarkAdapter,
  type CombinedLoadBenchmarkResult, type CombinedLoadResourceSnapshot } from "./combinedLoadBenchmarkRunner.js";
import { runGpuLodSelectionProbe } from "./gpuLodSelectionProbe.js";
import { verifyGpuMixedResidency } from "./gpuMixedResidencyProbe.js";
import { runHiZOcclusionProbe } from "./hiZOcclusionProbe.js";
import { runMeshletIndirectProbe } from "./meshletIndirectProbe.js";

export interface CombinedLoadWebGpuProbeResult {
  readonly action: "combined-large-scene-load";
  readonly success: boolean;
  readonly evidence: CombinedLoadBenchmarkResult | null;
  readonly gpuTiming: "timestamp-query" | "unavailable";
  readonly plannedPeakResidentBytes: number;
  readonly resourcesReturnedToBaseline: boolean;
  readonly failure?: string;
}

/** Dedicated opt-in real-device gate. GPU time stays null because the composed probes expose no shared timestamp scope. */
export async function runCombinedLoadWebGpuProbe(
  session: DeviceSession,
  signal?: AbortSignal,
  clock: () => number = () => performance.now(),
): Promise<CombinedLoadWebGpuProbeResult> {
  if (session.state !== "ready") throw new Error("Combined load probe requires a ready device session.");
  const plan = createCombinedLoadBenchmarkPlan();
  const baseline = session.resourceCount;
  const adapter = new WebGpuCombinedLoadAdapter(session, plan.profile.objectCount);
  try {
    const evidence = await runCombinedLoadBenchmark(plan, adapter, clock, signal);
    return Object.freeze({ action: "combined-large-scene-load", success: true, evidence,
      gpuTiming: "unavailable", plannedPeakResidentBytes: Math.max(...plan.scenarios
        .map(item => item.residency.transitionPeakBytes)), resourcesReturnedToBaseline: true });
  } catch (error) {
    return Object.freeze({ action: "combined-large-scene-load", success: false, evidence: null,
      gpuTiming: "unavailable", plannedPeakResidentBytes: Math.max(...plan.scenarios
        .map(item => item.residency.transitionPeakBytes)),
      resourcesReturnedToBaseline: session.resourceCount === baseline,
      failure: error instanceof Error ? error.message : String(error) });
  }
}

class WebGpuCombinedLoadAdapter implements CombinedLoadBenchmarkAdapter {
  private readonly baseline: number;

  constructor(private readonly session: DeviceSession, private readonly objectCount: number) {
    this.baseline = session.resourceCount;
  }

  snapshot(): CombinedLoadResourceSnapshot {
    return Object.freeze({ resourceCount: this.session.resourceCount, residentBytes: 0, allocatedBytes: 0 });
  }

  async execute(scenario: CombinedLoadScenario, _frame: number,
    signal?: AbortSignal) {
    throwIfAborted(signal);
    const lod = await runGpuLodSelectionProbe(this.session, this.objectCount);
    throwIfAborted(signal);
    const occlusion = scenario === "occluded"
      ? await runHiZOcclusionProbe(this.session, this.objectCount) : undefined;
    throwIfAborted(signal);
    const indirect = await runMeshletIndirectProbe(this.session, this.objectCount);
    throwIfAborted(signal);
    const residency = await verifyGpuMixedResidency(this.session);
    const errors: string[] = [];
    if (!lod.passed) errors.push("GPU LOD probe failed");
    if (occlusion && !occlusion.passed) errors.push("Hi-Z occlusion probe failed");
    if (!indirect.passed) errors.push("meshlet indirect probe failed");
    if (!residency.success) errors.push(residency.failure ?? "GPU residency probe failed");
    return Object.freeze({ gpuFrameMs: null, passed: errors.length === 0, errors: Object.freeze(errors),
      resourceCount: Math.max(this.session.resourceCount, residency.resourcesHeldAfterDispose,
        lod.peakResourceCount, occlusion?.peakResourceCount ?? 0, indirect.peakResourceCount),
      residentBytes: residency.peakResidentBytes, allocatedBytes: residency.peakAllocatedBytes,
      workload: Object.freeze({ lodInputCount: lod.objectCount, lodRecordCount: lod.recordCount,
        hiZInputCount: occlusion?.inputCount ?? null, hiZVisibleCount: occlusion?.visibleCount ?? null,
        meshletInputCount: indirect.meshletCount, indirectCommandCount: indirect.validCommandCount }) });
  }

  async unload(): Promise<void> {
    if (this.session.resourceCount !== this.baseline) throw new Error("Combined GPU probes leaked resources.");
  }

  async recover(): Promise<void> {
    if (this.session.resourceCount !== this.baseline) throw new Error("Combined GPU probe recovery found leaked resources.");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Combined GPU load probe was aborted.",
    signal.reason === undefined ? undefined : { cause: signal.reason });
  error.name = "AbortError"; throw error;
}
