import { describe, expect, it } from "vitest";
import {
  createAgvLinePlantLiteModel,
  plantLiteEffectiveCapacity,
  runPlantLiteExperiment,
  validatePlantLiteModel,
  type PlantLiteExperiment,
  type PlantLiteModel,
} from "./index.js";

describe("Plant Lite worker resources", () => {
  it("validates worker pools separately from equipment failure and energy models", () => {
    const model = sharedWorkerLine(1);
    expect(validatePlantLiteModel(model)).toMatchObject({ valid: true });

    const wrongKind = structuredClone(model);
    const station = stationById(wrongKind, "station-a");
    station.workerResourceId = "machine";
    expect(validatePlantLiteModel(wrongKind)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ path: "$.nodes[1].workerResourceId", message: "人工资源必须是 worker" })]),
    });

    const unsupported = structuredClone(model);
    const worker = unsupported.resources?.find((resource) => resource.kind === "worker");
    if (!worker) throw new Error("missing worker fixture");
    worker.failure = {
      timeToFailure: { kind: "deterministic", value: 10 },
      repairTime: { kind: "deterministic", value: 2 },
    };
    worker.power = { activePowerKw: 1, idlePowerKw: 0 };
    expect(validatePlantLiteModel(unsupported)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "$.resources[1].failure", message: "人工资源不支持设备故障模型" }),
        expect.objectContaining({ path: "$.resources[1].power", message: "人工资源不参与设备能耗模型" }),
      ]),
    });
  });

  it("takes the minimum of station, equipment and worker capacity", () => {
    const model = sharedWorkerLine(2);
    const station = stationById(model, "station-a");
    station.capacity = 4;
    const machine = model.resources?.find((resource) => resource.id === "machine");
    if (!machine) throw new Error("missing machine fixture");
    machine.capacity = 3;

    expect(plantLiteEffectiveCapacity(model, station)).toBe(2);
  });

  it("atomically acquires equipment and an on-shift worker before starting work", () => {
    const model = sharedWorkerLine(1);
    delete stationById(model, "station-b").workerResourceId;
    const worker = model.resources?.find((resource) => resource.id === "workers");
    const machine = model.resources?.find((resource) => resource.id === "machine");
    if (!worker || !machine) throw new Error("missing resource fixture");
    worker.availability = { shifts: [{ startMinute: 10, endMinute: 30 }] };
    machine.availability = { shifts: [{ startMinute: 12, endMinute: 30 }] };
    const experiment: PlantLiteExperiment = {
      model,
      seed: "worker-shift",
      replications: 1,
      limits: { durationMinutes: 30, maxEvents: 5_000, maxResources: 10 },
      trace: { replication: 0, maxEvents: 500, maxItems: 20 },
    };

    const result = runPlantLiteExperiment(experiment);
    const firstStart = result.representativeTrace?.events.find((event) => event.type === "item-start" && event.nodeId === "station-a");
    expect(firstStart).toMatchObject({ atMinute: 12, nodeId: "station-a" });
    expect(result.representativeTrace?.events.some((event) => event.type === "item-start" && event.atMinute < 12)).toBe(false);
    expect(result.resourceUtilization95.workers?.mean).toBeGreaterThan(0);
    expect(result.resourceUtilization95.machine?.mean).toBeGreaterThan(0);
  });

  it("makes a shared worker pool a deterministic cross-station bottleneck", () => {
    const shared: PlantLiteExperiment = {
      model: sharedWorkerLine(1),
      seed: "shared-worker",
      replications: 3,
      limits: { durationMinutes: 60, maxEvents: 20_000, maxResources: 10 },
    };
    const independent = structuredClone(shared);
    independent.model.resources?.push({ id: "workers-b", name: "检验班组", kind: "worker", capacity: 1 });
    stationById(independent.model, "station-b").workerResourceId = "workers-b";

    const first = runPlantLiteExperiment(shared);
    const repeated = runPlantLiteExperiment(shared);
    const withoutCompetition = runPlantLiteExperiment(independent);

    expect(first).toEqual(repeated);
    expect(first.resourceUtilization95.workers).toMatchObject({ mean: 1, samples: 3 });
    expect(first.confidence95.throughputPerHour.mean).toBeLessThan(withoutCompetition.confidence95.throughputPerHour.mean);
    expect(first.replications.every((run) => run.resources.find((resource) => resource.resourceId === "workers")?.utilization === 1)).toBe(true);
  });

  it("keeps results byte-identical when worker constraints are not enabled", () => {
    const model = createAgvLinePlantLiteModel();
    const experiment: PlantLiteExperiment = { model, seed: "legacy-no-workers", replications: 2 };
    expect(runPlantLiteExperiment(experiment)).toEqual(runPlantLiteExperiment(structuredClone(experiment)));
    expect(model.resources?.some((resource) => resource.kind === "worker")).toBe(false);
  });
});

function sharedWorkerLine(workerCount: number): PlantLiteModel {
  return {
    id: "shared-worker-line",
    name: "共享人工产线",
    resources: [
      { id: "machine", name: "装配设备", kind: "equipment", capacity: 3 },
      { id: "workers", name: "装配班组", kind: "worker", capacity: workerCount },
    ],
    nodes: [
      { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 }, maxItems: 40 },
      { id: "station-a", name: "装配", kind: "station", processingTime: { kind: "deterministic", value: 5 }, capacity: 4, resourceId: "machine", workerResourceId: "workers" },
      { id: "station-b", name: "检验", kind: "station", processingTime: { kind: "deterministic", value: 5 }, capacity: 4, workerResourceId: "workers" },
      { id: "sink", name: "成品", kind: "sink" },
    ],
    edges: [
      { id: "source-a", from: "source", to: "station-a" },
      { id: "a-b", from: "station-a", to: "station-b" },
      { id: "b-sink", from: "station-b", to: "sink" },
    ],
  };
}

function stationById(model: PlantLiteModel, id: string) {
  const station = model.nodes.find((node) => node.id === id);
  if (!station || station.kind !== "station") throw new Error(`missing station ${id}`);
  return station;
}
