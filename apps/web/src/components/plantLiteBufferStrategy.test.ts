import { describe, expect, it } from "vitest";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { createAgvLinePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import {
  createPlantLiteBufferCandidates,
  createPlantLiteBufferStrategySweep,
  listPlantLiteBufferOptions,
} from "./plantLiteBufferStrategy";

function study(): PlantLiteStudyRecord {
  const interval = { mean: 10, sampleStandardDeviation: 0, lower95: 10, upper95: 10, samples: 12 };
  return {
    id: "baseline",
    projectId: "project",
    name: "缓冲基线",
    createdAt: "2026-09-03T00:00:00Z",
    templateId: "agv-line-v1",
    model: createAgvLinePlantLiteModel({ agvCount: 2, bufferCapacity: 10 }),
    modelFingerprint: "model",
    seed: "fixed-seed",
    replications: 12,
    acceptanceTargets: { basis: "规划要求", minimumThroughputPerHour: 60 },
    inputFingerprint: "input",
    outcome: {
      status: "completed",
      completedReplications: 12,
      throughputPerHour: interval,
      averageWip: interval,
      averageLeadTimeMinutes: interval,
      resourceUtilization95: {},
      bottlenecks: [],
    },
    execution: {
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      inputFingerprint: "input",
      deterministic: true,
      limits: { durationMinutes: 480, maxEvents: 100_000, maxResources: 100 },
      trace: { replication: 2, maxEvents: 1_200, maxItems: 80 },
    },
  };
}

describe("Plant Lite buffer strategy", () => {
  it("derives bounded reduction and expansion candidates around the baseline", () => {
    expect(createPlantLiteBufferCandidates(10)).toEqual([
      expect.objectContaining({ capacity: 5, direction: "reduce", baselineFactor: 0.5 }),
      expect.objectContaining({ capacity: 8, direction: "reduce", baselineFactor: 0.75 }),
      expect.objectContaining({ capacity: 15, direction: "expand", baselineFactor: 1.5 }),
      expect.objectContaining({ capacity: 20, direction: "expand", baselineFactor: 2 }),
    ]);
    expect(createPlantLiteBufferCandidates(1).map((candidate) => candidate.capacity)).toEqual([2]);
    expect(createPlantLiteBufferCandidates(10_000).map((candidate) => candidate.capacity)).toEqual([5_000, 7_500]);
    expect(createPlantLiteBufferCandidates(0)).toEqual([]);
  });

  it("lists every authored buffer even when no bottleneck points at it", () => {
    const baseline = study();
    baseline.model!.nodes.push({ id: "reserve-buffer", name: "成品暂存", kind: "buffer", capacity: 24 });
    expect(listPlantLiteBufferOptions(baseline)).toEqual([
      { id: "queue-buffer", name: "工序间缓冲", capacity: 10 },
      { id: "reserve-buffer", name: "成品暂存", capacity: 24 },
    ]);
  });

  it("changes only the selected buffer and preserves fair-run evidence", () => {
    const baseline = study();
    const original = structuredClone(baseline);
    const sweep = createPlantLiteBufferStrategySweep(baseline, "queue-buffer")!;

    expect(sweep.currentCapacity).toBe(10);
    expect(sweep.requests.map((request) => request.model?.nodes.find((node) => node.id === "queue-buffer"))).toEqual([
      expect.objectContaining({ capacity: 5 }),
      expect.objectContaining({ capacity: 8 }),
      expect.objectContaining({ capacity: 15 }),
      expect.objectContaining({ capacity: 20 }),
    ]);
    expect(sweep.requests.every((request) => request.seed === "fixed-seed" && request.replications === 12)).toBe(true);
    expect(sweep.requests.every((request) => request.limits?.durationMinutes === 480 && request.trace?.replication === 2)).toBe(true);
    expect(sweep.requests.every((request) => request.acceptanceTargets?.minimumThroughputPerHour === 60)).toBe(true);
    expect(sweep.requests.every((request) => request.comparison?.baselineStudyId === baseline.id)).toBe(true);
    expect(sweep.requests.every((request) => request.comparison?.groupId === "buffer-strategy:baseline:queue-buffer")).toBe(true);
    expect(sweep.requests.every((request) => request.comparison?.parameterLabel === "工序间缓冲 · 缓冲容量")).toBe(true);
    sweep.requests.forEach((request, index) => {
      const expected = structuredClone(baseline.model!);
      expected.nodes = expected.nodes.map((node) => node.id === "queue-buffer"
        ? { ...node, capacity: sweep.candidates[index]!.capacity }
        : node);
      expect(request.model).toEqual(expected);
    });
    expect(baseline).toEqual(original);
  });

  it("does not invent a strategy for a missing buffer or unsupported saved capacity", () => {
    const baseline = study();
    expect(createPlantLiteBufferStrategySweep(baseline, "missing")).toBeUndefined();
    const buffer = baseline.model!.nodes.find((node) => node.id === "queue-buffer");
    if (!buffer || (buffer.kind !== "buffer" && buffer.kind !== "queue-buffer")) throw new Error("fixture buffer missing");
    buffer.capacity = 10_001;
    expect(createPlantLiteBufferStrategySweep(baseline, buffer.id)).toBeUndefined();
  });
});
