import { describe, expect, it } from "vitest";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { assessPlantLiteComparability, derivePlantLiteScenarioDecision } from "./plantLiteScenarioDecisionModel";

const ci = (mean: number, lower95 = mean - 1, upper95 = mean + 1) => ({ mean, lower95, upper95, sampleStandardDeviation: 1, samples: 12 });

function study(id: string, throughput: number, candidateLabel?: string): PlantLiteStudyRecord {
  return {
    id, projectId: "project", createdAt: "2026-09-03T00:00:00Z", name: id, templateId: "agv-line-v1",
    seed: "common", replications: 12, inputFingerprint: id,
    ...(candidateLabel ? { comparison: { groupId: "sweep:base", baselineStudyId: "base", parameterLabel: "并行工位数", candidateLabel } } : {}),
    outcome: {
      status: "completed", completedReplications: 12,
      throughputPerHour: ci(throughput), averageWip: ci(4), averageLeadTimeMinutes: ci(8),
      resourceUtilization95: {}, bottlenecks: [],
    },
    execution: {
      engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint: id, deterministic: true,
      limits: { durationMinutes: 480, maxEvents: 100_000, maxResources: 100 },
    },
  };
}

function addEnergy(record: PlantLiteStudyRecord, unitEnergy: number): PlantLiteStudyRecord {
  const total = ci(unitEnergy * 100);
  return {
    ...record,
    model: {
      id: "line", name: "Line",
      energyEconomics: { electricityPricePerKwh: .85, carbonEmissionFactorKgPerKwh: .58, source: "project" },
      nodes: [
        { id: "source", name: "Source", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } },
        { id: "station", name: "Station", kind: "station", processingTime: { kind: "deterministic", value: 1 }, power: { activePowerKw: 10, idlePowerKw: 1, source: "nameplate" } },
        { id: "sink", name: "Sink", kind: "sink" },
      ],
      edges: [{ id: "a", from: "source", to: "station" }, { id: "b", from: "station", to: "sink" }],
    },
    outcome: {
      ...record.outcome,
      energy: {
        activeEnergyKwh: total, idleEnergyKwh: ci(0), totalEnergyKwh: total,
        energyPerCompletedItemKwh: ci(unitEnergy), electricityCost: ci(unitEnergy * 85),
        electricityCostPerCompletedItem: ci(unitEnergy * .85), carbonEmissionKg: ci(unitEnergy * 58),
        carbonEmissionPerCompletedItemKg: ci(unitEnergy * .58), peakDemandKw: ci(20), consumerEnergyKwh: {},
      },
    },
  };
}

