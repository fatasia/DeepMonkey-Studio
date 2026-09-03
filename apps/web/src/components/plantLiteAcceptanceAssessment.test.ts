import { describe, expect, it } from "vitest";
import type { PlantLiteConfidenceInterval, PlantLiteStudyRecord } from "@bim-studio/contracts";
import { assessPlantLiteAcceptance } from "./plantLiteAcceptanceAssessment";

const interval = (mean: number, lower95: number, upper95: number, samples = 12): PlantLiteConfidenceInterval => ({
  mean, lower95, upper95, samples, sampleStandardDeviation: 1,
});

function study(): PlantLiteStudyRecord {
  return {
    id: "study", projectId: "project", createdAt: "2026-09-03T00:00:00.000Z", name: "方案",
    templateId: "agv-line-v1", seed: "seed", replications: 12, inputFingerprint: "input",
    acceptanceTargets: {
      basis: "规划产能 60 件/时",
      minimumThroughputPerHour: 60,
      maximumAverageWip: 12,
      maximumAverageLeadTimeMinutes: 8,
      maximumEnergyPerCompletedItemKwh: 1.2,
    },
    outcome: {
      status: "completed", completedReplications: 12,
      throughputPerHour: interval(64, 61, 67),
      averageWip: interval(10, 9, 11),
      averageLeadTimeMinutes: interval(8, 7, 9),
      resourceUtilization95: {}, bottlenecks: [],
      energy: {
        activeEnergyKwh: interval(10, 9, 11), idleEnergyKwh: interval(2, 1, 3), totalEnergyKwh: interval(12, 11, 13),
        energyPerCompletedItemKwh: interval(1.4, 1.3, 1.5), electricityCost: interval(8, 7, 9),
        electricityCostPerCompletedItem: interval(.8, .7, .9), carbonEmissionKg: interval(6, 5, 7),
        carbonEmissionPerCompletedItemKg: interval(.6, .5, .7), peakDemandKw: interval(20, 18, 22), consumerEnergyKwh: {},
      },
    },
    execution: { engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint: "input", deterministic: true, limits: { durationMinutes: 480, maxEvents: 100_000, maxResources: 100 } },
  };
}

describe("assessPlantLiteAcceptance", () => {
  it("uses the whole 95% interval instead of the mean to make a target decision", () => {
    const assessment = assessPlantLiteAcceptance(study());
    expect(assessment?.status).toBe("not-met");
    expect(assessment?.checks.map((check) => [check.key, check.status])).toEqual([
      ["minimumThroughputPerHour", "met"],
      ["maximumAverageWip", "met"],
      ["maximumAverageLeadTimeMinutes", "at-risk"],
      ["maximumEnergyPerCompletedItemKwh", "not-met"],
    ]);
  });

  it("does not issue a pass when evidence is partial or the run is limited", () => {
    const partial = study();
    partial.outcome.energy!.energyPerCompletedItemKwh = interval(1, .9, 1.1, 8);
    expect(assessPlantLiteAcceptance(partial)?.checks.at(-1)?.status).toBe("insufficient-data");
    partial.outcome.status = "limited";
    expect(assessPlantLiteAcceptance(partial)?.checks.every((check) => check.status === "insufficient-data")).toBe(true);
  });

  it("returns no assessment when a record has no numeric target", () => {
    const empty = study();
    empty.acceptanceTargets = { basis: "尚未填写阈值" };
    expect(assessPlantLiteAcceptance(empty)).toBeUndefined();
  });
});
