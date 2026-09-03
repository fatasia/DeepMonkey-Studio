import { describe, expect, it } from "vitest";
import type { PlantLiteFailureProfile, PlantLiteStudyRecord } from "@bim-studio/contracts";
import { createAgvLinePlantLiteModel, validatePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import {
  createPlantLiteReliabilityCandidates,
  createPlantLiteReliabilityStrategySweep,
  listPlantLiteReliabilityOptions,
  scalePlantLiteDistribution,
} from "./plantLiteReliabilityStrategy";

describe("Plant Lite reliability strategy", () => {
  it("lists only explicitly configured resources bound to a station or transport node", () => {
    const baseline = study();
    baseline.model!.resources!.push(
      { id: "unbound", name: "未绑定设备", kind: "equipment", capacity: 1, failure: failure() },
      { id: "no-failure", name: "无故障参数设备", kind: "equipment", capacity: 1 },
    );

    expect(listPlantLiteReliabilityOptions(baseline)).toEqual([
      {
        resourceId: "agv-fleet",
        resourceName: "AGV 车队",
        boundNodeNames: ["AGV 转运"],
        mtbfMinutes: 720,
        mttrMinutes: 10,
      },
      {
        resourceId: "assembly-equipment",
        resourceName: "装配设备",
        boundNodeNames: ["装配工位"],
        mtbfMinutes: 400,
        mttrMinutes: 10,
      },
    ]);
  });

  it("creates two visible sensitivity targets while preserving distribution shape", () => {
    const candidates = createPlantLiteReliabilityCandidates(failure());
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      kind: "increase-mtbf",
      label: "提高 MTBF 25%（400 → 500 分）",
      mtbfMinutes: 500,
      mttrMinutes: 10,
      failure: {
        timeToFailure: { kind: "normal", mean: 500, standardDeviation: 50, minimum: 12.5 },
        repairTime: { kind: "uniform", minimum: 8, maximum: 12 },
      },
    });
    expect(candidates[1]).toMatchObject({
      kind: "reduce-mttr",
      label: "缩短 MTTR 25%（10 → 7.5 分）",
      mtbfMinutes: 400,
      mttrMinutes: 7.5,
      failure: {
        timeToFailure: { kind: "normal", mean: 400, standardDeviation: 40, minimum: 10 },
        repairTime: { kind: "uniform", minimum: 6, maximum: 9 },
      },
    });
  });

  it("changes one reliability axis per request and preserves fair-run evidence", () => {
    const baseline = study();
    const original = structuredClone(baseline);
    const sweep = createPlantLiteReliabilityStrategySweep(baseline, "assembly-equipment")!;

    expect(sweep.baseline).toMatchObject({ mtbfMinutes: 400, mttrMinutes: 10 });
    expect(sweep.candidates.map((candidate) => candidate.kind)).toEqual(["increase-mtbf", "reduce-mttr"]);
    expect(sweep.requests).toHaveLength(2);
    expect(sweep.requests.every((request) => request.seed === "maintenance-common-random" && request.replications === 12)).toBe(true);
    expect(sweep.requests.every((request) => request.limits?.durationMinutes === 960 && request.limits.warmupMinutes === 120)).toBe(true);
    expect(sweep.requests.every((request) => request.trace?.replication === 3 && request.acceptanceTargets?.maximumAverageWip === 8)).toBe(true);
    expect(sweep.requests.every((request) => request.comparison?.baselineStudyId === baseline.id)).toBe(true);
    expect(sweep.requests.every((request) => request.comparison?.groupId.startsWith("reliability-strategy:baseline:"))).toBe(true);
    expect(sweep.requests.every((request) => request.model && validatePlantLiteModel(request.model).valid)).toBe(true);
    expect(sweep.requests[0]?.model?.resources?.find((resource) => resource.id === "assembly-equipment")?.failure).toEqual(
      sweep.candidates[0]?.failure,
    );
    expect(sweep.requests[1]?.model?.resources?.find((resource) => resource.id === "assembly-equipment")?.failure).toEqual(
      sweep.candidates[1]?.failure,
    );

    const referenceModel = structuredClone(baseline.model!);
    for (const request of sweep.requests) {
      const normalized = structuredClone(request.model!);
      const equipment = normalized.resources?.find((resource) => resource.id === "assembly-equipment");
      const referenceFailure = referenceModel.resources?.find((resource) => resource.id === "assembly-equipment")?.failure;
      if (!equipment || !referenceFailure) throw new Error("fixture equipment failure missing");
      equipment.failure = structuredClone(referenceFailure);
      expect(normalized).toEqual(referenceModel);
    }
    expect(baseline).toEqual(original);
  });

  it("does not generate a decision sweep from incomplete evidence or missing parameters", () => {
    const baseline = study();
    baseline.outcome.status = "limited";
    expect(createPlantLiteReliabilityStrategySweep(baseline, "assembly-equipment")).toBeUndefined();

    const complete = study();
    delete complete.model!.resources!.find((resource) => resource.id === "assembly-equipment")!.failure;
    expect(createPlantLiteReliabilityStrategySweep(complete, "assembly-equipment")).toBeUndefined();
    const noFailure = study();
    delete noFailure.model!.resources!.find((resource) => resource.id === "agv-fleet")!.failure;
    expect(createPlantLiteReliabilityStrategySweep(noFailure, "agv-fleet")).toBeUndefined();
  });

  it("rejects an invalid distribution scale instead of manufacturing a fallback", () => {
    expect(() => scalePlantLiteDistribution({ kind: "deterministic", value: 10 }, 0)).toThrow("正有限数");
  });
});

function study(): PlantLiteStudyRecord {
  const model = createAgvLinePlantLiteModel();
  model.resources!.push({
    id: "assembly-equipment",
    name: "装配设备",
    kind: "equipment",
    capacity: 2,
    failure: failure(),
    power: { activePowerKw: 18, idlePowerKw: 2.2, source: "nameplate" },
  });
  const station = model.nodes.find((node) => node.id === "station-a");
  if (!station || station.kind !== "station") throw new Error("fixture station missing");
  station.resourceId = "assembly-equipment";
  delete station.power;
  const interval = { mean: 10, sampleStandardDeviation: 1, lower95: 9, upper95: 11, samples: 12 };
  return {
    id: "baseline",
    projectId: "project",
    name: "维护基线",
    createdAt: "2026-09-03T00:00:00Z",
    templateId: "agv-line-v1",
    model,
    modelFingerprint: "model",
    seed: "maintenance-common-random",
    replications: 12,
    acceptanceTargets: { basis: "产线规划要求", maximumAverageWip: 8 },
    inputFingerprint: "input",
    outcome: {
      status: "completed",
      completedReplications: 12,
      throughputPerHour: interval,
      averageWip: interval,
      averageLeadTimeMinutes: interval,
      resourceUtilization95: {},
      resourceFailedMinutes95: { "assembly-equipment": interval },
      bottlenecks: [],
    },
    execution: {
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      inputFingerprint: "input",
      deterministic: true,
      limits: { durationMinutes: 960, warmupMinutes: 120, maxEvents: 100_000, maxResources: 100 },
      trace: { replication: 3, maxEvents: 1_200, maxItems: 80 },
    },
  };
}

function failure(): PlantLiteFailureProfile {
  return {
    timeToFailure: { kind: "normal", mean: 400, standardDeviation: 40, minimum: 10 },
    repairTime: { kind: "uniform", minimum: 8, maximum: 12 },
  };
}
