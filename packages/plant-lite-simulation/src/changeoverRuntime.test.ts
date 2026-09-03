import { describe, expect, it } from "vitest";
import type { PlantLiteModel } from "./model.js";
import { runPlantLiteExperiment } from "./engine.js";
import { createAgvLinePlantLiteModel } from "./templates.js";
import { validatePlantLiteModel } from "./modelValidation.js";

describe("Plant Lite product mix and sequence-dependent changeovers", () => {
  it("keeps legacy models valid and free of invented product evidence", () => {
    const model = createAgvLinePlantLiteModel();
    expect(validatePlantLiteModel(model)).toMatchObject({ valid: true });
    const result = runPlantLiteExperiment({
      model,
      seed: "legacy",
      replications: 1,
      limits: { durationMinutes: 30, maxEvents: 10_000, maxResources: 100 },
    });
    expect(result.replications[0]?.productTypes).toEqual([]);
    expect(result.productTypeMetrics95).toEqual({});
    expect(result.replications[0]?.nodes.every((node) => node.changeoverCount === 0 && node.changeoverMinutes === 0)).toBe(true);
  });

  it("rejects incomplete mixes, unknown products, duplicate directions and parallel changeover stations", () => {
    const wrongTotal = mixedModel();
    wrongTotal.productTypes![0]!.share = 0.7;
    expect(issueMessages(wrongTotal)).toContain("产品投放比例合计必须为 1");

    const unknown = mixedModel();
    station(unknown).changeovers![0]!.toProductTypeId = "unknown";
    expect(issueMessages(unknown)).toContain("未知产品类型");

    const duplicate = mixedModel();
    station(duplicate).changeovers!.push({ ...station(duplicate).changeovers![0]! });
    expect(issueMessages(duplicate)).toContain("换型方向重复");

    const parallel = mixedModel();
    station(parallel).capacity = 2;
    expect(issueMessages(parallel)).toContain("序列相关换型当前仅支持并行数为 1 的工位");
  });

  it("reproduces the same mixed sequence and exposes per-product plus changeover evidence", () => {
    const model = mixedModel();
    const input = {
      model,
      seed: "fixed-mix",
      replications: 3,
      // 30 分钟窗口保持来料约束持续生效，避免两个方案都提前做完固定 60 件后吞吐恰好相同。
      limits: { durationMinutes: 30, maxEvents: 10_000, maxResources: 10 },
      trace: { replication: 0, maxEvents: 10_000, maxItems: 100 },
    } as const;
    const first = runPlantLiteExperiment(input);
    const second = runPlantLiteExperiment(input);
    expect(second).toEqual(first);

    const run = first.replications[0]!;
    const stationMetrics = run.nodes.find((node) => node.nodeId === "station")!;
    const traceStarts = first.representativeTrace!.events.filter((event) => event.type === "item-changeover-start");
    expect(stationMetrics.changeoverCount).toBeGreaterThan(0);
    expect(stationMetrics.changeoverCount).toBe(traceStarts.length);
    expect(stationMetrics.changeoverMinutes).toBeCloseTo(traceStarts.reduce((sum, event) => {
      const end = Math.min(input.limits.durationMinutes, event.atMinute + (event.changeover?.durationMinutes ?? 0));
      return sum + Math.max(0, end - event.atMinute);
    }, 0));
    expect(first.representativeTrace!.events.filter((event) => "itemId" in event).every((event) => Boolean(event.productTypeId))).toBe(true);

    const productMetrics = Object.values(first.productTypeMetrics95);
    expect(productMetrics).toHaveLength(2);
    expect(productMetrics.reduce((sum, metric) => sum + metric.completionShare.mean, 0)).toBeCloseTo(1);
    expect(productMetrics.every((metric) => metric.throughputPerHour.mean > 0 && metric.completedItems.mean > 0)).toBe(true);

    const withoutChangeovers = structuredClone(model);
    delete station(withoutChangeovers).changeovers;
    const noSetup = runPlantLiteExperiment({ ...input, model: withoutChangeovers });
    expect(noSetup.confidence95.throughputPerHour.mean).toBeGreaterThan(first.confidence95.throughputPerHour.mean);
  });

  it("treats an unlisted direction as explicit zero rather than inferring a duration", () => {
    const model = mixedModel();
    station(model).changeovers = [{ fromProductTypeId: "a", toProductTypeId: "b", minutes: 1 }];
    const result = runPlantLiteExperiment({
      model,
      seed: "fixed-mix",
      replications: 1,
      limits: { durationMinutes: 100, maxEvents: 10_000, maxResources: 10 },
      trace: { replication: 0, maxEvents: 10_000, maxItems: 100 },
    });
    const changes = result.representativeTrace!.events.filter((event) => event.type === "item-changeover-start");
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((event) => {
      const changeover = event.changeover;
      return changeover?.fromProductTypeId === "a" && changeover.toProductTypeId === "b";
    })).toBe(true);
  });

  it("does not turn a missing completion-share denominator into a zero-percent sample", () => {
    const result = runPlantLiteExperiment({
      model: mixedModel(),
      seed: "no-completion",
      replications: 2,
      limits: { durationMinutes: 0.1, maxEvents: 1_000, maxResources: 10 },
    });
    expect(result.productTypeMetrics95.a?.completedItems.samples).toBe(2);
    expect(result.productTypeMetrics95.a?.completionShare.samples).toBe(0);
    expect(result.productTypeMetrics95.b?.completionShare.samples).toBe(0);
  });

  it("keeps product sampling on a separate random stream from physical process variation", () => {
    const mixed = mixedModel();
    delete station(mixed).changeovers;
    const source = mixed.nodes.find((node) => node.kind === "source");
    if (!source || source.kind !== "source") throw new Error("source missing");
    source.interarrivalTime = { kind: "uniform", minimum: 0.3, maximum: 0.8 };
    station(mixed).processingTime = { kind: "normal", mean: 0.45, standardDeviation: 0.08, minimum: 0.1 };
    const untyped = structuredClone(mixed);
    delete untyped.productTypes;
    const options = { seed: "isolated-streams", replications: 2, limits: { durationMinutes: 100, maxEvents: 10_000, maxResources: 10 } } as const;
    const typedRun = runPlantLiteExperiment({ ...options, model: mixed });
    const untypedRun = runPlantLiteExperiment({ ...options, model: untyped });
    expect(typedRun.confidence95).toEqual(untypedRun.confidence95);
    expect(typedRun.nodeMetrics95).toEqual(untypedRun.nodeMetrics95);
  });
});

