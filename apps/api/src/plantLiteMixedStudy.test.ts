import { describe, expect, it } from "vitest";
import type { PlantLiteModel } from "@bim-studio/contracts";
import { plantLiteRequestFromRecord, runPlantLiteStudy } from "./plantLiteStudy.js";

describe("Plant Lite mixed-flow study persistence", () => {
  it("persists product mix, changeover statistics and a reproducible trace", () => {
    const first = runPlantLiteStudy("project", {
      name: "混流验证",
      model: mixedModel(),
      seed: "fixed-mix",
      replications: 3,
      limits: { durationMinutes: 100, maxEvents: 10_000, maxResources: 10 },
      trace: { replication: 0, maxEvents: 10_000, maxItems: 100 },
    }, "2026-09-03T00:00:00.000Z");
    const request = plantLiteRequestFromRecord(first);
    const second = runPlantLiteStudy("project", request, "2026-09-03T00:01:00.000Z");

    expect(first.model?.productTypes).toEqual(mixedModel().productTypes);
    expect(first.outcome.productTypeMetrics95?.a?.completionShare.samples).toBe(3);
    expect(first.outcome.productTypeMetrics95?.b?.throughputPerHour.mean).toBeGreaterThan(0);
    expect(first.outcome.nodeMetrics95?.station?.changeoverCount?.mean).toBeGreaterThan(0);
    expect(first.outcome.nodeMetrics95?.station?.changeoverMinutes?.mean).toBeGreaterThan(0);
    expect(first.trace?.events.some((event) => event.type === "item-changeover-start")).toBe(true);
    expect(second.inputFingerprint).toBe(first.inputFingerprint);
    expect(second.outcome).toEqual(first.outcome);
    expect(second.trace).toEqual(first.trace);
  });
});

function mixedModel(): PlantLiteModel {
  return {
    id: "mixed-line",
    name: "混流产线",
    productTypes: [{ id: "a", name: "产品 A", share: 0.55 }, { id: "b", name: "产品 B", share: 0.45 }],
    nodes: [
      { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 0.5 }, maxItems: 60 },
      { id: "station", name: "装配", kind: "station", processingTime: { kind: "deterministic", value: 0.2 }, changeovers: [{ fromProductTypeId: "a", toProductTypeId: "b", minutes: 1.5 }, { fromProductTypeId: "b", toProductTypeId: "a", minutes: 2 }] },
      { id: "sink", name: "成品", kind: "sink" },
    ],
    edges: [{ id: "source-station", from: "source", to: "station" }, { id: "station-sink", from: "station", to: "sink" }],
  };
}
