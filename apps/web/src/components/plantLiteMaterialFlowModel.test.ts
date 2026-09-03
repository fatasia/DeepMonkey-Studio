import { describe, expect, it } from "vitest";
import type { PlantLiteModel, PlantLiteReplicationTrace } from "@bim-studio/contracts";
import { derivePlantLiteMaterialFlowAnalysis } from "./plantLiteMaterialFlowModel";

const MODEL: PlantLiteModel = {
  id: "flow",
  name: "物料流",
  nodes: [
    { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } },
    { id: "station", name: "装配", kind: "station", processingTime: { kind: "deterministic", value: 3 } },
    { id: "buffer", name: "缓冲", kind: "queue-buffer", capacity: 10 },
    { id: "transport", name: "AGV", kind: "transport", resourceId: "agv", travelTime: { kind: "deterministic", value: 2 } },
    { id: "sink", name: "成品", kind: "sink" },
  ],
  edges: [
    { id: "source-station", from: "source", to: "station" },
    { id: "station-buffer", from: "station", to: "buffer" },
    { id: "buffer-transport", from: "buffer", to: "transport" },
    { id: "transport-sink", from: "transport", to: "sink" },
  ],
  resources: [{ id: "agv", name: "AGV", kind: "agv", capacity: 1 }],
};

function trace(events: PlantLiteReplicationTrace["events"], truncated = false): PlantLiteReplicationTrace {
  return {
    engineId: "plant-lite-des",
    engineVersion: "1.0.0",
    replication: 0,
    seed: 19,
    events,
    capturedItemCount: 2,
    omittedEventCount: truncated ? 7 : 0,
    truncated,
    limits: { maxEvents: 100, maxItems: 10 },
  };
}

