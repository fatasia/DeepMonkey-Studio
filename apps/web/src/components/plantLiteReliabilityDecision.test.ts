import { describe, expect, it } from "vitest";
import type {
  PlantLiteConfidenceInterval,
  PlantLiteFailureProfile,
  PlantLiteModel,
  PlantLiteStudyEnergyOutcome,
  PlantLiteStudyRecord,
  PlantLiteStudyRequest,
} from "@bim-studio/contracts";
import { createAgvLinePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import { derivePlantLiteReliabilityDecision } from "./plantLiteReliabilityDecision";
import { createPlantLiteReliabilityStrategySweep } from "./plantLiteReliabilityStrategy";

describe("Plant Lite reliability decision", () => {
  it("compares baseline, MTBF and MTTR runs and identifies one non-dominated strategy", () => {
    const baseline = study("baseline", metrics(60, 50, 10, 8, 2));
    const [mtbfRequest, mttrRequest] = createPlantLiteReliabilityStrategySweep(baseline, "assembly-equipment")!.requests;
    const mtbf = candidate("mtbf", mtbfRequest!, metrics(66, 28, 7, 5.5, 1.7));
    const mttr = candidate("mttr", mttrRequest!, metrics(62, 38, 8.5, 6.5, 1.85));

    const decision = derivePlantLiteReliabilityDecision([mttr, mtbf, baseline])!;
    expect(decision.resource).toMatchObject({ resourceId: "assembly-equipment", mtbfMinutes: 400, mttrMinutes: 10 });
    expect(decision.rows.map((row) => row.kind)).toEqual(["baseline", "increase-mtbf", "reduce-mttr"]);
    expect(decision.rows[1]).toMatchObject({
      mtbfMinutes: 500,
      mttrMinutes: 10,
      failedMinutesAssessment: "improved",
      throughputAssessment: "improved",
      energyPerItemKwh: 1.7,
      recommended: true,
    });
    expect(decision.rows[1]?.costPerItem).toBeCloseTo(1.445);
    expect(decision.energyStatus).toBe("ready");
    expect(decision.recommendation).toMatchObject({ status: "single-leading", studyIds: ["mtbf"] });
    expect(decision.recommendation.rationale).toContain("未计入维护投入、备件与人工成本");
  });

  it("returns a transparent tradeoff set instead of inventing objective weights", () => {
    const baseline = study("baseline", metrics(60, 50, 10, 8));
    const [mtbfRequest, mttrRequest] = createPlantLiteReliabilityStrategySweep(baseline, "assembly-equipment")!.requests;
    const mtbf = candidate("mtbf", mtbfRequest!, metrics(68, 34, 9, 7));
    const mttr = candidate("mttr", mttrRequest!, metrics(63, 22, 7, 5));

    const decision = derivePlantLiteReliabilityDecision([mttr, mtbf, baseline])!;
    expect(decision.energyStatus).toBe("not-modeled");
    expect(decision.recommendation.status).toBe("tradeoff");
    expect(decision.recommendation.studyIds).toEqual(["mtbf", "mttr"]);
    expect(decision.recommendation.rationale).toContain("不能宣称唯一最优");
    expect(decision.rows.filter((row) => row.recommended).map((row) => row.study.id)).toEqual(["mtbf", "mttr"]);
  });

  it("withholds recommendation when downtime or energy evidence is incomplete", () => {
    const baseline = study("baseline", metrics(60, 50, 10, 8, 2));
    const [mtbfRequest, mttrRequest] = createPlantLiteReliabilityStrategySweep(baseline, "assembly-equipment")!.requests;
    const mtbf = candidate("mtbf", mtbfRequest!, metrics(66, 28, 7, 5.5, 1.7));
    const mttr = candidate("mttr", mttrRequest!, metrics(62, 38, 8.5, 6.5, 1.85));
    delete mttr.outcome.resourceFailedMinutes95;

    const missingDowntime = derivePlantLiteReliabilityDecision([mttr, mtbf, baseline])!;
    expect(missingDowntime.rows.find((row) => row.study.id === "mttr")?.evidenceStatus).toBe("missing-downtime");
    expect(missingDowntime.recommendation.status).toBe("unavailable");

    mttr.outcome.resourceFailedMinutes95 = { "assembly-equipment": interval(38, 34, 42) };
    delete mttr.outcome.energy;
    const missingEnergy = derivePlantLiteReliabilityDecision([mttr, mtbf, baseline])!;
    expect(missingEnergy.energyStatus).toBe("incomplete");
    expect(missingEnergy.recommendation.status).toBe("unavailable");
  });

  it("marks a run incomparable when the common random conditions drift", () => {
    const baseline = study("baseline", metrics(60, 50, 10, 8));
    const [mtbfRequest, mttrRequest] = createPlantLiteReliabilityStrategySweep(baseline, "assembly-equipment")!.requests;
    const mtbf = candidate("mtbf", mtbfRequest!, metrics(66, 28, 7, 5.5));
    const mttr = candidate("mttr", mttrRequest!, metrics(62, 38, 8.5, 6.5));
    mtbf.seed = "different-seed";

    const decision = derivePlantLiteReliabilityDecision([mttr, mtbf, baseline])!;
    expect(decision.rows.find((row) => row.study.id === "mtbf")).toMatchObject({
      comparable: false,
      evidenceStatus: "incomparable",
      failedMinutesAssessment: "unavailable",
    });
    expect(decision.rows.find((row) => row.study.id === "mtbf")?.comparabilityReason).toContain("随机种子不同");
    expect(decision.recommendation.status).toBe("unavailable");
  });

  it("rejects a mislabeled group that also changes process capacity", () => {
    const baseline = study("baseline", metrics(60, 50, 10, 8));
    const [mtbfRequest, mttrRequest] = createPlantLiteReliabilityStrategySweep(baseline, "assembly-equipment")!.requests;
    const mtbf = candidate("mtbf", mtbfRequest!, metrics(66, 28, 7, 5.5));
    const mttr = candidate("mttr", mttrRequest!, metrics(62, 38, 8.5, 6.5));
    const buffer = mtbf.model!.nodes.find((node) => node.id === "queue-buffer");
    if (!buffer || (buffer.kind !== "buffer" && buffer.kind !== "queue-buffer")) throw new Error("fixture buffer missing");
    buffer.capacity += 1;

    expect(derivePlantLiteReliabilityDecision([mttr, mtbf, baseline])).toBeUndefined();
  });

  it("does not surface an old reliability matrix after a normal run becomes latest", () => {
    const baseline = study("baseline", metrics(60, 50, 10, 8));
    const [mtbfRequest, mttrRequest] = createPlantLiteReliabilityStrategySweep(baseline, "assembly-equipment")!.requests;
    const mtbf = candidate("mtbf", mtbfRequest!, metrics(66, 28, 7, 5.5));
    const mttr = candidate("mttr", mttrRequest!, metrics(62, 38, 8.5, 6.5));
    const normalRun = study("later-normal-run", metrics(61, 44, 9, 7));

    expect(derivePlantLiteReliabilityDecision([normalRun, mttr, mtbf, baseline])).toBeUndefined();
  });
});

interface ResultMetrics {
  throughput: number;
  downtime: number;
  wip: number;
  lead: number;
  energyPerItem?: number;
}

function metrics(throughput: number, downtime: number, wip: number, lead: number, energyPerItem?: number): ResultMetrics {
  return { throughput, downtime, wip, lead, ...(energyPerItem === undefined ? {} : { energyPerItem }) };
}

function study(id: string, values: ResultMetrics): PlantLiteStudyRecord {
  const model = createAgvLinePlantLiteModel();
  model.resources!.push({ id: "assembly-equipment", name: "装配设备", kind: "equipment", capacity: 2, failure: failure(), power: { activePowerKw: 18, idlePowerKw: 2.2, source: "nameplate" } });
  const station = model.nodes.find((node) => node.id === "station-a");
  if (!station || station.kind !== "station") throw new Error("fixture station missing");
  station.resourceId = "assembly-equipment";
  delete station.power;
  return record(id, model, values);
}

function candidate(id: string, request: PlantLiteStudyRequest, values: ResultMetrics): PlantLiteStudyRecord {
  if (!request.model || !request.comparison) throw new Error("candidate request missing evidence");
  return {
    ...record(id, request.model, values),
    name: request.name,
    seed: request.seed!,
    replications: request.replications!,
    comparison: request.comparison,
    ...(request.acceptanceTargets ? { acceptanceTargets: request.acceptanceTargets } : {}),
    execution: {
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      inputFingerprint: `input-${id}`,
      deterministic: true,
      limits: request.limits as PlantLiteStudyRecord["execution"]["limits"],
      trace: request.trace as NonNullable<PlantLiteStudyRecord["execution"]["trace"]>,
    },
  };
}

function record(id: string, model: PlantLiteModel, values: ResultMetrics): PlantLiteStudyRecord {
  return {
    id,
    projectId: "project",
    name: "维护基线",
    createdAt: "2026-09-03T00:00:00Z",
    templateId: "agv-line-v1",
    model,
    seed: "maintenance-common-random",
    replications: 12,
    inputFingerprint: `input-${id}`,
    outcome: {
      status: "completed",
      completedReplications: 12,
      throughputPerHour: interval(values.throughput, values.throughput - 1, values.throughput + 1),
      averageWip: interval(values.wip, values.wip - 1, values.wip + 1),
      averageLeadTimeMinutes: interval(values.lead, values.lead - 0.5, values.lead + 0.5),
      resourceUtilization95: { "assembly-equipment": interval(.7, .65, .75) },
      resourceFailedMinutes95: { "assembly-equipment": interval(values.downtime, values.downtime - 4, values.downtime + 4) },
      ...(values.energyPerItem === undefined ? {} : { energy: energy(values.energyPerItem) }),
      bottlenecks: [],
    },
    execution: {
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      inputFingerprint: `input-${id}`,
      deterministic: true,
      limits: { durationMinutes: 960, warmupMinutes: 120, maxEvents: 100_000, maxResources: 100 },
      trace: { replication: 3, maxEvents: 1_200, maxItems: 80 },
    },
  };
}

function energy(energyPerItem: number): PlantLiteStudyEnergyOutcome {
  const cost = energyPerItem * .85;
  return {
    activeEnergyKwh: interval(100, 95, 105),
    idleEnergyKwh: interval(10, 9, 11),
    totalEnergyKwh: interval(110, 104, 116),
    energyPerCompletedItemKwh: interval(energyPerItem, energyPerItem - .05, energyPerItem + .05),
    electricityCost: interval(93.5, 90, 97),
    electricityCostPerCompletedItem: interval(cost, cost - .05, cost + .05),
    carbonEmissionKg: interval(63.8, 60, 67),
    carbonEmissionPerCompletedItemKg: interval(energyPerItem * .58, energyPerItem * .55, energyPerItem * .61),
    peakDemandKw: interval(20, 19, 21),
    consumerEnergyKwh: { "assembly-equipment": interval(80, 76, 84) },
  };
}

function interval(mean: number, lower95: number, upper95: number): PlantLiteConfidenceInterval {
  return { mean, lower95, upper95, sampleStandardDeviation: 1, samples: 12 };
}

function failure(): PlantLiteFailureProfile {
  return {
    timeToFailure: { kind: "exponential", mean: 400 },
    repairTime: { kind: "deterministic", value: 10 },
  };
}
