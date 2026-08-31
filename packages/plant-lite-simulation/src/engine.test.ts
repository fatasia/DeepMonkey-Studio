import { describe, expect, it } from "vitest";
import { runPlantLiteExperiment, validatePlantLiteModel, type PlantLiteExperiment } from "./index.js";

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

  it("is byte-for-byte repeatable for a fixed seed across uniform, normal and exponential sampling", () => {
    const experiment = structuredClone(LINE);
    experiment.seed = 42;
    experiment.replications = 3;
    experiment.model.nodes[0] = { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "exponential", mean: 4 }, maxItems: 15 };
    experiment.model.nodes[1] = { id: "station", name: "装配", kind: "station", processingTime: { kind: "normal", mean: 2, standardDeviation: 0.4, minimum: 0.1 } };
    experiment.model.nodes[3] = { id: "transport", name: "转运", kind: "transport", travelTime: { kind: "uniform", minimum: 0.5, maximum: 1.5 }, resourceId: "agv-1" };
    expect(runPlantLiteExperiment(experiment)).toEqual(runPlantLiteExperiment(experiment));
  });

  it("honors shift windows and failure/repair while keeping in-flight work non-preemptive", () => {
    const experiment = structuredClone(LINE);
    experiment.replications = 1;
    experiment.limits!.durationMinutes = 25;
    experiment.model.resources![0] = {
      id: "agv-1", name: "AGV 1", kind: "agv", capacity: 1,
      availability: { shifts: [{ startMinute: 10, endMinute: 20 }] },
      failure: { timeToFailure: { kind: "deterministic", value: 12 }, repairTime: { kind: "deterministic", value: 2 } }
    };
    const run = runPlantLiteExperiment(experiment).replications[0]!;
    expect(run.completedItems).toBeGreaterThan(0);
    expect(run.resources[0]).toMatchObject({ resourceId: "agv-1", failedMinutes: 2 });
    expect(run.nodes.find((node) => node.nodeId === "transport")?.starvedMinutes).toBeGreaterThan(0);
  });

  it("returns a bounded partial result when cancellation or the event cap is reached", () => {
    const cancelled = runPlantLiteExperiment(LINE, { shouldCancel: () => true });
    expect(cancelled.replications).toEqual([]);
    const limited = runPlantLiteExperiment({ ...LINE, replications: 1, limits: { durationMinutes: 60, maxEvents: 2, maxResources: 4 } });
    expect(limited.replications[0]).toMatchObject({ termination: "limit-reached", reason: "max-events" });
  });

  it("rejects an unknown transport resource at the contract boundary", () => {
    const invalid = structuredClone(LINE.model);
    (invalid.nodes[3] as { resourceId: string }).resourceId = "missing";
    expect(validatePlantLiteModel(invalid)).toMatchObject({ valid: false, issues: expect.arrayContaining([expect.objectContaining({ path: "$.nodes[3].resourceId", message: "未知资源" })]) });
  });
});