function mixedModel(): PlantLiteModel {
  return {
    id: "mixed-line",
    name: "混流产线",
    productTypes: [
      { id: "a", name: "产品 A", share: 0.5 },
      { id: "b", name: "产品 B", share: 0.5 },
    ],
    nodes: [
      { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 0.5 }, maxItems: 60 },
      {
        id: "station",
        name: "装配",
        kind: "station",
        processingTime: { kind: "deterministic", value: 0.2 },
        capacity: 1,
        changeovers: [
          { fromProductTypeId: "a", toProductTypeId: "b", minutes: 1 },
          { fromProductTypeId: "b", toProductTypeId: "a", minutes: 2 },
        ],
      },
      { id: "sink", name: "成品", kind: "sink" },
    ],
    edges: [
      { id: "source-station", from: "source", to: "station" },
      { id: "station-sink", from: "station", to: "sink" },
    ],
  };
}

function station(model: PlantLiteModel): Extract<PlantLiteModel["nodes"][number], { kind: "station" }> {
  return model.nodes.find((node): node is Extract<PlantLiteModel["nodes"][number], { kind: "station" }> => node.kind === "station")!;
}

function issueMessages(model: PlantLiteModel): string {
  const validation = validatePlantLiteModel(model);
  return validation.valid ? "" : validation.issues.map((issue) => issue.message).join(";");
}
