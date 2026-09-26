/**
 * Study 报告闭环断言:字段完整性、指纹透传、limitations 四条必含、Markdown 关键节与表格行数、
 * 同输入确定性、生成性能采样(纯内存组装:1000 次组装+渲染均值 <5ms,1 万次组装采样同预算;
 * "报告生成 P95 ≤10s" 规格由纯组装路径保证,与仿真运行时长解耦)。
 */

import { describe, expect, it } from "vitest";
import type { StudyReportExperimentSummary, StudyReportInput } from "@bim-studio/contracts";
import { buildGanttAnalysis, buildSankeyAnalysis } from "./analytics.js";
import { plantLiteSimulationEngine } from "./enginePort.js";
import type { PlantLiteExperimentResult, PlantLiteModel } from "./model.js";
import { buildStudyReport, renderStudyReportMarkdown } from "./studyReport.js";

const SEED = "study-report-2026-09-26";
const GENERATED_AT = "2026-09-26T08:00:00.000Z";

function lineModel(): PlantLiteModel {
  return {
    id: "study-report-line",
    name: "报告 · 单线",
    nodes: [
      { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 0.5 } },
      { id: "buf", name: "线前缓存", kind: "queue-buffer", capacity: 16 },
      { id: "st", name: "加工", kind: "station", processingTime: { kind: "deterministic", value: 0.95 }, resourceId: "mc" },
      { id: "snk", name: "出货", kind: "sink" },
    ],
    edges: [
      { id: "e1", from: "src", to: "buf" },
      { id: "e2", from: "buf", to: "st" },
      { id: "e3", from: "st", to: "snk" },
    ],
    resources: [{ id: "mc", name: "机床", kind: "equipment", capacity: 1 }],
  };
}

async function realRun(): Promise<PlantLiteExperimentResult & { inputFingerprint: string; resultFingerprint: string }> {
  const record = await plantLiteSimulationEngine.run({
    input: {
      model: lineModel(),
      seed: SEED,
      replications: 5,
      limits: { durationMinutes: 480, warmupMinutes: 60 },
      trace: { replication: 0, maxEvents: 4000, maxItems: 64 },
    },
    seed: SEED,
  });
  expect(record.termination).toBe("completed");
  return { ...record.result, inputFingerprint: record.inputFingerprint, resultFingerprint: record.resultFingerprint };
}

function ci(mean: number, halfWidth: number, samples = 5) {
  return { mean, sampleStandardDeviation: halfWidth * 2, lower95: mean - halfWidth, upper95: mean + halfWidth, samples };
}

/** 有能耗与订单的合成摘要,覆盖可选分节与 top-3 破平语义。 */
const syntheticSummary: StudyReportExperimentSummary = {
  confidence95: { throughputPerHour: ci(120, 5), averageWip: ci(6.2, 1.1), averageLeadTimeMinutes: ci(9.8, 0.9) },
  bottlenecks: [
    { nodeId: "st-b", occurrences: 3, probability: 0.6 },
    { nodeId: "st-a", occurrences: 2, probability: 0.4 },
    { nodeId: "st-c", occurrences: 1, probability: 0.2 },
    { nodeId: "st-d", occurrences: 1, probability: 0.2 },
  ],
  energy95: {
    activeEnergyKwh: ci(40, 2),
    idleEnergyKwh: ci(10, 1),
    totalEnergyKwh: ci(50, 2.5),
    energyPerCompletedItemKwh: ci(0.05, 0.005),
    electricityCost: ci(35, 2),
    electricityCostPerCompletedItem: ci(0.035, 0.004),
    carbonEmissionKg: ci(25, 1.5),
    carbonEmissionPerCompletedItemKg: ci(0.025, 0.003),
    peakDemandKw: ci(12, 0.8),
    consumerEnergyKwh: { "mc-2": ci(18, 1), "mc-1": ci(32, 1.6) },
  },
  productionOrderMetrics95: {
    "order-b": { completedItems: ci(96, 4), completionRate: ci(0.96, 0.03), onTimeFulfillmentRate: ci(0.9, 0.04), fullyCompletedRate: ci(0.8, 0.05), observedTardinessMinutes: ci(3.2, 1.1) },
    "order-a": { completedItems: ci(100, 0), completionRate: ci(1, 0), onTimeFulfillmentRate: ci(1, 0), fullyCompletedRate: ci(1, 0), observedTardinessMinutes: ci(0, 0) },
  },
  measurementMinutes: 420,
};

