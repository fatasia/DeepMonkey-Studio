import { describe, expect, it } from "vitest";
import type { PlantLiteModel, PlantLiteReplicationTrace } from "@bim-studio/contracts";
import {
  derivePlantLitePlaybackFrame,
  describePlantLiteTraceEvent,
  formatPlantLiteMinute,
  plantLiteTraceDuration,
  preparePlantLitePlayback,
  selectPlantLitePlaybackFrame,
} from "./plantLitePlaybackModel";

const MODEL: PlantLiteModel = {
  id: "line",
  name: "line",
  nodes: [
    { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } },
    { id: "transport", name: "AGV 搬运", kind: "transport", resourceId: "agv", travelTime: { kind: "deterministic", value: 4 } },
    { id: "sink", name: "产出", kind: "sink" },
  ],
  edges: [{ id: "a", from: "source", to: "transport" }, { id: "b", from: "transport", to: "sink" }],
  resources: [{ id: "agv", name: "AGV 车队", kind: "agv", capacity: 1 }],
};

const TRACE: PlantLiteReplicationTrace = {
  engineId: "plant-lite-des",
  engineVersion: "1.0.0",
  replication: 0,
  seed: 42,
  capturedItemCount: 1,
  omittedEventCount: 0,
  truncated: false,
  limits: { maxEvents: 100, maxItems: 10 },
  events: [
    { sequence: 0, atMinute: 0, type: "item-enter", itemId: "source:1", nodeId: "source" },
    { sequence: 1, atMinute: 1, type: "item-enter", itemId: "source:1", nodeId: "transport" },
    { sequence: 2, atMinute: 1, type: "item-start", itemId: "source:1", nodeId: "transport" },
    { sequence: 3, atMinute: 2, type: "resource-failure", resourceId: "agv" },
    { sequence: 4, atMinute: 3, type: "resource-repair", resourceId: "agv" },
    { sequence: 5, atMinute: 5, type: "item-complete", itemId: "source:1", nodeId: "transport" },
    { sequence: 6, atMinute: 5, type: "item-enter", itemId: "source:1", nodeId: "sink" },
    { sequence: 7, atMinute: 5, type: "item-complete", itemId: "source:1", nodeId: "sink" },
  ],
};

