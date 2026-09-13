import { describe, expect, it } from "vitest";
import type { BenchmarkBackend, BenchmarkFrameStats } from "./benchmarkBackend.js";
import { summarizeBenchmarkImage, type BenchmarkImage } from "./benchmarkImage.js";
import { createBenchmarkScene } from "./benchmarkScene.js";
import { runCompetitiveBenchmark } from "./competitiveBenchmarkRunner.js";
import { BENCHMARK_FIDELITY_IDS, type BenchmarkFidelityId,
  type BenchmarkFidelitySnapshot, type BenchmarkProfile } from "./benchmarkProfile.js";

class FakeBackend implements BenchmarkBackend {
  readonly version = "test"; readonly adapter = { vendor: "test" }; frames = 0;
  readonly fidelity: BenchmarkFidelitySnapshot;
  private instrumentation: boolean | undefined;
  constructor(readonly id: BenchmarkBackend["id"], private readonly color: number,
    readonly timestampSupported = false, readonly profile: BenchmarkProfile = "baseline-equivalent",
    fidelityPatch: Partial<Record<BenchmarkFidelityId, unknown>> = {}) {
    this.fidelity = fakeFidelity(profile, fidelityPatch);
  }
  render(): BenchmarkFrameStats {
    if (this.timestampSupported && this.instrumentation !== true) throw new Error("instrumentation was not frozen");
    this.frames++; return { drawCalls: 1, triangles: 1_920_000, resources: 4,
      cpuStages: { renderCallMs: 0.25, statisticsReadMs: 0.01 } };
  }
  setGpuInstrumentation(enabled: boolean): void { this.instrumentation = enabled; }
  async settle(): Promise<void> {}
  async measureGpuFrame(): Promise<number | null> { return this.timestampSupported ? 0.5 : null; }
  async capture(): Promise<BenchmarkImage> {
    const rgba = new Uint8ClampedArray(8 * 8 * 4);
    for (let pixel = 0; pixel < 64; pixel++) rgba.set(pixel < 32
      ? [12, 16, 22, 255] : [this.color, this.color - 10, this.color - 20, 255], pixel * 4);
    return summarizeBenchmarkImage(8, 8, rgba);
  }
  errors(): readonly string[] { return []; }
  dispose(): void {}
}

class BlankBackend extends FakeBackend {
  override async capture(): Promise<BenchmarkImage> {
    return { width: 4, height: 4, rgba: new Uint8ClampedArray(64), sha256: "0".repeat(64),
      meanLuminance: 0, geometryDetailFraction: 0 };
  }
}

describe("competitive benchmark runner", () => {
  it("alternates complete engine runs and withholds ranking for known quality gaps", async () => {
    const candidate = new FakeBackend("deep-webgpu", 128, false, "high-native");
    const reference = new FakeBackend("three-webgpu", 128, false, "high-native");
    const progress: string[] = [];
    const report = await runCompetitiveBenchmark(createBenchmarkScene(1_024), candidate, reference,
      { pairRounds: 5, warmupFrames: 10, cpuSampleFrames: 30, gpuSampleFrames: 0 }, undefined,
      value => { if (value.phase === "warmup") progress.push(`${value.round}:${value.engine}`); });
    expect(progress).toEqual([
      "1:deep-webgpu", "1:three-webgpu", "2:three-webgpu", "2:deep-webgpu",
      "3:deep-webgpu", "3:three-webgpu", "4:three-webgpu", "4:deep-webgpu",
      "5:deep-webgpu", "5:three-webgpu",
    ]);
    expect(candidate.frames).toBe(200); expect(reference.frames).toBe(200);
    expect(report.evaluation).toMatchObject({ status: "degraded", outcome: "withheld",
      benchmark: { valid: true } });
    expect(report.rounds.every(round => round.visualSimilarity === 1)).toBe(true);
    expect(report.cpuBreakdown[0]?.candidate.renderCallMs.p95).toBe(0.25);
  });

  it("propagates page faults into an invalid machine-readable result", async () => {
    const report = await runCompetitiveBenchmark(createBenchmarkScene(1_024),
      new FakeBackend("deep-webgpu", 128), new FakeBackend("three-webgpu", 128),
      { pairRounds: 5, warmupFrames: 10, cpuSampleFrames: 30, gpuSampleFrames: 0 },
      undefined, undefined, ["unhandled rejection"]);
    expect(report.evaluation.status).toBe("invalid");
    expect(report.evaluation.issues).toContain("page error: unhandled rejection");
  });

  it("freezes paired GPU instrumentation before warmup", async () => {
    const report = await runCompetitiveBenchmark(createBenchmarkScene(1_024),
      new FakeBackend("deep-webgpu", 128, true), new FakeBackend("three-webgpu", 128, true),
      { pairRounds: 5, warmupFrames: 10, cpuSampleFrames: 30, gpuSampleFrames: 1 });
    expect(report.timing.instrumentationEnabled).toBe(true);
    expect(report.rounds.every(round => round.candidate.gpuInstrumentationEnabled
      && round.reference.gpuInstrumentationEnabled && round.candidate.gpuSampleCount === 1)).toBe(true);
  });

  it("rejects a blank backend capture before visual scoring", async () => {
    await expect(runCompetitiveBenchmark(createBenchmarkScene(1_024),
      new BlankBackend("deep-webgpu", 0), new FakeBackend("three-webgpu", 128),
      { pairRounds: 5, warmupFrames: 10, cpuSampleFrames: 30, gpuSampleFrames: 0 }))
      .rejects.toThrow("deep-webgpu produced a blank benchmark capture");
  });

  it("fails closed when a baseline backend reports a different runtime setting", async () => {
    const report = await runCompetitiveBenchmark(createBenchmarkScene(1_024),
      new FakeBackend("deep-webgpu", 128),
      new FakeBackend("three-webgpu", 128, false, "baseline-equivalent", { surface: "mismatch" }),
      { pairRounds: 5, warmupFrames: 10, cpuSampleFrames: 30, gpuSampleFrames: 0 });
    expect(report.evaluation).toMatchObject({ status: "invalid", outcome: "withheld" });
    expect(report.fidelity.find(check => check.id === "surface")?.state).toBe("invalid");
  });
});

function fakeFidelity(profile: BenchmarkProfile,
  patch: Partial<Record<BenchmarkFidelityId, unknown>>): BenchmarkFidelitySnapshot {
  const categories = Object.fromEntries(BENCHMARK_FIDELITY_IDS.map(id => [id, patch[id] ?? "same"])) as
    Record<BenchmarkFidelityId, unknown>;
  return { profile, categories };
}