function syntheticInput(overrides: Partial<StudyReportInput> = {}): StudyReportInput {
  return {
    studyId: "study-synthetic",
    title: "合成研究",
    engineId: "plant-lite-des",
    engineVersion: "1.0.0",
    seed: SEED,
    replications: 5,
    generatedAt: GENERATED_AT,
    inputFingerprint: "fp-input-synthetic",
    resultFingerprint: "fp-result-synthetic",
    experimentResult: syntheticSummary,
    model: { nodeCount: 6, resourceCount: 2, productTypeCount: 2, productionOrderCount: 2 },
    ...overrides,
  };
}

function kpiTableRows(markdown: string, heading: string): number {
  const section = markdown.split(heading)[1]!.split("\n## ")[0]!;
  return section.split("\n").filter((line) => line.startsWith("|")).length - 2;
}

describe("buildStudyReport 字段完整性", () => {
  it("真实引擎运行:meta/kpis/瓶颈/可选分节齐全,ci95.samples 为已完成重复数", async () => {
    const result = await realRun();
    const report = buildStudyReport({
      studyId: "study-1",
      title: "单线基线研究",
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      seed: SEED,
      replications: result.replications.length,
      generatedAt: GENERATED_AT,
      inputFingerprint: result.inputFingerprint,
      resultFingerprint: result.resultFingerprint,
      experimentResult: { ...result, measurementMinutes: result.replications[0]?.measurementMinutes },
      model: { nodeCount: 4, resourceCount: 1 },
      lineage: { baselineStudyId: "study-0", reproductionOf: null },
    });
    expect(report.meta).toEqual({
      studyId: "study-1",
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      seed: SEED,
      replications: 5,
      generatedAt: GENERATED_AT,
      inputFingerprint: result.inputFingerprint,
      resultFingerprint: result.resultFingerprint,
    });
    expect(report.kpis.map((kpi) => kpi.key)).toEqual(["throughput-per-hour", "average-wip", "average-lead-time-minutes"]);
    for (const kpi of report.kpis) {
      expect(kpi.ci95?.samples).toBe(5);
      expect(kpi.provenance).toBe("measured");
      expect(kpi.ci95!.lower95).toBeLessThanOrEqual(kpi.value);
      expect(kpi.ci95!.upper95).toBeGreaterThanOrEqual(kpi.value);
    }
    expect(report.bottlenecks.length).toBeLessThanOrEqual(3);
    expect(report.model).toEqual({ nodeCount: 4, resourceCount: 1 });
    expect(report.energy).toBeUndefined();
    expect(report.orders).toBeUndefined();
    expect(report.sankey).toBeUndefined();
    expect(report.gantt).toBeUndefined();
    expect(report.lineage).toEqual({ baselineStudyId: "study-0", reproductionOf: null });
    expect(report.provenance).toBe("measured");
    expect(report.headline).toContain("件/h");
  });

  it("合成摘要:能耗并入 KPI、订单准交率进 KPI、瓶颈取 top-3 并按节点 ID 破平", () => {
    const report = buildStudyReport(syntheticInput());
    expect(report.kpis.map((kpi) => kpi.key)).toEqual([
      "throughput-per-hour",
      "average-wip",
      "average-lead-time-minutes",
      "energy-total",
      "energy-per-item",
      "carbon-emission",
      "peak-demand",
      "order-order-a-on-time",
      "order-order-b-on-time",
    ]);
    expect(report.kpis.find((kpi) => kpi.key === "energy-total")?.value).toBe(50);
    expect(report.kpis.find((kpi) => kpi.key === "order-order-a-on-time")?.value).toBe(100);
    expect(report.bottlenecks.map((entry) => entry.nodeId)).toEqual(["st-b", "st-a", "st-c"]);
    expect(report.orders?.map((order) => order.orderId)).toEqual(["order-a", "order-b"]);
    expect(report.orders?.[0]!.onTimeFulfillmentRate.value).toBe(100);
    expect(report.energy?.consumerEnergyKwh.map((consumer) => consumer.consumerId)).toEqual(["mc-1", "mc-2"]);
    expect(report.energy?.electricityCost.unit).toBe("元");
  });

  it("零完成重复(insufficient-data)立即报错,禁止产出全零报告", () => {
    const empty: StudyReportExperimentSummary = {
      confidence95: {
        throughputPerHour: { mean: 0, lower95: 0, upper95: 0, samples: 0 },
        averageWip: { mean: 0, lower95: 0, upper95: 0, samples: 0 },
        averageLeadTimeMinutes: { mean: 0, lower95: 0, upper95: 0, samples: 0 },
      },
      bottlenecks: [],
    };
    expect(() => buildStudyReport(syntheticInput({ experimentResult: empty }))).toThrow(/没有已完成的 replication/);
  });
});

