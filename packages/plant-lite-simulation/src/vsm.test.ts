/**
 * VSM 价值流断言:golden-01 单线 pce 与 leadTime 手算对拍、inventory 节点进 elements、
 * Markdown 含 PCE、确定性双跑逐位一致、模型与结果不同源拒绝。
 * 手算口径:golden-01 来料 1 分钟/件(欠饱和,缓存近空),工时 0.8 分钟
 * → leadTime ≈ 0.8 分钟,processTime = 0.8 分钟,pce = 0.8/leadTime。
 */

import { describe, expect, it } from "vitest";
import { buildVsmAnalysis, renderVsmMarkdown, representativeMinutes } from "./vsm.js";
import { runPlantLiteExperiment } from "./engine.js";
import type { PlantLiteExperimentResult, PlantLiteModel } from "./model.js";
import { golden01SingleLine } from "./golden/goldenModels.js";

const LIMITS = { durationMinutes: 480, warmupMinutes: 60 } as const;

function runGolden01(model: PlantLiteModel = golden01SingleLine()): PlantLiteExperimentResult {
  return runPlantLiteExperiment({ model, seed: "vsm-golden-01", replications: 5, limits: LIMITS });
}

describe("VSM 价值流推导", () => {
  it("golden-01:pce 与 leadTime 手算对拍,要素四类齐备,流程为三条物流", () => {
    const model = golden01SingleLine();
    const result = runGolden01(model);
    const vsm = buildVsmAnalysis(model, result);
    const leadTime = result.confidence95.averageLeadTimeMinutes.mean;
    // 手算:欠饱和确定性单线(来料 1.0 > 工时 0.8),缓存零积压,交付期 = 工时 0.8 分钟。
    expect(leadTime).toBeCloseTo(0.8, 9);
    expect(leadTime).toBeGreaterThanOrEqual(0.79);
    expect(leadTime).toBeLessThanOrEqual(1.0);
    // pce = 工序时间 / 交付期 = 0.8/0.8 = 1(黄金值 100%,欠饱和理想线的理论上限)。
    expect(vsm.summary.processTimeMinutes).toBe(0.8);
    expect(vsm.summary.totalLeadTimeMinutes).toBe(0.8);
    expect(vsm.summary.pceRatio).toBe(1);
    expect(vsm.summary.pceRatio).toBeCloseTo(0.8 / leadTime, 9);
    // 节拍 = 来料间隔 1 分钟/件;需求率 60/小时。
    expect(vsm.summary.taktMinutes).toBe(1);
    expect(vsm.basis.demandItemsPerHour).toBe(60);
    // 要素:supplier(src)/ inventory(buf)/ process(st)/ customer(snk)。
    const byId = new Map(vsm.elements.map((element) => [element.id, element]));
    expect([...byId.keys()].sort()).toEqual(["buf", "snk", "src", "st"]);
    expect(byId.get("src")!.kind).toBe("supplier");
    expect(byId.get("snk")!.kind).toBe("customer");
    const station = byId.get("st")!;
    expect(station.kind).toBe("process");
    expect(station.metrics.cycleMinutes).toBe(0.8);
    expect(station.metrics.utilization).toBe(0.8);
    expect(station.metrics.changeoverMinutes).toBe(0);
    expect(station.metrics.uptimeFraction).toBe(1); // 无故障档案,可用率恒 1。
    // inventory 节点进 elements:欠饱和线缓存零积压(实测锁定)。
    const inventory = byId.get("buf")!;
    expect(inventory.kind).toBe("inventory");
    expect(inventory.metrics.inventoryItems).toBe(0);
    // 物流:三条边,吞吐 = 来料节拍 60 件/小时(欠饱和线,实测锁定)。
    expect(vsm.flows.map((flow) => `${flow.from}->${flow.to}`)).toEqual(["src->buf", "buf->st", "st->snk"]);
    for (const flow of vsm.flows) expect(flow.itemsPerHour).toBe(60);
  });

  it("Markdown 含 PCE 与要素行,数值与 summary 同源", () => {
    const model = golden01SingleLine();
    const vsm = buildVsmAnalysis(model, runGolden01(model));
    const markdown = renderVsmMarkdown(vsm);
    expect(markdown).toContain("PCE");
    expect(markdown).toContain(`流程效率 PCE:${(vsm.summary.pceRatio * 100).toFixed(1)}%`);
    expect(markdown).toContain("| st | process |");
    expect(markdown).toContain("| buf | inventory |");
    expect(markdown).toContain("| src | buf |");
    expect(markdown).toContain("节拍 Takt:1 分钟/件");
  });

  it("确定性:同模型同结果双跑逐位一致;分布代表值全形态可解析", () => {
    const model = golden01SingleLine();
    const first = buildVsmAnalysis(model, runGolden01(model));
    const second = buildVsmAnalysis(model, runGolden01(model));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(representativeMinutes({ kind: "deterministic", value: 2 })).toBe(2);
    expect(representativeMinutes({ kind: "uniform", minimum: 1, maximum: 3 })).toBe(2);
    expect(representativeMinutes({ kind: "exponential", mean: 5 })).toBe(5);
    expect(representativeMinutes({ kind: "normal", mean: 4, standardDeviation: 1 })).toBe(4);
  });

  it("模型与结果不同源或缺完成件立即拒绝", () => {
    const model = golden01SingleLine();
    // 另一个合法模型:工位改名为 st2,单独可运行;用它跑出的结果喂给 golden-01 即不同源。
    const otherModel: PlantLiteModel = {
      ...model,
      nodes: model.nodes.map((node) => node.id === "st" ? { ...node, id: "st2" } : node),
      edges: model.edges.map((edge) => edge.from === "st" || edge.to === "st"
        ? { ...edge, from: edge.from === "st" ? "st2" : edge.from, to: edge.to === "st" ? "st2" : edge.to }
        : edge),
    };
    const result = runGolden01(otherModel);
    expect(() => buildVsmAnalysis(model, result)).toThrow(/不同源/);
    const empty = { ...runGolden01(model), replications: [] } as unknown as PlantLiteExperimentResult;
    expect(() => buildVsmAnalysis(model, empty)).toThrow(/无已完成的 replication/);
  });
});
