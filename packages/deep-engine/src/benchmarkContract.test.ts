import { describe, expect, it } from "vitest";
import {
  CAPABILITY_DOMAIN_WEIGHTS,
  evaluateBenchmarkCase,
  evaluateCapabilityClaim,
  type BenchmarkCase,
  type BenchmarkPairObservation,
  type CapabilityDomain,
  type CapabilityItem,
} from "./benchmarkContract.js";

const hash = (digit: string) => digit.repeat(64);
const definition: BenchmarkCase = {
  id: "dense-industrial-scene",
  track: "browser-webgpu",
  critical: true,
  environmentHash: hash("a"),
  fixtureHash: hash("b"),
  settingsHash: hash("c"),
  criteria: [
    { metric: "gpu-frame-p95-ms", direction: "lower", maxRegressionFraction: 0.05, minImprovementFraction: 0.15 },
    { metric: "visual-similarity", direction: "higher", maxRegressionFraction: 0.05, absoluteMinimum: 0.98 },
  ],
};

function observations(candidateGpu = 8, candidateSimilarity = 0.99): BenchmarkPairObservation[] {
  return Array.from({ length: 5 }, (_, index) => ({
    round: index + 1,
    order: index % 2 === 0 ? ["candidate", "reference"] as const : ["reference", "candidate"] as const,
    environmentHash: hash("a"),
    fixtureHash: hash("b"),
    settingsHash: hash("c"),
    candidate: { "gpu-frame-p95-ms": candidateGpu + index * 0.01, "visual-similarity": candidateSimilarity },
    reference: { "gpu-frame-p95-ms": 10 + index * 0.01, "visual-similarity": 0.99 },
  }));
}

describe("competitive benchmark evidence", () => {
  it("passes paired alternating evidence only when every quality and performance gate passes", () => {
    const result = evaluateBenchmarkCase(definition, observations());
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.criteria[0]!.relativeChange).toBeLessThan(-0.19);
  });

  it("keeps an unchanged candidate from claiming a required win", () => {
    const result = evaluateBenchmarkCase(definition, observations(10));
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.criteria[0]!.improved).toBe(false);
  });

  it("fails closed on missing rounds, fingerprints, metrics, or non-alternating order", () => {
    const invalid = observations().slice(0, 4).map((item, index) => index === 1 ? {
      ...item,
      order: ["candidate", "reference"] as const,
      fixtureHash: hash("d"),
      candidate: { "gpu-frame-p95-ms": Number.NaN },
    } : item);
    const result = evaluateBenchmarkCase(definition, invalid);
    expect(result.valid).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.criteria).toEqual([]);
    expect(result.issues).toEqual(expect.arrayContaining([
      "requires at least 5 paired rounds",
      "round 2 does not alternate execution order",
      "round 2 does not match frozen fingerprints",
      "round 2 lacks finite non-negative gpu-frame-p95-ms",
    ]));
  });

  it("applies higher-is-better relative changes and absolute floors", () => {
    const result = evaluateBenchmarkCase(definition, observations(8, 0.95));
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.criteria[1]).toMatchObject({ passed: false });
  });

  it("handles a zero reference for higher-is-better metrics without reversing an improvement", () => {
    const zeroDefinition: BenchmarkCase = {
      ...definition,
      criteria: [{ metric: "visual-similarity", direction: "higher", maxRegressionFraction: 0 }],
    };
    const result = evaluateBenchmarkCase(zeroDefinition, observations().map((item) => ({
      ...item,
      candidate: { "visual-similarity": 1 },
      reference: { "visual-similarity": 0 },
    })));
    expect(result).toMatchObject({ valid: true, passed: true });
    expect(result.criteria[0]!.relativeChange).toBe(-1);
  });
});

function completeMatrix(statusFor?: (domain: CapabilityDomain, index: number) => CapabilityItem["status"]): CapabilityItem[] {
  return (Object.entries(CAPABILITY_DOMAIN_WEIGHTS) as [CapabilityDomain, number][]).flatMap(([domain, total]) => [0, 1].map((index) => ({
    id: `${domain}-${index}`,
    domain,
    weight: total / 2,
    critical: index === 0,
    status: statusFor?.(domain, index) ?? "passed",
    evidenceIds: ["run:verified"],
  })));
}

describe("Unity, UE5 and Godot capability claims", () => {
  it("accepts a complete separately frozen matrix", () => {
    const result = evaluateCapabilityClaim(completeMatrix());
    expect(result).toMatchObject({ valid: true, passed: true, score: 100 });
    expect(Object.values(result.domainScores).every((score) => score === 100)).toBe(true);
  });

  it("counts unverified work as zero and enforces critical and domain floors", () => {
    const result = evaluateCapabilityClaim(completeMatrix((domain, index) => domain === "rendering" && index === 0 ? "unverified" : "passed"));
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(90);
    expect(result.domainScores.rendering).toBe(50);
    expect(result.issues).toContain("critical capability rendering-0 did not pass");
  });

  it("rejects denominator changes and evidence-free passed items", () => {
    const matrix = completeMatrix();
    matrix[0] = { ...matrix[0]!, weight: 1, evidenceIds: [] };
    const result = evaluateCapabilityClaim(matrix);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      "passed capability rendering-0 has no evidence",
      "rendering weights must total 20",
    ]));
  });
});