describe("指纹与 limitations", () => {
  it("指纹透传:报告 meta 原样携带运行记录双指纹", async () => {
    const result = await realRun();
    const report = buildStudyReport({
      studyId: "study-1",
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      seed: SEED,
      replications: result.replications.length,
      generatedAt: GENERATED_AT,
      inputFingerprint: result.inputFingerprint,
      resultFingerprint: result.resultFingerprint,
      experimentResult: result,
      model: { nodeCount: 4, resourceCount: 1 },
    });
    expect(report.meta.inputFingerprint).toBe(result.inputFingerprint);
    expect(report.meta.resultFingerprint).toBe(result.resultFingerprint);
  });

  it("limitations 固定四条:置信区间口径/预热窗口/estimated 标注/非认证结论,窗口分钟数写入文案", async () => {
    const result = await realRun();
    const report = buildStudyReport({
      studyId: "study-1",
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      seed: SEED,
      replications: result.replications.length,
      generatedAt: GENERATED_AT,
      inputFingerprint: result.inputFingerprint,
      resultFingerprint: result.resultFingerprint,
      experimentResult: { ...result, measurementMinutes: 420 },
      model: { nodeCount: 4, resourceCount: 1 },
    });
    expect(report.limitations).toHaveLength(4);
    expect(report.limitations[0]).toContain("置信区间口径");
    expect(report.limitations[1]).toContain("预热窗口");
    expect(report.limitations[1]).toContain("420");
    expect(report.limitations[2]).toContain("estimated 模式标注");
    expect(report.limitations[2]).toContain("实测仿真统计");
    expect(report.limitations[3]).toContain("非认证结论");
  });

  it("estimated 模式:含估算 Sankey/Gantt 时报告级 provenance=estimated 并逐项点名", () => {
    const report = buildStudyReport(syntheticInput({
      analytics: {
        sankey: { nodes: [], links: [], windowMinutes: 420, estimated: true, generatedFrom: { modelId: "m", replications: 5 } },
        gantt: { rows: [{ id: "st", label: "加工", estimated: true, segments: [] }], windowMinutes: 420 },
      },
    }));
    expect(report.provenance).toBe("estimated");
    expect(report.limitations[2]).toContain("物料流(Sankey)");
    expect(report.limitations[2]).toContain("时序图(Gantt)");
    expect(report.limitations[2]).not.toContain("实测仿真统计");
    expect(report.sankey?.estimated).toBe(true);
    expect(report.gantt?.rows[0]?.estimated).toBe(true);
  });

  it("实测 analytics(Sankey/Gantt)原样嵌入且报告保持 measured", async () => {
    const result = await realRun();
    const report = buildStudyReport({
      studyId: "study-1",
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      seed: SEED,
      replications: result.replications.length,
      generatedAt: GENERATED_AT,
      inputFingerprint: result.inputFingerprint,
      resultFingerprint: result.resultFingerprint,
      experimentResult: result,
      model: { nodeCount: 4, resourceCount: 1 },
      analytics: { sankey: buildSankeyAnalysis(result, lineModel()), gantt: buildGanttAnalysis(result, lineModel()) },
    });
    expect(report.sankey?.estimated).toBe(false);
    expect(report.gantt?.rows.length).toBe(1);
    expect(report.provenance).toBe("measured");
  });
});

