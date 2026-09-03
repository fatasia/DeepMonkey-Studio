import { describe, expect, it } from "vitest";
import type { PlantLiteModel, PlantLiteReplicationTrace } from "@bim-studio/contracts";
import { derivePlantLiteResourceTimeline } from "./plantLiteResourceTimelineModel";

const model: PlantLiteModel = {
  id: "line",
  name: "产线",
  nodes: [
    { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } },
    { id: "station", name: "装配", kind: "station", processingTime: { kind: "deterministic", value: 2 }, resourceId: "machine" },
    { id: "transport", name: "AGV 搬运", kind: "transport", travelTime: { kind: "deterministic", value: 1 }, resourceId: "agv" },
    { id: "sink", name: "完工", kind: "sink" },
  ],
  edges: [
    { id: "e1", from: "source", to: "station" },
    { id: "e2", from: "station", to: "transport" },
    { id: "e3", from: "transport", to: "sink" },
  ],
  resources: [
    { id: "machine", name: "装配机", kind: "equipment", capacity: 1 },
    { id: "agv", name: "AGV 车队", kind: "agv", capacity: 2 },
  ],
};

function trace(events: PlantLiteReplicationTrace["events"], truncated = false): PlantLiteReplicationTrace {
  return {
    engineId: "plant-lite-des",
    engineVersion: "1.0.0",
    replication: 0,
    seed: 42,
    events,
    capturedItemCount: 2,
    omittedEventCount: truncated ? 5 : 0,
    truncated,
    limits: { maxEvents: 100, maxItems: 20 },
  };
}

describe("Plant resource timeline", () => {
  it("pairs processing, transport and per-unit failure intervals", () => {
    const result = derivePlantLiteResourceTimeline(trace([
      { sequence: 0, atMinute: 1, type: "item-start", itemId: "source:1", nodeId: "station" },
      { sequence: 1, atMinute: 2, type: "resource-failure", resourceId: "agv", unitIndex: 1, unavailableUnits: 1 },
      { sequence: 2, atMinute: 3, type: "item-complete", itemId: "source:1", nodeId: "station" },
      { sequence: 3, atMinute: 3, type: "item-start", itemId: "source:1", nodeId: "transport" },
      { sequence: 4, atMinute: 4, type: "item-complete", itemId: "source:1", nodeId: "transport" },
      { sequence: 5, atMinute: 5, type: "resource-repair", resourceId: "agv", unitIndex: 1, unavailableUnits: 0 },
    ]), model);

    expect(result.durationMinutes).toBe(5);
    expect(result.intervalCount).toBe(3);
    expect(result.rows.map((row) => row.id)).toEqual(["node:station", "node:transport", "resource:agv"]);
    expect(result.rows[0]?.intervals[0]).toMatchObject({ startMinute: 1, endMinute: 3, kind: "processing", incomplete: false });
    expect(result.rows[2]?.intervals[0]).toMatchObject({ startMinute: 2, endMinute: 5, kind: "failure", incomplete: false });
  });

  it("keeps overlapping work on separate lanes and marks unmatched events incomplete", () => {
    const result = derivePlantLiteResourceTimeline(trace([
      { sequence: 0, atMinute: 0, type: "item-start", itemId: "source:1", nodeId: "station" },
      { sequence: 1, atMinute: 1, type: "item-start", itemId: "source:2", nodeId: "station" },
      { sequence: 2, atMinute: 3, type: "item-complete", itemId: "source:1", nodeId: "station" },
      { sequence: 3, atMinute: 4, type: "resource-failure", resourceId: "machine", unavailableUnits: 1 },
      { sequence: 4, atMinute: 6, type: "item-enter", itemId: "source:2", nodeId: "station" },
    ], true), model);

    const station = result.rows.find((row) => row.id === "node:station");
    const machine = result.rows.find((row) => row.id === "resource:machine");
    expect(station?.laneCount).toBe(2);
    expect(station?.intervals.find((item) => item.incomplete)).toMatchObject({ startMinute: 1, endMinute: 6 });
    expect(machine?.intervals[0]).toMatchObject({ startMinute: 4, endMinute: 6, incomplete: true });
  });

  it("renders completed and horizon-cut changeovers as separate station intervals", () => {
    const mixed = { ...model, productTypes: [{ id: "a", name: "阀体", share: 0.5 }, { id: "b", name: "泵体", share: 0.5 }] };
    const result = derivePlantLiteResourceTimeline(trace([
      { sequence: 0, atMinute: 1, type: "item-changeover-start", itemId: "source:1", nodeId: "station", productTypeId: "b", changeover: { fromProductTypeId: "a", toProductTypeId: "b", startMinute: 1, durationMinutes: 2 } },
      { sequence: 1, atMinute: 3, type: "item-changeover-complete", itemId: "source:1", nodeId: "station", productTypeId: "b", changeover: { fromProductTypeId: "a", toProductTypeId: "b", startMinute: 1, durationMinutes: 2 } },
      { sequence: 2, atMinute: 4, type: "item-changeover-start", itemId: "source:2", nodeId: "station", productTypeId: "a", changeover: { fromProductTypeId: "b", toProductTypeId: "a", startMinute: 4, durationMinutes: 3 } },
      { sequence: 3, atMinute: 5, type: "item-enter", itemId: "source:3", nodeId: "source", productTypeId: "a" },
    ]), mixed);
    const intervals = result.rows.find((row) => row.id === "node:station")?.intervals ?? [];
    expect(intervals).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "changeover", startMinute: 1, endMinute: 3, label: "阀体 → 泵体 · 换型", incomplete: false }),
      expect.objectContaining({ kind: "changeover", startMinute: 4, endMinute: 5, label: "泵体 → 阀体 · 换型", incomplete: true }),
    ]));
  });

  it("bounds rendered evidence while preserving the real total", () => {
    const events: PlantLiteReplicationTrace["events"] = [];
    for (let index = 0; index < 10; index += 1) {
      events.push({ sequence: index * 2, atMinute: index, type: "item-start", itemId: `item:${index}`, nodeId: "station" });
      events.push({ sequence: index * 2 + 1, atMinute: index + 0.5, type: "item-complete", itemId: `item:${index}`, nodeId: "station" });
    }
    const result = derivePlantLiteResourceTimeline(trace(events), model, 4);
    expect(result.intervalCount).toBe(10);
    expect(result.omittedIntervalCount).toBe(6);
    expect(result.rows.flatMap((row) => row.intervals)).toHaveLength(4);
  });
});
