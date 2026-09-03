import { describe, expect, it } from "vitest";
import { createAgvLinePlantLiteModel, plantLiteEffectiveCapacity, runPlantLiteExperiment, validatePlantLiteModel, type PlantLiteExperiment } from "./index.js";

const LINE: PlantLiteExperiment = {
  seed: "plant-lite-demo",
  replications: 4,
  limits: { durationMinutes: 60, maxEvents: 1_000, maxResources: 4 },
  model: {
    id: "line", name: "Line",
    resources: [{ id: "agv-1", name: "AGV 1", kind: "agv", capacity: 1 }],
    nodes: [
      { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 10 }, maxItems: 6 },
      { id: "station", name: "装配", kind: "station", processingTime: { kind: "deterministic", value: 3 } },
      { id: "buffer", name: "缓存", kind: "queue-buffer", capacity: 2 },
      { id: "transport", name: "转运", kind: "transport", travelTime: { kind: "deterministic", value: 2 }, resourceId: "agv-1" },
      { id: "sink", name: "成品", kind: "sink" }
    ],
    edges: [
      { id: "1", from: "source", to: "station" }, { id: "2", from: "station", to: "buffer" },
      { id: "3", from: "buffer", to: "transport" }, { id: "4", from: "transport", to: "sink" }
    ]
  }
};