describe("renderStudyReportMarkdown", () => {
  it("含关键节:标题/概览/结论/KPI 表/瓶颈/局限,指纹与引擎入文,KPI 表行数=KPI 数", async () => {
    const result = await realRun();
    const report = buildStudyReport({
      studyId: "study-1",
      title: "单线基线研究",
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      seed: SEED,
      replications: result.replications.length,
      generatedAt: GENERATED_AT,
      inputFingerprint: result.inputFingerprint,
      resultFingerprint: result.resultFingerprint,
      experimentResult: { ...result, measurementMinutes: 420 },
      model: { nodeCount: 4, resourceCount: 1 },
    });
    const markdown = renderStudyReportMarkdown(report);
    expect(markdown).toContain("# 仿真实验报告:单线基线研究");
    expect(markdown).toContain("## 概览");
    expect(markdown).toContain("## 结论");
    expect(markdown).toContain("## 关键指标(KPI)");
    expect(markdown).toContain("## 瓶颈 Top 3");
    expect(markdown).toContain("## 局限与免责声明");
    expect(markdown).toContain("plant-lite-des @ 1.0.0");
    expect(markdown).toContain(`\`${result.inputFingerprint}\``);
    expect(markdown).toContain(`\`${result.resultFingerprint}\``);
    expect(kpiTableRows(markdown, "## 关键指标(KPI)")).toBe(report.kpis.length);
    expect(markdown).toContain("平均吞吐");
    expect(markdown).toContain("预热期之后的 420 分钟");
  });

  it("合成报告:能耗/订单/Sankey/Gantt 分节与估算口径入文,缺指纹时显式标注缺失", () => {
    const report = buildStudyReport(syntheticInput({
      inputFingerprint: null,
      resultFingerprint: null,
      lineage: { baselineStudyId: "study-baseline", reproductionOf: "study-prev" },
      analytics: {
        sankey: { nodes: [{ id: "src", label: "来料" }], links: [{ source: "src", target: "st", value: 800 }], windowMinutes: 420, estimated: true, generatedFrom: { modelId: "m", replications: 5 } },
        gantt: { rows: [{ id: "st", label: "加工", estimated: true, segments: [{ startMinute: 0, endMinute: 420, kind: "occupied" }] }], windowMinutes: 420, taktMinutes: 0.5 },
      },
    }));
    const markdown = renderStudyReportMarkdown(report);
    expect(markdown).toContain("## 能耗与碳排");
    expect(markdown).toContain("## 生产订单");
    expect(markdown).toContain("## 物料流(Sankey)");
    expect(markdown).toContain("## 时序(Gantt)");
    expect(markdown).toContain("## 谱系");
    expect(markdown).toContain("基线 Study:study-baseline");
    expect(markdown).toContain("复现自:study-prev");
    expect(markdown).toContain("缺失(旧记录无指纹)");
    expect(markdown).toContain("order-a");
    expect(markdown).toContain("1/1 行为指标占比铺段");
    expect(markdown).toContain("按节点吞吐传播");
    expect(kpiTableRows(markdown, "## 关键指标(KPI)")).toBe(report.kpis.length);
  });
});

describe("确定性与性能", () => {
  it("同输入两次构建与渲染逐字一致(JSON 与 Markdown 双口径)", async () => {
    const result = await realRun();
    const input: StudyReportInput = {
      studyId: "study-1",
      title: "单线基线研究",
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      seed: SEED,
      replications: result.replications.length,
      generatedAt: GENERATED_AT,
      inputFingerprint: result.inputFingerprint,
      resultFingerprint: result.resultFingerprint,
      experimentResult: { ...result, measurementMinutes: 420 },
      model: { nodeCount: 4, resourceCount: 1 },
      lineage: { baselineStudyId: "study-0", reproductionOf: null },
    };
    const first = renderStudyReportMarkdown(buildStudyReport(input));
    const second = renderStudyReportMarkdown(buildStudyReport(input));
    expect(JSON.stringify(buildStudyReport(input))).toBe(JSON.stringify(buildStudyReport(input)));
    expect(first).toBe(second);
  });

  it("性能采样:1000 次组装+渲染均值 <5ms;1 万次组装采样均值 <5ms(P95 ≤10s 预算的纯组装下界)", () => {
    const input = syntheticInput();
    for (let warmup = 0; warmup < 20; warmup += 1) renderStudyReportMarkdown(buildStudyReport(input));
    const startedAt = performance.now();
    for (let iteration = 0; iteration < 1000; iteration += 1) renderStudyReportMarkdown(buildStudyReport(input));
    const buildAndRenderMeanMs = (performance.now() - startedAt) / 1000;
    expect(buildAndRenderMeanMs).toBeLessThan(5);
    const assemblyStartedAt = performance.now();
    for (let iteration = 0; iteration < 10000; iteration += 1) buildStudyReport(input);
    const assemblyMeanMs = (performance.now() - assemblyStartedAt) / 10000;
    expect(assemblyMeanMs).toBeLessThan(5);
  });
});
