import { describe, expect, it } from "vitest";
import type { BenchmarkCase } from "./benchmarkContract.js";
import {
  evaluateCompetitiveBenchmark,
  type BenchmarkFidelityCheck,
  type CompetitiveEngineSummary,
  type CompetitiveRoundEvidence,
} from "./competitiveBenchmark.js";

const hash = (value: string): string => value.repeat(64);
const definition: BenchmarkCase = { id: "instanced-pbr-1k", track: "browser-webgpu", critical: true,
  environmentHash: hash("a"), fixtureHash: hash("b"), settingsHash: hash("c"), criteria: [
    { metric: "cpu-frame-p95-ms", direction: "lower", maxRegressionFraction: 0.05 },
    { metric: "visual-similarity", direction: "higher", maxRegressionFraction: 0.08, absoluteMinimum: 0.92 },
  ] };
const summary = (engine: CompetitiveEngineSummary["engine"], p95: number): CompetitiveEngineSummary => ({
  engine, warmupFrames: 20, cpuSampleCount: 90, gpuSampleCount: 0,
  cpuFrameP50Ms: p95 - 1, cpuFrameP95Ms: p95, cpuFrameP99Ms: p95 + 1,
  gpuFrameP50Ms: null, gpuFrameP95Ms: null, gpuFrameP99Ms: null,
  gpuTimestampUnit: null, gpuMeasurementMode: null,
  gpuInstrumentationEnabled: false,
  drawCalls: 4, triangles: 1_920_000, resources: 24, deviceErrors: [],
});
const rounds = (): CompetitiveRoundEvidence[] => Array.from({ length: 5 }, (_, index) => ({
  round: index + 1,
  order: index % 2 ? ["reference", "candidate"] as const : ["candidate", "reference"] as const,
  environmentHash: hash("a"), fixtureHash: hash("b"), settingsHash: hash("c"),
  candidate: summary("deep-webgpu", 5), reference: summary("three-webgpu", 6), visualSimilarity: 0.96,
}));
const fidelity = (state: BenchmarkFidelityCheck["state"]): BenchmarkFidelityCheck[] => [{
  id: "camera", state, candidate: "frozen", reference: "frozen",
  ...(state === "equivalent" ? {} : { reason: "post-processing differs" }),
}];

describe("competitive benchmark ranking gate", () => {
  it("permits an outcome only for fault-free equivalent evidence", () => {
    expect(evaluateCompetitiveBenchmark(definition, rounds(), fidelity("equivalent")))
      .toMatchObject({ status: "comparable", outcome: "candidate-meets-criteria", benchmark: { valid: true } });
  });

  it("withholds ranking when a quality setting is degraded", () => {
    const result = evaluateCompetitiveBenchmark(definition, rounds(), fidelity("degraded"));
    expect(result).toMatchObject({ status: "degraded", outcome: "withheld", benchmark: { valid: true } });
  });

  it("invalidates ranking when the real visual fidelity floor fails", () => {
    const mismatched = rounds().map(round => ({ ...round, visualSimilarity: 0.7 }));
    const result = evaluateCompetitiveBenchmark(definition, mismatched, fidelity("equivalent"));
    expect(result).toMatchObject({ status: "invalid", outcome: "withheld" });
    expect(result.issues).toContain("visual fidelity gate failed");
  });

  it("invalidates runtime faults, malformed GPU samples and missing fidelity", () => {
    const faulty = rounds(); faulty[0] = { ...faulty[0]!, candidate: {
      ...faulty[0]!.candidate, gpuSampleCount: 1, gpuFrameP50Ms: null, deviceErrors: ["lost"],
    } };
    const result = evaluateCompetitiveBenchmark(definition, faulty, [], ["console failure"]);
    expect(result.status).toBe("invalid");
    expect(result.outcome).toBe("withheld");
    expect(result.issues).toEqual(expect.arrayContaining([
      "fidelity checks are missing", "page error: console failure",
      "round 1 deep-webgpu has inconsistent GPU timing", "round 1 deep-webgpu device error: lost",
    ]));
  });

  it("invalidates changing instrumentation or resource counts across rounds", () => {
    const unstable = rounds(); unstable[1] = { ...unstable[1]!, candidate: {
      ...unstable[1]!.candidate, gpuInstrumentationEnabled: true, resources: 33,
    } };
    const result = evaluateCompetitiveBenchmark(definition, unstable, fidelity("equivalent"));
    expect(result).toMatchObject({ status: "invalid", outcome: "withheld" });
    expect(result.issues).toEqual(expect.arrayContaining([
      "deep-webgpu gpuInstrumentationEnabled changed across paired rounds",
      "deep-webgpu resources changed across paired rounds",
    ]));
  });
});