describe("Plant Lite DES kernel", () => {
  it("shares a fresh, validated AGV line template with callers", () => {
    const first = createAgvLinePlantLiteModel({ agvCount: 6, bufferCapacity: 24 });
    const second = createAgvLinePlantLiteModel({ agvCount: 6, bufferCapacity: 24 });

    expect(validatePlantLiteModel(first)).toMatchObject({ valid: true });
    expect(first.resources?.[0]?.capacity).toBe(6);
    expect(first.nodes.find((node) => node.kind === "queue-buffer")).toMatchObject({ capacity: 24 });
    expect(first).not.toBe(second);
    expect(first.nodes).not.toBe(second.nodes);
  });

  it("runs source/station/buffer/sink with an AGV resource and reports operational metrics", () => {
    const result = runPlantLiteExperiment(LINE);
    expect(result).toMatchObject({ engineId: "plant-lite-des", deterministic: true });
    expect(result.replications).toHaveLength(4);
    expect(result.replications[0]).toMatchObject({ termination: "completed", completedItems: 6, throughputPerHour: 6, averageLeadTimeMinutes: 5, bottleneckNodeId: "station" });
    expect(result.replications[0]?.nodes.find((node) => node.nodeId === "station")?.utilization).toBeCloseTo(0.3);
    expect(result.replications[0]?.resources).toContainEqual(expect.objectContaining({ resourceId: "agv-1", utilization: 0.2 }));
    expect(result.confidence95.throughputPerHour).toMatchObject({ mean: 6, lower95: 6, upper95: 6, samples: 4 });
    expect(result.nodeMetrics95.station.utilization).toMatchObject({ mean: 0.3, samples: 4 });
    expect(result.bottlenecks).toEqual([{ nodeId: "station", occurrences: 4, probability: 1 }]);
  });

  it("captures a bounded deterministic item trace without changing simulation statistics", () => {
    const baseline = runPlantLiteExperiment(LINE);
    const traced = runPlantLiteExperiment({ ...LINE, trace: { replication: 0, maxEvents: 200, maxItems: 2 } });
    const repeated = runPlantLiteExperiment({ ...LINE, trace: { replication: 0, maxEvents: 200, maxItems: 2 } });
    const { representativeTrace, ...statistics } = traced;

    expect(statistics).toEqual(baseline);
    expect(representativeTrace).toEqual(repeated.representativeTrace);
    expect(representativeTrace).toMatchObject({
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      replication: 0,
      capturedItemCount: 2,
      limits: { maxEvents: 200, maxItems: 2 },
    });
    expect(representativeTrace?.events).toContainEqual(expect.objectContaining({ type: "item-start", nodeId: "station" }));
    expect(representativeTrace?.events).toContainEqual(expect.objectContaining({ type: "item-complete", nodeId: "sink" }));
  });

  it("marks traces as truncated at the item/event caps", () => {
    const trace = runPlantLiteExperiment({ ...LINE, trace: { replication: 0, maxEvents: 5, maxItems: 1 } }).representativeTrace;
    expect(trace).toMatchObject({ capturedItemCount: 1, truncated: true, limits: { maxEvents: 5, maxItems: 1 } });
    expect(trace?.events.length).toBeLessThanOrEqual(5);
    expect(trace?.omittedEventCount).toBeGreaterThan(0);
  });

  it("is byte-for-byte repeatable for a fixed seed across uniform, normal and exponential sampling", () => {
    const experiment = structuredClone(LINE);
    experiment.seed = 42;
    experiment.replications = 3;
    experiment.model.nodes[0] = { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "exponential", mean: 4 }, maxItems: 15 };
    experiment.model.nodes[1] = { id: "station", name: "装配", kind: "station", processingTime: { kind: "normal", mean: 2, standardDeviation: 0.4, minimum: 0.1 } };
    experiment.model.nodes[3] = { id: "transport", name: "转运", kind: "transport", travelTime: { kind: "uniform", minimum: 0.5, maximum: 1.5 }, resourceId: "agv-1" };
    expect(runPlantLiteExperiment(experiment)).toEqual(runPlantLiteExperiment(experiment));
  });

  it("keeps the warmed physical state but measures every operational metric only after warmup", () => {
    const experiment: PlantLiteExperiment = {
      seed: "warmup-window",
      replications: 2,
      limits: { durationMinutes: 10, warmupMinutes: 5, maxEvents: 1_000, maxResources: 1 },
      model: {
        id: "warmup-line",
        name: "warmup line",
        energyEconomics: { electricityPricePerKwh: 1, carbonEmissionFactorKgPerKwh: 0.5 },
        resources: [{
          id: "equipment",
          name: "设备",
          kind: "equipment",
          capacity: 1,
          failure: {
            timeToFailure: { kind: "deterministic", value: 4 },
            repairTime: { kind: "deterministic", value: 4 },
          },
          power: { activePowerKw: 60, idlePowerKw: 0, source: "measured" },
        }],
        nodes: [
          { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 100 }, maxItems: 1 },
          { id: "station", name: "加工", kind: "station", processingTime: { kind: "deterministic", value: 6 }, resourceId: "equipment" },
          { id: "sink", name: "产出", kind: "sink" },
        ],
        edges: [{ id: "a", from: "source", to: "station" }, { id: "b", from: "station", to: "sink" }],
      },
    };

    const first = runPlantLiteExperiment(experiment);
    const repeated = runPlantLiteExperiment(experiment);
    const run = first.replications[0]!;
    expect(first).toEqual(repeated);
    expect(run).toMatchObject({
      simulatedMinutes: 10,
      measurementMinutes: 5,
      completedItems: 1,
      throughputPerHour: 12,
      averageWip: 0.2,
      averageLeadTimeMinutes: 6,
      energy: { activeEnergyKwh: 1, totalEnergyKwh: 1, energyPerCompletedItemKwh: 1 },
    });
    expect(run.nodes.find((node) => node.nodeId === "station")).toMatchObject({ utilization: 0.2 });
    expect(run.resources[0]).toMatchObject({ utilization: 0.2, failedMinutes: 3 });
    expect(first.confidence95.throughputPerHour).toMatchObject({ mean: 12, samples: 2 });
    expect(first.energy95?.totalEnergyKwh).toMatchObject({ mean: 1, samples: 2 });
  });

  it("rejects a negative warmup or a warmup without a non-empty measurement window", () => {
    expect(() => runPlantLiteExperiment({ ...LINE, limits: { ...LINE.limits, warmupMinutes: -1 } })).toThrow("warmupMinutes");
    expect(() => runPlantLiteExperiment({ ...LINE, limits: { ...LINE.limits, warmupMinutes: 60 } })).toThrow("warmupMinutes");
  });

  it("honors shift windows and failure/repair while keeping in-flight work non-preemptive", () => {
    const experiment = structuredClone(LINE);
    experiment.replications = 1;
    experiment.limits!.durationMinutes = 25;
    experiment.model.resources![0] = {
      id: "agv-1", name: "AGV 1", kind: "agv", capacity: 1,
      availability: { shifts: [{ startMinute: 10, endMinute: 20 }] },
      failure: { timeToFailure: { kind: "deterministic", value: 8 }, repairTime: { kind: "deterministic", value: 2 } }
    };
    experiment.trace = { replication: 0, maxEvents: 200, maxItems: 10 };
    const result = runPlantLiteExperiment(experiment);
    const run = result.replications[0]!;
    expect(run.completedItems).toBeGreaterThan(0);
    expect(run.resources[0]).toMatchObject({ resourceId: "agv-1", failedMinutes: 2 });
    expect(run.nodes.find((node) => node.nodeId === "transport")?.starvedMinutes).toBeGreaterThan(0);
    expect(result.representativeTrace?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "resource-failure", resourceId: "agv-1", atMinute: 18 }),
      expect.objectContaining({ type: "resource-repair", resourceId: "agv-1" }),
    ]));
  });

  it("models station equipment capacity and reliability with real trace and downtime statistics", () => {
    const experiment = structuredClone(LINE);
    experiment.replications = 1;
    experiment.limits!.durationMinutes = 12;
    const station = experiment.model.nodes.find((node) => node.id === "station");
    if (!station || station.kind !== "station") throw new Error("missing fixture station");
    station.capacity = 3;
    station.resourceId = "assembly-equipment";
    experiment.model.resources!.push({
      id: "assembly-equipment",
      name: "装配设备",
      kind: "equipment",
      capacity: 1,
      failure: {
        timeToFailure: { kind: "deterministic", value: 4 },
        repairTime: { kind: "deterministic", value: 2 },
      },
    });
    experiment.trace = { replication: 0, maxEvents: 200, maxItems: 10 };

    expect(validatePlantLiteModel(experiment.model)).toMatchObject({ valid: true });
    expect(plantLiteEffectiveCapacity(experiment.model, station)).toBe(1);
    const result = runPlantLiteExperiment(experiment);
    expect(result.replications[0]?.resources).toContainEqual(expect.objectContaining({ resourceId: "assembly-equipment", failedMinutes: 4 }));
    expect(result.replications[0]?.resources.find((resource) => resource.resourceId === "assembly-equipment")?.utilization).toBeLessThanOrEqual(1);
    expect(result.resourceFailedMinutes95["assembly-equipment"]).toMatchObject({ mean: 4, samples: 1 });
    expect(result.representativeTrace?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "resource-failure", resourceId: "assembly-equipment" }),
      expect.objectContaining({ type: "resource-repair", resourceId: "assembly-equipment" }),
    ]));
  });

  it("models each fleet unit independently and records partial degradation in the trace", () => {
    const experiment = structuredClone(LINE);
    experiment.replications = 1;
    experiment.limits!.durationMinutes = 20;
    experiment.model.resources![0] = {
      id: "agv-1",
      name: "AGV fleet",
      kind: "agv",
      capacity: 3,
      failure: {
        timeToFailure: { kind: "uniform", minimum: 3, maximum: 9 },
        repairTime: { kind: "deterministic", value: 2 },
      },
    };
    experiment.trace = { replication: 0, maxEvents: 400, maxItems: 20 };

    const result = runPlantLiteExperiment(experiment);
    const failures = result.representativeTrace?.events.filter((event) => event.type === "resource-failure") ?? [];
    expect(new Set(failures.map((event) => "unitIndex" in event ? event.unitIndex : undefined)).size).toBe(3);
    expect(failures).toContainEqual(expect.objectContaining({ unavailableUnits: 1 }));
    expect(result.replications[0]?.resources[0]?.failedMinutes).toBeGreaterThan(0);
  });

  it("keeps utilization bounded and does not call a fully busy station starved across shift end", () => {
    const experiment = structuredClone(LINE);
    experiment.replications = 1;
    experiment.limits!.durationMinutes = 20;
    experiment.model.nodes = [
      { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 100 }, initialDelay: 10, maxItems: 1 },
      { id: "station", name: "跨班加工", kind: "station", processingTime: { kind: "deterministic", value: 8 }, availability: { shifts: [{ startMinute: 10, endMinute: 11 }] } },
      { id: "sink", name: "成品", kind: "sink" },
    ];
    experiment.model.edges = [{ id: "a", from: "source", to: "station" }, { id: "b", from: "station", to: "sink" }];
    experiment.model.resources = [];

    const station = runPlantLiteExperiment(experiment).replications[0]?.nodes.find((node) => node.nodeId === "station");
    expect(station?.utilization).toBeLessThanOrEqual(1);
    expect(station?.starvedMinutes).toBe(0);
  });

  it("uses full-buffer duration and occupancy as reachable bottleneck evidence", () => {
    const experiment: PlantLiteExperiment = {
      seed: 7,
      replications: 1,
      limits: { durationMinutes: 10, maxEvents: 2_000, maxResources: 5 },
      model: {
        id: "buffer-pressure",
        name: "buffer pressure",
        resources: [{ id: "agv", name: "AGV", kind: "agv", capacity: 1 }],
        nodes: [
          { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 0.1 }, maxItems: 20 },
          { id: "buffer", name: "窄缓冲", kind: "queue-buffer", capacity: 1 },
          { id: "transport", name: "慢搬运", kind: "transport", travelTime: { kind: "deterministic", value: 100 }, queueCapacity: 1, resourceId: "agv" },
          { id: "sink", name: "成品", kind: "sink" },
        ],
        edges: [{ id: "a", from: "source", to: "buffer" }, { id: "b", from: "buffer", to: "transport" }, { id: "c", from: "transport", to: "sink" }],
      },
    };

    const run = runPlantLiteExperiment(experiment).replications[0]!;
    expect(run.nodes.find((node) => node.nodeId === "buffer")).toMatchObject({ blockedMinutes: expect.any(Number) });
    expect(run.nodes.find((node) => node.nodeId === "buffer")!.blockedMinutes).toBeGreaterThan(0);
    expect(run.bottleneckNodeId).toBe("buffer");
  });

  it("returns a bounded partial result when cancellation or the event cap is reached", () => {
    const cancelled = runPlantLiteExperiment(LINE, { shouldCancel: () => true });
    expect(cancelled.replications).toEqual([]);
    const limited = runPlantLiteExperiment({ ...LINE, replications: 1, limits: { durationMinutes: 60, maxEvents: 2, maxResources: 4 } });
    expect(limited.replications[0]).toMatchObject({ termination: "limit-reached", reason: "max-events" });
  });

  it("does not report the event limit when the last allowed event finishes the requested horizon", () => {
    const experiment = structuredClone(LINE);
    experiment.replications = 1;
    experiment.limits = { durationMinutes: 1, maxEvents: 1, maxResources: 4 };

    expect(runPlantLiteExperiment(experiment).replications[0]).toMatchObject({
      termination: "completed",
      processedEvents: 1,
      simulatedMinutes: 1,
    });
  });

  it("rejects an unknown transport resource at the contract boundary", () => {
    const invalid = structuredClone(LINE.model);
    (invalid.nodes[3] as { resourceId: string }).resourceId = "missing";
    expect(validatePlantLiteModel(invalid)).toMatchObject({ valid: false, issues: expect.arrayContaining([expect.objectContaining({ path: "$.nodes[3].resourceId", message: "未知资源" })]) });
  });

  it("rejects equipment on transport and transport fleets on stations", () => {
    const invalid = structuredClone(LINE.model);
    invalid.resources!.push({ id: "equipment", name: "设备", kind: "equipment", capacity: 1 });
    const station = invalid.nodes.find((node) => node.id === "station");
    const transport = invalid.nodes.find((node) => node.id === "transport");
    if (!station || station.kind !== "station" || !transport || transport.kind !== "transport") throw new Error("missing fixture nodes");
    station.resourceId = "agv-1";
    transport.resourceId = "equipment";
    expect(validatePlantLiteModel(invalid)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "$.nodes[1].resourceId", message: "工位资源必须是 equipment" }),
        expect.objectContaining({ path: "$.nodes[3].resourceId", message: "搬运资源必须是 agv 或 transport" }),
      ]),
    });
  });

  it("rejects a non-array resource payload before it reaches the runtime", () => {
    const invalid = { ...structuredClone(LINE.model), resources: { id: "not-an-array" } };
    expect(validatePlantLiteModel(invalid)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ path: "$.resources", message: "必须是数组" })]),
    });
  });
});