describe("plantLitePlaybackModel", () => {
  it("counts waiting sample items, not events or the 18 visible markers, and seeks without accumulation", () => {
    const events: PlantLiteReplicationTrace["events"] = Array.from({ length: 25 }, (_, index) => ({
      sequence: index, atMinute: 0, type: "item-enter" as const, itemId: `item-${index}`, nodeId: "transport",
    }));
    events.push({ sequence: 25, atMinute: 1, type: "item-start", itemId: "item-0", nodeId: "transport" });
    events.push({ sequence: 26, atMinute: 2, type: "item-enter", itemId: "item-1", nodeId: "sink" });
    events.push({ sequence: 27, atMinute: 2, type: "item-complete", itemId: "item-1", nodeId: "sink" });
    const prepared = preparePlantLitePlayback({ ...TRACE, events, capturedItemCount: 25 }, MODEL);
    const before = selectPlantLitePlaybackFrame(prepared, 0);
    expect(before.items).toHaveLength(18);
    expect(before.waitingByNode).toEqual({ transport: 25 });
    expect(selectPlantLitePlaybackFrame(prepared, 1).waitingByNode).toEqual({ transport: 24 });
    expect(selectPlantLitePlaybackFrame(prepared, 2).waitingByNode).toEqual({ transport: 23 });
    expect(selectPlantLitePlaybackFrame(prepared, 0)).toEqual(before);
    expect(derivePlantLitePlaybackFrame(TRACE, MODEL, 5).waitingByNode).toEqual({});
  });
  it("interpolates a real transport interval and tracks resource failure state", () => {
    const frame = derivePlantLitePlaybackFrame(TRACE, MODEL, 2.5);
    expect(frame.items[0]).toMatchObject({ state: "moving", nodeId: "transport" });
    expect(frame.items[0]?.xPercent).toBeGreaterThan(50);
    expect(frame.items[0]?.xPercent).toBeLessThan(95);
    expect(frame.failedResourceIds).toEqual(["agv"]);
    expect(frame.items[0]?.transport).toEqual({ toNodeId: "sink", progress: .375 });
  });
  it("uses the actual recorded branch, and reverse seeking has no accumulated drift", () => {
    const model = structuredClone(MODEL);
    model.nodes.push({ id: "other", name: "另一出口", kind: "sink" });
    model.edges.unshift({ id: "wrong-first", from: "transport", to: "other" });
    const prepared = preparePlantLitePlayback(TRACE, model);
    const first = selectPlantLitePlaybackFrame(prepared, 2.5);
    selectPlantLitePlaybackFrame(prepared, 4.9);
    expect(selectPlantLitePlaybackFrame(prepared, 2.5)).toEqual(first);
    expect(first.items[0]?.transport?.toNodeId).toBe("sink");
  });
  it("does not invent travel for truncated evidence, and stays at the endpoint while waiting to exit", () => {
    const truncated = { ...TRACE, truncated: true, events: TRACE.events.slice(0, 5) };
    expect(derivePlantLitePlaybackFrame(truncated, MODEL, 2.5).items[0]?.transport).toBeUndefined();
    const delayed = { ...TRACE, events: TRACE.events.map(event => event.sequence >= 6 ? { ...event, atMinute: 7 } : event) };
    expect(derivePlantLitePlaybackFrame(delayed, MODEL, 6).items[0]?.transport).toEqual({ toNodeId: "sink", progress: 1 });
  });

  it("counts a completed sink item and clamps the playback cursor", () => {
    const frame = derivePlantLitePlaybackFrame(TRACE, MODEL, 999);
    expect(frame.atMinute).toBe(5);
    expect(frame.completedItems).toBe(1);
    expect(frame.activeItems).toBe(0);
    expect(frame.scrappedItems).toBe(0);
    expect(frame.failedResourceIds).toEqual([]);
    expect(plantLiteTraceDuration(TRACE)).toBe(5);
  });

  it("removes scrapped items from WIP and describes the recorded quality decision", () => {
    const model: PlantLiteModel = {
      ...MODEL,
      nodes: [MODEL.nodes[0]!, { id: "inspection", name: "终检", kind: "station", processingTime: { kind: "deterministic", value: 1 }, yieldRate: 0.8 }, MODEL.nodes[2]!],
      edges: [{ id: "a", from: "source", to: "inspection" }, { id: "b", from: "inspection", to: "sink" }],
      resources: [],
    };
    const scrap = { sequence: 3, atMinute: 2, type: "item-scrap", itemId: "source:1", nodeId: "inspection", quality: { configuredYieldRate: 0.8, disposition: "scrap" } } as const;
    const trace: PlantLiteReplicationTrace = { ...TRACE, events: [
      { sequence: 0, atMinute: 0, type: "item-enter", itemId: "source:1", nodeId: "source" },
      { sequence: 1, atMinute: 1, type: "item-enter", itemId: "source:1", nodeId: "inspection" },
      { sequence: 2, atMinute: 1, type: "item-start", itemId: "source:1", nodeId: "inspection" },
      scrap,
    ] };
    const frame = derivePlantLitePlaybackFrame(trace, model, 2);
    expect(frame).toMatchObject({ activeItems: 0, completedItems: 0, scrappedItems: 1, items: [] });
    expect(describePlantLiteTraceEvent(scrap, model)).toContain("判定报废（配置良率 80.0%）");
  });

  it("formats simulation time as a stable clock", () => {
    expect(formatPlantLiteMinute(65.5)).toBe("01:05:30");
  });

  it("shows a changeover state and describes product names instead of internal IDs", () => {
    const model: PlantLiteModel = {
      ...MODEL,
      productTypes: [{ id: "a", name: "阀体", share: 0.5 }, { id: "b", name: "泵体", share: 0.5 }],
      nodes: [MODEL.nodes[0]!, { id: "station", name: "装配", kind: "station", processingTime: { kind: "deterministic", value: 1 } }, MODEL.nodes[2]!],
      edges: [{ id: "a", from: "source", to: "station" }, { id: "b", from: "station", to: "sink" }],
      resources: [],
    };
    const event = { sequence: 0, atMinute: 2, type: "item-changeover-start", itemId: "source:1", nodeId: "station", productTypeId: "b", changeover: { fromProductTypeId: "a", toProductTypeId: "b", startMinute: 2, durationMinutes: 3 } } as const;
    const trace: PlantLiteReplicationTrace = { ...TRACE, events: [event], capturedItemCount: 1 };
    expect(derivePlantLitePlaybackFrame(trace, model, 2).items[0]?.state).toBe("changeover");
    expect(describePlantLiteTraceEvent(event, model)).toContain("阀体 → 泵体");
    expect(describePlantLiteTraceEvent(event, model)).not.toContain("a → b");
  });

  it("keeps a fleet degraded until every failed unit is repaired", () => {
    const trace = structuredClone(TRACE);
    trace.events = [
      { sequence: 0, atMinute: 2, type: "resource-failure", resourceId: "agv", unitIndex: 0, unavailableUnits: 1 },
      { sequence: 1, atMinute: 3, type: "resource-failure", resourceId: "agv", unitIndex: 1, unavailableUnits: 2 },
      { sequence: 2, atMinute: 4, type: "resource-repair", resourceId: "agv", unitIndex: 0, unavailableUnits: 1 },
      { sequence: 3, atMinute: 5, type: "resource-repair", resourceId: "agv", unitIndex: 1, unavailableUnits: 0 },
    ];
    trace.capturedItemCount = 0;
    const model = structuredClone(MODEL);
    model.resources![0]!.capacity = 2;
    const prepared = preparePlantLitePlayback(trace, model);

    expect(selectPlantLitePlaybackFrame(prepared, 4.5)).toMatchObject({
      failedResourceIds: ["agv"],
      unavailableResourceUnits: { agv: 1 },
    });
    expect(selectPlantLitePlaybackFrame(prepared, 5).failedResourceIds).toEqual([]);
  });

  it("selects frames from a 10k-event prepared index within an interactive budget", () => {
    const events: PlantLiteReplicationTrace["events"] = [];
    let sequence = 0;
    for (let item = 0; item < 500; item += 1) {
      for (let step = 0; step < 20; step += 1) {
        events.push({
          sequence: sequence++,
          atMinute: step * 0.5 + item * 0.0001,
          type: step % 2 === 0 ? "item-start" : "item-complete",
          itemId: `source:${item}`,
          nodeId: "transport",
        });
      }
    }
    const trace: PlantLiteReplicationTrace = { ...TRACE, events, capturedItemCount: 500, limits: { maxEvents: 10_000, maxItems: 500 } };
    const started = performance.now();
    const prepared = preparePlantLitePlayback(trace, MODEL);
    for (let frame = 0; frame < 50; frame += 1) selectPlantLitePlaybackFrame(prepared, frame * 0.2);
    const elapsed = performance.now() - started;

    expect(prepared.orderedEvents).toHaveLength(10_000);
    expect(elapsed).toBeLessThan(1_000);
  });
});
