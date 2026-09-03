import { describe, expect, it } from "vitest";
import type { PlantLiteModel, PlantLiteReplicationTrace } from "@bim-studio/contracts";
import { derivePlantLiteFlowSeries } from "./plantLiteFlowSeriesModel";

const model: PlantLiteModel = {
  id: "line",
  name: "装配线",
  nodes: [
    { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } },
    { id: "buffer", name: "线边缓存", kind: "queue-buffer", capacity: 20 },
    { id: "station", name: "装配", kind: "station", processingTime: { kind: "deterministic", value: 2 } },
    { id: "sink", name: "成品", kind: "sink" },
  ],
  edges: [
    { id: "e1", from: "source", to: "buffer" },
    { id: "e2", from: "buffer", to: "station" },
    { id: "e3", from: "station", to: "sink" },
  ],
};

function trace(events: PlantLiteReplicationTrace["events"], truncated = false): PlantLiteReplicationTrace {
  return {
    engineId: "plant-lite-des",
    engineVersion: "1.0.0",
    replication: 0,
    seed: 17,
    events,
    capturedItemCount: 2,
    omittedEventCount: truncated ? 9 : 0,
    truncated,
    limits: { maxEvents: 100, maxItems: 20 },
  };
}

describe("plantLiteFlowSeriesModel", () => {
  it("sorts same-minute events by sequence, never makes WIP negative, and counts unique sink completions", () => {
    const result = derivePlantLiteFlowSeries(trace([
      { sequence: 5, atMinute: 1, type: "item-complete", itemId: "source:1", nodeId: "sink" },
      { sequence: 2, atMinute: 1, type: "item-exit", itemId: "source:1", nodeId: "source" },
      { sequence: 4, atMinute: 1, type: "item-enter", itemId: "source:1", nodeId: "sink" },
      { sequence: 1, atMinute: 1, type: "item-enter", itemId: "source:1", nodeId: "source" },
      { sequence: 6, atMinute: 1, type: "item-complete", itemId: "source:1", nodeId: "sink" },
      { sequence: 7, atMinute: 2, type: "item-complete", itemId: "orphan", nodeId: "sink" },
    ]), model);

    expect(result.flowPoints.map((point) => [point.atMinute, point.sequence, point.wip, point.completedItems])).toEqual([
      [0, -1, 0, 0],
      [1, 1, 1, 0],
      [1, 5, 0, 1],
      [2, 7, 0, 2],
    ]);
    expect(result.flowPoints.every((point) => point.wip >= 0)).toBe(true);
    expect(result).toMatchObject({ peakWip: 1, completedItems: 2 });
    expect(result.evidence.inferredTransitionCount).toBe(1);
  });

  it("treats a scrap disposition as a terminal WIP exit instead of leaving a ghost item", () => {
    const result = derivePlantLiteFlowSeries(trace([
      { sequence: 0, atMinute: 0, type: "item-enter", itemId: "source:1", nodeId: "source" },
      { sequence: 1, atMinute: 1, type: "item-enter", itemId: "source:1", nodeId: "station" },
      { sequence: 2, atMinute: 1, type: "item-start", itemId: "source:1", nodeId: "station" },
      { sequence: 3, atMinute: 3, type: "item-complete", itemId: "source:1", nodeId: "station" },
      { sequence: 4, atMinute: 3, type: "item-scrap", itemId: "source:1", nodeId: "station", quality: { configuredYieldRate: 0.8, disposition: "scrap" } },
    ]), model);

    expect(result).toMatchObject({ completedItems: 0, scrappedItems: 1, peakWip: 1 });
    expect(result.flowPoints.at(-1)).toMatchObject({ wip: 0, completedItems: 0 });
    expect(result.nodeSeries.find((series) => series.nodeId === "station")?.finalOccupancy).toBe(0);
  });

  it("derives node occupancy from enter/exit evidence and only returns the busiest requested nodes", () => {
    const busyModel: PlantLiteModel = {
      ...model,
      nodes: [
        model.nodes[0]!,
        { id: "a", name: "高位缓存", kind: "buffer", capacity: 10 },
        { id: "b", name: "次级缓存", kind: "buffer", capacity: 10 },
        { id: "c", name: "低位缓存", kind: "buffer", capacity: 10 },
        model.nodes.at(-1)!,
      ],
      edges: [],
    };
    const events: PlantLiteReplicationTrace["events"] = [];
    let sequence = 0;
    for (const [nodeId, count] of [["a", 3], ["b", 2], ["c", 1]] as const) {
      for (let item = 0; item < count; item += 1) {
        events.push({ sequence: sequence++, atMinute: item, type: "item-enter", itemId: `${nodeId}:${item}`, nodeId });
      }
      for (let item = 0; item < count; item += 1) {
        events.push({ sequence: sequence++, atMinute: 5 + item, type: "item-exit", itemId: `${nodeId}:${item}`, nodeId });
      }
    }
    const result = derivePlantLiteFlowSeries(trace(events), busyModel, { maxNodeSeries: 2 });

    expect(result.nodeSeries.map((series) => [series.nodeId, series.peakOccupancy, series.finalOccupancy])).toEqual([
      ["a", 3, 0],
      ["b", 2, 0],
    ]);
    expect(result).toMatchObject({ activeNodeCount: 3, omittedNodeSeriesCount: 1 });
    expect(result.nodeSeries[0]?.occupiedItemMinutes).toBeGreaterThan(result.nodeSeries[1]?.occupiedItemMinutes ?? 0);
  });

  it("keeps the peak when bounding SVG points and reports omitted drawing evidence", () => {
    const events: PlantLiteReplicationTrace["events"] = [];
    let sequence = 0;
    for (let item = 0; item < 20; item += 1) {
      events.push({ sequence: sequence++, atMinute: item * 2, type: "item-enter", itemId: `item:${item}`, nodeId: "buffer" });
      events.push({ sequence: sequence++, atMinute: item * 2 + 1, type: "item-exit", itemId: `item:${item}`, nodeId: "buffer" });
    }
    events.push({ sequence: sequence++, atMinute: 50, type: "item-enter", itemId: "peak:1", nodeId: "buffer" });
    events.push({ sequence: sequence++, atMinute: 50, type: "item-enter", itemId: "peak:2", nodeId: "buffer" });
    events.push({ sequence: sequence++, atMinute: 50, type: "item-enter", itemId: "peak:3", nodeId: "buffer" });
    const result = derivePlantLiteFlowSeries(trace(events), model, { maxPointsPerSeries: 8 });

    expect(result.nodeSeries[0]?.points).toHaveLength(8);
    expect(result.nodeSeries[0]?.points.some((point) => point.occupancy === 3)).toBe(true);
    expect(result.omittedVisualizationPointCount).toBeGreaterThan(0);
  });

  it("supports empty and legacy traces without claiming complete capture", () => {
    const empty = derivePlantLiteFlowSeries(trace([]), model);
    expect(empty).toMatchObject({ durationMinutes: 0, peakWip: 0, completedItems: 0, nodeSeries: [] });

    const legacy = {
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      seed: 3,
      events: [
        { sequence: 0, atMinute: 1, type: "item-start", itemId: "old:1", nodeId: "station" },
        { sequence: 1, atMinute: 3, type: "item-complete", itemId: "old:1", nodeId: "station" },
      ],
    } as unknown as PlantLiteReplicationTrace;
    const legacyResult = derivePlantLiteFlowSeries(legacy, model);
    expect(legacyResult.evidence).toMatchObject({ captureStatus: "unknown", replication: null, capturedItemCount: 1 });
    expect(legacyResult.evidence.inferredTransitionCount).toBeGreaterThan(0);
    expect(legacyResult.nodeSeries[0]).toMatchObject({ nodeId: "station", peakOccupancy: 1, finalOccupancy: 0 });
  });

  it("preserves trace capture limits and truncation provenance", () => {
    const result = derivePlantLiteFlowSeries(trace([
      { sequence: 0, atMinute: 0, type: "item-enter", itemId: "source:1", nodeId: "source" },
    ], true), model);
    expect(result.evidence).toMatchObject({
      captureStatus: "truncated",
      omittedEventCount: 9,
      limits: { maxEvents: 100, maxItems: 20 },
    });
  });
});
