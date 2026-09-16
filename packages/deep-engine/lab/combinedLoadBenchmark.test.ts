import { describe, expect, it } from "vitest";
import { createCombinedLoadBenchmarkPlan, DEFAULT_COMBINED_LOAD_PROFILE,
  type CombinedLoadScenario } from "./combinedLoadBenchmarkPlan.js";
import { runCombinedLoadBenchmark, type CombinedLoadBenchmarkAdapter,
  type CombinedLoadResourceSnapshot } from "./combinedLoadBenchmarkRunner.js";

describe("combined large-scene load benchmark", () => {
  it("builds a deterministic 10k octree/LOD/residency plan with fixed budgets", () => {
    const first = createCombinedLoadBenchmarkPlan();
    const second = createCombinedLoadBenchmarkPlan();
    expect(second).toEqual(first);
    expect(first.profile).toEqual(DEFAULT_COMBINED_LOAD_PROFILE);
    expect(first.scenarios.map(item => item.scenario)).toEqual(["open", "occluded", "dynamic"]);
    expect(first.scenarios.every(item => item.matchedObjects === 10_000)).toBe(true);
    expect(first.scenarios.every(item => item.submittedObjects === 2_048)).toBe(true);
    expect(first.scenarios.every(item => item.renderedObjects <= 1_024
      && item.renderedTriangles <= 32_768)).toBe(true);
    expect(first.scenarios.every(item => item.residency.uploadBytes <= 256 * 1024
      && item.residency.transitionPeakBytes <= 512 * 1024)).toBe(true);
    expect(first.scenarios[1]).toMatchObject({ postOcclusionDemandCount: 512,
      gpuStages: ["gpu-lod", "hi-z", "meshlet-indirect", "residency"] });
    expect(first.scenarios[2]!.registryGeneration - first.scenarios[1]!.registryGeneration).toBe(512);
    expect(first.unload.residentBytesBefore).toBeGreaterThan(0);
    expect(first.unload).toMatchObject({ residentBytesAfter: 0 });
  });

  it("records injected frame timings and returns resources to the exact baseline", async () => {
    const plan = createCombinedLoadBenchmarkPlan(smallProfile());
    const adapter = new FakeAdapter(); let clock = 0;
    const result = await runCombinedLoadBenchmark(plan, adapter, () => clock++);
    expect(result.status).toBe("passed");
    expect(result.scenarios).toHaveLength(3);
    expect(result.scenarios.every(item => item.sampleCount === 2
      && item.frameWallP50Ms === 1 && item.frameWallP99Ms === 1)).toBe(true);
    expect(result.scenarios.map(item => item.gpuFrameP95Ms)).toEqual([0.4, 0.5, 0.6]);
    expect(result.scenarios.map(item => item.peakResidentBytes)).toEqual([64, 64, 64]);
    expect(result.resourcesReturnedToBaseline).toBe(true);
    expect(adapter.unloads).toBe(1);
  });

  it("recovers atomically after a failed frame or fixed-budget violation", async () => {
    const plan = createCombinedLoadBenchmarkPlan(smallProfile());
    const failure = new FakeAdapter(); failure.failAt = 2;
    await expect(runCombinedLoadBenchmark(plan, failure, tickingClock())).rejects.toThrow("probe failed");
    expect(failure.recoveries).toBe(1);
    expect(failure.snapshot()).toEqual({ resourceCount: 0, residentBytes: 0, allocatedBytes: 0 });

    const overBudget = new FakeAdapter(); overBudget.overrideAllocatedBytes = 129;
    await expect(runCombinedLoadBenchmark(plan, overBudget, tickingClock())).rejects
      .toThrow("exceeded the fixed resident-byte budget");
    expect(overBudget.recoveries).toBe(1);
  });

  it("honours cancellation before work and still performs recovery", async () => {
    const plan = createCombinedLoadBenchmarkPlan(smallProfile());
    const adapter = new FakeAdapter(), controller = new AbortController();
    controller.abort("superseded");
    await expect(runCombinedLoadBenchmark(plan, adapter, tickingClock(), controller.signal))
      .rejects.toMatchObject({ name: "AbortError", cause: "superseded" });
    expect(adapter.executions).toBe(0);
    expect(adapter.recoveries).toBe(1);
  });
});

class FakeAdapter implements CombinedLoadBenchmarkAdapter {
  private current: CombinedLoadResourceSnapshot = { resourceCount: 0, residentBytes: 0, allocatedBytes: 0 };
  executions = 0; unloads = 0; recoveries = 0; failAt = -1;
  overrideAllocatedBytes: number | undefined;

  snapshot(): CombinedLoadResourceSnapshot { return { ...this.current }; }

  async execute(scenario: CombinedLoadScenario) {
    this.executions += 1;
    const gpuFrameMs = { open: 0.4, occluded: 0.5, dynamic: 0.6 }[scenario];
    const allocatedBytes = this.overrideAllocatedBytes ?? 64;
    this.current = { resourceCount: 4, residentBytes: Math.min(64, allocatedBytes), allocatedBytes };
    return { ...this.current, gpuFrameMs, passed: this.executions !== this.failAt,
      errors: this.executions === this.failAt ? ["probe failed"] : [],
      workload: { lodInputCount: 32, lodRecordCount: 32,
        hiZInputCount: scenario === "occluded" ? 32 : null,
        hiZVisibleCount: scenario === "occluded" ? 16 : null,
        meshletInputCount: 32, indirectCommandCount: 32 } };
  }

  async unload(): Promise<void> {
    this.unloads += 1; this.current = { resourceCount: 0, residentBytes: 0, allocatedBytes: 0 };
  }

  async recover(): Promise<void> {
    this.recoveries += 1; this.current = { resourceCount: 0, residentBytes: 0, allocatedBytes: 0 };
  }
}

function smallProfile() {
  return { ...DEFAULT_COMBINED_LOAD_PROFILE, objectCount: 32, maxQueryCandidates: 16,
    maxRenderedObjects: 8, maxTriangles: 256, dynamicUpdates: 4,
    maxResidentBytes: 128, maxUploadBytesPerFrame: 64, samplesPerScenario: 2 };
}

function tickingClock(): () => number {
  let time = 0; return () => time++;
}
