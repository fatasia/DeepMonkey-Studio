import { describe, expect, it } from "vitest";
import { createAgvLinePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { plantGeneticCandidate, plantGeneticStudyRequest } from "./plantGeneticCandidate";

function study(): PlantLiteStudyRecord {
  const interval = { mean: 20, lower95: 19, upper95: 21, sampleStandardDeviation: 1, samples: 4 };
  return {
    id: "s1", projectId: "p", createdAt: "2026-09-28T08:00:00Z", name: "基线", templateId: "agv-line-v1",
    model: createAgvLinePlantLiteModel(), seed: "fixed", replications: 4, inputFingerprint: "hash",
    outcome: { status: "completed", completedReplications: 4, throughputPerHour: interval, averageWip: interval, averageLeadTimeMinutes: interval, resourceUtilization95: {}, bottlenecks: [] },
    execution: { engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint: "hash", deterministic: true,
      limits: { durationMinutes: 120, warmupMinutes: 20, maxEvents: 10000, maxResources: 40 }, trace: { replication: 0, maxEvents: 30, maxItems: 10 } },
  };
}

describe("GA screening production candidate", () => {
  it("preserves authoritative model, CRN, limits and lineage for a real Study", () => {
    const baseline = study();
    const station = baseline.model!.nodes.find((node) => node.id === "station-a");
    if (!station || station.kind !== "station") throw new Error("fixture station missing");
    station.processingTime = { kind: "deterministic", value: 1 };
    const candidate = plantGeneticCandidate(baseline)!;
    const next = plantGeneticStudyRequest(baseline, candidate.stationId, candidate.minimumMinutes, "ga-fingerprint");
    expect(next).toMatchObject({ seed: "fixed", replications: 4, limits: baseline.execution.limits, trace: baseline.execution.trace,
      comparison: { baselineStudyId: "s1", parameterLabel: "工位确定性工时（分钟）", candidateLabel: expect.stringContaining("ga-fingerprint") } });
    expect(next.model).not.toEqual(baseline.model);
    expect(baseline.model!.nodes.find((node) => node.id === candidate.stationId)).not.toEqual(next.model!.nodes.find((node) => node.id === candidate.stationId));
  });
  it("rejects out-of-bound suggestions and non-equivalent PPR review", () => {
    const baseline = study();
    const station = baseline.model!.nodes.find((node) => node.id === "station-a");
    if (!station || station.kind !== "station") throw new Error("fixture station missing");
    station.processingTime = { kind: "deterministic", value: 1 };
    const candidate = plantGeneticCandidate(baseline)!;
    expect(() => plantGeneticStudyRequest(baseline, candidate.stationId, candidate.maximumMinutes * 2, "ga-fingerprint")).toThrow(/范围/);
    baseline.model!.id = "unmapped-review-only";
    expect(plantGeneticCandidate(baseline)).toBeUndefined();
    expect(() => plantGeneticStudyRequest(baseline, candidate.stationId, candidate.baseMinutes, "ga-fingerprint")).toThrow(/无效/);
  });
});