describe("derivePlantLiteMaterialFlowAnalysis", () => {
  it("counts only observed exit-to-next-enter transfers and derives wait/service distributions", () => {
    const result = derivePlantLiteMaterialFlowAnalysis(MODEL, trace([
      { sequence: 0, atMinute: 0, type: "item-enter", itemId: "item-1", nodeId: "source" },
      { sequence: 1, atMinute: 0, type: "item-exit", itemId: "item-1", nodeId: "source" },
      { sequence: 2, atMinute: 0, type: "item-enter", itemId: "item-1", nodeId: "station" },
      { sequence: 3, atMinute: 2, type: "item-start", itemId: "item-1", nodeId: "station" },
      { sequence: 4, atMinute: 5, type: "item-complete", itemId: "item-1", nodeId: "station" },
      { sequence: 5, atMinute: 5, type: "item-exit", itemId: "item-1", nodeId: "station" },
      { sequence: 6, atMinute: 5, type: "item-enter", itemId: "item-1", nodeId: "buffer" },
      { sequence: 7, atMinute: 7, type: "item-exit", itemId: "item-1", nodeId: "buffer" },
      { sequence: 8, atMinute: 7, type: "item-enter", itemId: "item-1", nodeId: "transport" },
      { sequence: 9, atMinute: 8, type: "item-start", itemId: "item-1", nodeId: "transport" },
      { sequence: 10, atMinute: 10, type: "item-complete", itemId: "item-1", nodeId: "transport" },
      { sequence: 11, atMinute: 10, type: "item-exit", itemId: "item-1", nodeId: "transport" },
      { sequence: 12, atMinute: 10, type: "item-enter", itemId: "item-1", nodeId: "sink" },
      { sequence: 13, atMinute: 1, type: "item-exit", itemId: "item-2", nodeId: "source" },
      { sequence: 14, atMinute: 1, type: "item-enter", itemId: "item-2", nodeId: "station" },
      { sequence: 15, atMinute: 4, type: "item-start", itemId: "item-2", nodeId: "station" },
    ]));

    expect(result.edgeFlows.map((edge) => [edge.edgeId, edge.capturedTransferCount])).toEqual([
      ["source-station", 2],
      ["station-buffer", 1],
      ["buffer-transport", 1],
      ["transport-sink", 1],
    ]);
    expect(result.pairedTransferCount).toBe(5);
    expect(result.unpairedExitCount).toBe(0);
    expect(result.nodeTimings.find((node) => node.nodeId === "station")?.waiting).toMatchObject({
      samples: 2,
      meanMinutes: 2.5,
      p50Minutes: 2.5,
      p95Minutes: 2.95,
    });
    expect(result.nodeTimings.find((node) => node.nodeId === "station")?.processing).toMatchObject({ samples: 1, meanMinutes: 3 });
    expect(result.nodeTimings.find((node) => node.nodeId === "transport")).toMatchObject({
      waiting: { samples: 1, meanMinutes: 1 },
      processing: { samples: 1, meanMinutes: 2 },
    });
  });

  it("does not turn partial or out-of-model event pairs into edge evidence", () => {
    const result = derivePlantLiteMaterialFlowAnalysis(MODEL, trace([
      { sequence: 0, atMinute: 0, type: "item-exit", itemId: "partial", nodeId: "station" },
      { sequence: 1, atMinute: 1, type: "item-exit", itemId: "unknown", nodeId: "source" },
      { sequence: 2, atMinute: 1, type: "item-enter", itemId: "unknown", nodeId: "sink" },
      { sequence: 3, atMinute: 2, type: "item-enter", itemId: "partial-service", nodeId: "station" },
      { sequence: 4, atMinute: 3, type: "item-start", itemId: "partial-service", nodeId: "station" },
    ], true));

    expect(result.edgeFlows.every((edge) => edge.capturedTransferCount === 0)).toBe(true);
    expect(result.unpairedExitCount).toBe(1);
    expect(result.transfersOutsideModel).toBe(1);
    expect(result.nodeTimings.find((node) => node.nodeId === "station")).toMatchObject({
      waiting: { samples: 1, meanMinutes: 1 },
      processing: null,
    });
    expect(result).toMatchObject({ truncated: true, omittedEventCount: 7 });
  });

  it("keeps setup time out of queue waiting and processing durations", () => {
    const result = derivePlantLiteMaterialFlowAnalysis(MODEL, trace([
      { sequence: 0, atMinute: 0, type: "item-enter", itemId: "item-1", nodeId: "station", productTypeId: "b" },
      { sequence: 1, atMinute: 2, type: "item-changeover-start", itemId: "item-1", nodeId: "station", productTypeId: "b", changeover: { fromProductTypeId: "a", toProductTypeId: "b", startMinute: 2, durationMinutes: 3 } },
      { sequence: 2, atMinute: 5, type: "item-changeover-complete", itemId: "item-1", nodeId: "station", productTypeId: "b", changeover: { fromProductTypeId: "a", toProductTypeId: "b", startMinute: 2, durationMinutes: 3 } },
      { sequence: 3, atMinute: 5, type: "item-start", itemId: "item-1", nodeId: "station", productTypeId: "b" },
      { sequence: 4, atMinute: 8, type: "item-complete", itemId: "item-1", nodeId: "station", productTypeId: "b" },
    ]));
    expect(result.nodeTimings.find((node) => node.nodeId === "station")).toMatchObject({
      waiting: { meanMinutes: 2 },
      processing: { meanMinutes: 3 },
    });
  });

  it("keeps parallel edges unattributed when the trace contains no edge id", () => {
    const model: PlantLiteModel = { ...MODEL, edges: [...MODEL.edges, { id: "source-station-backup", from: "source", to: "station" }] };
    const result = derivePlantLiteMaterialFlowAnalysis(model, trace([
      { sequence: 0, atMinute: 0, type: "item-exit", itemId: "item-1", nodeId: "source" },
      { sequence: 1, atMinute: 0, type: "item-enter", itemId: "item-1", nodeId: "station" },
    ]));
    const parallel = result.edgeFlows.filter((edge) => edge.fromNodeId === "source" && edge.toNodeId === "station");
    expect(parallel).toHaveLength(2);
    expect(parallel.every((edge) => edge.capturedTransferCount === null && edge.routeCapturedTransferCount === 1)).toBe(true);
  });
});
