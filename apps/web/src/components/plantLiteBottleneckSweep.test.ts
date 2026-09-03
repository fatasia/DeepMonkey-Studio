import { describe, expect, it } from "vitest";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { createAgvLinePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import { createPlantLiteBottleneckSweep } from "./plantLiteBottleneckSweep";

function study(nodeId: string): PlantLiteStudyRecord {
  const interval = { mean: 10, sampleStandardDeviation: 0, lower95: 10, upper95: 10, samples: 12 };
  return {
    id: "baseline", projectId: "project", name: "基线", createdAt: "2026-09-03T00:00:00Z", templateId: "agv-line-v1",
    model: createAgvLinePlantLiteModel({ agvCount: 2, bufferCapacity: 10 }), modelFingerprint: "model", seed: "fixed", replications: 12, inputFingerprint: "input",
    acceptanceTargets: { basis: "规划冻结版", minimumThroughputPerHour: 12 },
    outcome: { status: "completed", completedReplications: 12, throughputPerHour: interval, averageWip: interval, averageLeadTimeMinutes: interval, resourceUtilization95: {}, bottlenecks: [{ nodeId, occurrences: 10, probability: .83 }] },
    execution: { engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint: "input", deterministic: true, limits: { durationMinutes: 480, maxEvents: 100_000, maxResources: 100 }, trace: { replication: 0, maxEvents: 2_000, maxItems: 100 } },
  };
}

describe("Plant Lite bottleneck sweep", () => {
  it("creates fair transport candidates without mutating the saved baseline", () => {
    const baseline = study("transport");
    const sweep = createPlantLiteBottleneckSweep(baseline)!;
    expect(sweep.candidateLabels).toEqual(["3 个搬运资源", "4 个搬运资源"]);
    expect(sweep.requests.map((request) => request.model?.resources?.[0]?.capacity)).toEqual([3, 4]);
    expect(sweep.requests.every((request) => request.seed === "fixed" && request.replications === 12)).toBe(true);
    expect(sweep.requests.every((request) => request.trace?.maxEvents === 2_000)).toBe(true);
    expect(sweep.requests.every((request) => request.acceptanceTargets?.minimumThroughputPerHour === 12)).toBe(true);
    expect(sweep.requests.map((request) => request.comparison)).toEqual([
      { groupId: "bottleneck-sweep:baseline", baselineStudyId: "baseline", parameterLabel: "搬运资源数", candidateLabel: "3 个搬运资源" },
      { groupId: "bottleneck-sweep:baseline", baselineStudyId: "baseline", parameterLabel: "搬运资源数", candidateLabel: "4 个搬运资源" },
    ]);
    expect(baseline.model?.resources?.[0]?.capacity).toBe(2);
  });

  it("varies only the evidenced station or buffer capacity", () => {
    const station = createPlantLiteBottleneckSweep(study("station-a"))!;
    expect(station.requests.map((request) => request.model?.nodes.find((node) => node.id === "station-a"))).toEqual([
      expect.objectContaining({ capacity: 2 }), expect.objectContaining({ capacity: 3 }),
    ]);
    const buffer = createPlantLiteBottleneckSweep(study("queue-buffer"))!;
    expect(buffer.requests.map((request) => request.model?.nodes.find((node) => node.id === "queue-buffer"))).toEqual([
      expect.objectContaining({ capacity: 15 }), expect.objectContaining({ capacity: 20 }),
    ]);
  });

  it("raises whichever station or equipment constraint limits effective capacity", () => {
    const baseline = study("station-a");
    const station = baseline.model!.nodes.find((node) => node.id === "station-a");
    if (!station || station.kind !== "station") throw new Error("missing fixture station");
    station.capacity = 3;
    station.resourceId = "assembly-equipment";
    delete station.power;
    baseline.model!.resources!.push({ id: "assembly-equipment", name: "装配设备", kind: "equipment", capacity: 1, power: { activePowerKw: 18, idlePowerKw: 2.2 } });

    const sweep = createPlantLiteBottleneckSweep(baseline)!;
    expect(sweep.parameterLabel).toBe("工位有效并行能力");
    expect(sweep.candidateLabels).toEqual(["2 路有效并行", "3 路有效并行"]);
    expect(sweep.requests.map((request) => request.model?.nodes.find((node) => node.id === "station-a"))).toEqual([
      expect.objectContaining({ capacity: 3 }), expect.objectContaining({ capacity: 3 }),
    ]);
    expect(sweep.requests.map((request) => request.model?.resources?.find((resource) => resource.id === "assembly-equipment")?.capacity)).toEqual([2, 3]);
    expect(baseline.model!.resources!.find((resource) => resource.id === "assembly-equipment")?.capacity).toBe(1);
  });

  it("does not invent a sweep when there is no supported bottleneck evidence", () => {
    expect(createPlantLiteBottleneckSweep(study("source"))).toBeUndefined();
    const noHeadroom = study("transport");
    noHeadroom.model!.resources![0]!.capacity = 100;
    noHeadroom.execution.limits.maxResources = 100;
    expect(createPlantLiteBottleneckSweep(noHeadroom)).toBeUndefined();
  });
});