describe("Plant Lite scenario decision", () => {
  it("groups persisted candidates against their saved baseline", () => {
    const base = study("base", 60);
    const first = study("candidate-1", 64, "2 个并行工位");
    const second = study("candidate-2", 70, "3 个并行工位");
    const decision = derivePlantLiteScenarioDecision([second, first, base])!;

    expect(decision.parameterLabel).toBe("并行工位数");
    expect(decision.objectiveLabels).toEqual(["吞吐↑", "交付周期↓", "WIP↓"]);
    expect(decision.rows).toHaveLength(3);
    expect(decision.rows.find((row) => row.study.id === "candidate-2")).toMatchObject({
      intervalAssessment: "improved", highestThroughput: true, paretoFrontier: true,
      throughputDeltaPercent: (1 / 6) * 100,
    });
    expect(decision.notes).toContain("未建模设备功率，能源、成本与碳排不参与本组前沿。");
  });

  it("excludes changed execution conditions from the frontier", () => {
    const base = study("base", 60);
    const candidate = study("candidate", 80, "2 个并行工位");
    candidate.execution.limits.durationMinutes = 960;
    const row = derivePlantLiteScenarioDecision([candidate, base])!.rows[1]!;
    expect(row).toMatchObject({ comparable: false, intervalAssessment: "unavailable", paretoFrontier: false });
    expect(row.throughputDeltaPercent).toBeUndefined();
  });

  it("does not compare runs that use different warmup windows", () => {
    const base = study("base", 60);
    const candidate = study("candidate", 80, "2 个并行工位");
    candidate.execution.limits.warmupMinutes = 60;
    const row = derivePlantLiteScenarioDecision([candidate, base])!.rows[1]!;
    expect(row).toMatchObject({ comparable: false, intervalAssessment: "unavailable" });
    expect(assessPlantLiteComparability(candidate, base).reason).toContain("预热期");
  });

  it("rejects incomplete core samples even when the status says completed", () => {
    const base = study("base", 60);
    const candidate = study("candidate", 80, "2 个并行工位");
    candidate.outcome.throughputPerHour.samples = 11;
    expect(assessPlantLiteComparability(candidate, base)).toMatchObject({ comparable: false });
  });

  it("does not rank candidates when the saved baseline is incomplete", () => {
    const base = study("base", 0);
    base.outcome.status = "limited";
    base.outcome.completedReplications = 0;
    const candidate = study("candidate", 80, "2 个并行工位");
    const decision = derivePlantLiteScenarioDecision([candidate, base])!;
    expect(decision.rows.every((row) => !row.comparable && !row.paretoFrontier)).toBe(true);
  });

  it("keeps a persisted experiment group visible after a later ordinary run", () => {
    const base = study("base", 60);
    const candidate = study("candidate", 70, "2 个并行工位");
    expect(derivePlantLiteScenarioDecision([study("latest", 66), candidate, base])?.rows).toHaveLength(2);
    expect(derivePlantLiteScenarioDecision([study("latest", 66), base])).toBeUndefined();
  });

  it("builds a multi-objective frontier from complete energy evidence", () => {
    const base = addEnergy(study("base", 60), 2);
    const efficient = addEnergy(study("efficient", 70, "节能扩容"), 1.8);
    const fast = addEnergy(study("fast", 72, "高速扩容"), 2.4);
    const dominated = addEnergy(study("dominated", 65, "低效扩容"), 3);
    const decision = derivePlantLiteScenarioDecision([fast, efficient, dominated, base])!;

    expect(decision.objectiveLabels).toEqual(["吞吐↑", "交付周期↓", "WIP↓", "单位能耗↓", "单位成本↓", "单位碳排↓"]);
    expect(decision.rows.find((row) => row.study.id === "efficient")).toMatchObject({
      paretoFrontier: true, lowestCost: true, energyPerItemKwh: { value: 1.8, evidence: "complete" },
    });
    expect(decision.rows.find((row) => row.study.id === "fast")).toMatchObject({ paretoFrontier: true, highestThroughput: true });
    expect(decision.rows.find((row) => row.study.id === "dominated")).toMatchObject({ paretoFrontier: false });
  });

  it("keeps a valid core frontier while explicitly omitting incomplete energy", () => {
    const base = addEnergy(study("base", 60), 2);
    const candidate = addEnergy(study("candidate", 70, "扩容"), 1.5);
    candidate.outcome.energy!.energyPerCompletedItemKwh.samples = 11;
    const decision = derivePlantLiteScenarioDecision([candidate, base])!;

    expect(decision.objectiveLabels).toEqual(["吞吐↑", "交付周期↓", "WIP↓"]);
    expect(decision.rows.find((row) => row.study.id === "candidate")?.paretoFrontier).toBe(true);
    expect(decision.notes.some((note) => note.includes("单位能耗未进入前沿"))).toBe(true);
  });

  it("uses energy but omits cost when electricity-price assumptions differ", () => {
    const base = addEnergy(study("base", 60), 2);
    const candidate = addEnergy(study("candidate", 70, "扩容"), 1.8);
    candidate.model!.energyEconomics!.electricityPricePerKwh = 1.2;
    const decision = derivePlantLiteScenarioDecision([candidate, base])!;

    expect(decision.objectiveLabels).toContain("单位能耗↓");
    expect(decision.objectiveLabels).toContain("单位碳排↓");
    expect(decision.objectiveLabels).not.toContain("单位成本↓");
    expect(decision.notes.some((note) => note.includes("单位电费未进入前沿"))).toBe(true);
  });

  it("includes utilization, same-scope failure loss, and shared acceptance gates", () => {
    const base = study("base", 60);
    const candidate = study("candidate", 70, "可靠性方案");
    for (const [record, utilization, loss] of [[base, .88, 30], [candidate, .81, 12]] as const) {
      record.model = {
        id: "line", name: "Line", resources: [{ id: "robot", name: "机器人", kind: "equipment", capacity: 1 }],
        nodes: [
          { id: "source", name: "Source", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } },
          { id: "sink", name: "Sink", kind: "sink" },
        ], edges: [{ id: "edge", from: "source", to: "sink" }],
      };
      record.outcome.resourceUtilization95.robot = ci(utilization);
      record.outcome.resourceFailedMinutes95 = { robot: ci(loss) };
      record.acceptanceTargets = { basis: "合同产能", minimumThroughputPerHour: 65 };
    }
    const decision = derivePlantLiteScenarioDecision([candidate, base])!;

    expect(decision.objectiveLabels).toContain("故障损失↓");
    expect(decision.rows[0]).toMatchObject({ acceptanceStatus: "not-met", peakUtilization: { resourceName: "机器人", value: .88 }, failureLoss: { value: 30 } });
    expect(decision.rows[1]).toMatchObject({ acceptanceStatus: "met", paretoFrontier: true, failureLoss: { value: 12 } });
  });

  it("marks changed acceptance thresholds instead of comparing pass states", () => {
    const base = study("base", 60);
    const candidate = study("candidate", 70, "扩容");
    base.acceptanceTargets = { minimumThroughputPerHour: 60 };
    candidate.acceptanceTargets = { minimumThroughputPerHour: 70 };
    const decision = derivePlantLiteScenarioDecision([candidate, base])!;
    expect(decision.rows.every((row) => row.acceptanceStatus === "inconsistent-targets")).toBe(true);
    expect(decision.notes.some((note) => note.includes("验收门槛不一致"))).toBe(true);
  });
});
