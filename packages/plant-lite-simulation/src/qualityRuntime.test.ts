import { describe, expect, it } from "vitest";
import type { PlantLiteModel } from "./model.js";
import { runPlantLiteExperiment, validatePlantLiteModel } from "./index.js";

describe("Plant Lite station quality runtime", () => {
  it("validates optional station yield as a 0..1 ratio", () => {
    expect(validatePlantLiteModel(modelWithYield(0))).toMatchObject({ valid: true });
    expect(validatePlantLiteModel(modelWithYield(1))).toMatchObject({ valid: true });
    expect(issueMessages(modelWithYield(-0.01))).toContain("0 到 1");
    expect(issueMessages(modelWithYield(1.01))).toContain("0 到 1");
    expect(issueMessages(modelWithYield(Number.NaN))).toContain("0 到 1");
  });

  it("deterministically scraps failed inspections and never sends them downstream", () => {
    const input = {
      model: modelWithYield(0.72), seed: "quality-evidence", replications: 6,
      limits: { durationMinutes: 80, maxEvents: 100_000, maxResources: 10 },
      trace: { replication: 0, maxEvents: 10_000, maxItems: 500 },
    } as const;
    const first = runPlantLiteExperiment(input);
    const second = runPlantLiteExperiment(input);
    expect(second).toEqual(first);
    expect(first.quality95?.scrapItems.mean).toBeGreaterThan(0);
    expect(first.quality95?.goodOutputItems.mean).toBeGreaterThan(0);
    expect(first.quality95?.firstPassYield.mean).toBeGreaterThan(0.6);
    expect(first.quality95?.firstPassYield.mean).toBeLessThan(0.85);
    expect(first.quality95?.stationMetrics95.inspection?.inspectedItems.mean).toBeGreaterThan(0);
    expect(first.quality95?.stationMetrics95.inspection?.scrapItems.mean).toBeGreaterThan(0);

    const trace = first.representativeTrace!;
    const scrapEvents = trace.events.filter((event) => event.type === "item-scrap");
    expect(scrapEvents.length).toBeGreaterThan(0);
    expect(scrapEvents.every((event) => event.quality?.configuredYieldRate === 0.72)).toBe(true);
    const scrappedIds = new Set(scrapEvents.map((event) => event.itemId));
    expect(trace.events.some((event) => "itemId" in event && scrappedIds.has(event.itemId) && event.nodeId === "sink")).toBe(false);
    expect(first.replications.every((run) => run.averageWip >= 0)).toBe(true);
  });

  it("keeps omitted quality behavior byte-for-byte stable and isolates quality draws from process sampling", () => {
    const legacyModel = modelWithYield(undefined);
    const perfectModel = modelWithYield(1);
    const options = {
      seed: "legacy-stability", replications: 3,
      limits: { durationMinutes: 60, maxEvents: 100_000, maxResources: 10 },
      trace: { replication: 0, maxEvents: 10_000, maxItems: 500 },
    } as const;
    const legacy = runPlantLiteExperiment({ ...options, model: legacyModel });
    const perfect = runPlantLiteExperiment({ ...options, model: perfectModel });
    expect(legacy.quality95).toBeUndefined();
    expect(perfect.quality95?.scrapItems.mean).toBe(0);
    expect(perfect.quality95?.firstPassYield.mean).toBe(1);
    expect(perfect.representativeTrace).toEqual(legacy.representativeTrace);
    expect(perfect.replications.map(({ quality: _quality, ...run }) => run)).toEqual(legacy.replications);
    expect(perfect.confidence95).toEqual(legacy.confidence95);
    expect(perfect.nodeMetrics95).toEqual(legacy.nodeMetrics95);
  });

  it("does not let a quality decision consume the physical process random stream", () => {
    const options = {
      seed: "stream-isolation", replications: 1,
      limits: { durationMinutes: 40, maxEvents: 100_000, maxResources: 10 },
      trace: { replication: 0, maxEvents: 10_000, maxItems: 500 },
    } as const;
    const lowYield = runPlantLiteExperiment({ ...options, model: modelWithYield(0.35) });
    const highYield = runPlantLiteExperiment({ ...options, model: modelWithYield(0.95) });
    const completionTimes = (events: NonNullable<typeof lowYield.representativeTrace>["events"]) => events
      .filter((event) => event.type === "item-complete" && event.nodeId === "inspection")
      .map((event) => event.atMinute);
    expect(completionTimes(lowYield.representativeTrace!.events)).toEqual(completionTimes(highYield.representativeTrace!.events));
    expect(lowYield.quality95?.scrapItems.mean).toBeGreaterThan(highYield.quality95?.scrapItems.mean ?? 0);
  });
});

function modelWithYield(yieldRate: number | undefined): PlantLiteModel {
  return {
    id: "quality-line",
    name: "质量检验线",
    nodes: [
      { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "uniform", minimum: 0.2, maximum: 0.3 }, maxItems: 500 },
      {
        id: "inspection", name: "检验工位", kind: "station",
        processingTime: { kind: "normal", mean: 0.22, standardDeviation: 0.025, minimum: 0.1 },
        capacity: 1, queueCapacity: 500,
        ...(yieldRate !== undefined ? { yieldRate } : {}),
      },
      { id: "sink", name: "合格品", kind: "sink" },
    ],
    edges: [{ id: "in", from: "source", to: "inspection" }, { id: "out", from: "inspection", to: "sink" }],
  };
}

function issueMessages(model: PlantLiteModel): string {
  const result = validatePlantLiteModel(model);
  return result.valid ? "" : result.issues.map((issue) => issue.message).join(";");
}
