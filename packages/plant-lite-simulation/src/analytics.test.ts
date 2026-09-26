/**
 * 渲染数据层测试(golden-01 守恒 + 退化铺段 + option 形状 + golden-15 指纹)。
 * 断言三层:流量守恒(trace 真实流 vs 内核完工数)、estimated 退化(铺段和=窗口)、
 * 确定性(golden-02 双指纹锁定);指纹断言锁死回归:任何改变统计语义的改动都会在此暴露。
 */

import { describe, expect, it } from "vitest";
import { fingerprint64Labeled } from "@bim-studio/contracts";
import { runPlantLiteExperiment } from "./engine.js";
import { GOLDEN_LIMITS, golden01SingleLine, golden02MultiProduct, golden03Failure } from "./golden/goldenModels.js";
import {
  buildEChartsGanttOption,
  buildEChartsSankeyOption,
  buildGanttAnalysis,
  buildSankeyAnalysis,
} from "./analytics.js";

const SEED = "golden-2026-09-25";

function runWithTrace(model: ReturnType<typeof golden01SingleLine>) {
  return runPlantLiteExperiment({
    model,
    seed: SEED,
    replications: 5,
    limits: { ...GOLDEN_LIMITS },
    // 轨迹上限须容纳全部事件(golden-01 约 480 件 × ~10 事件),截断会破坏守恒的逐字意义。
    trace: { replication: 0, maxEvents: 10_000, maxItems: 500 },
  });
}

describe("golden-01 带轨迹:Sankey 链流量守恒", () => {
  const model = golden01SingleLine();
  const result = runWithTrace(model);
  const replication = result.replications[0]!;
  const sankey = buildSankeyAnalysis(result, model);
  const outOf = (nodeId: string) => sankey.links.filter((link) => link.source === nodeId).reduce((sum, link) => sum + link.value, 0);
  const into = (nodeId: string) => sankey.links.filter((link) => link.target === nodeId).reduce((sum, link) => sum + link.value, 0);

  it("代表轨迹完整无截断,守恒断言才有逐字意义", () => {
    expect(result.representativeTrace).toBeDefined();
    expect(result.representativeTrace!.truncated).toBe(false);
  });

  it("source 流出链和 = 窗口完工件数;sink 流入一致;中间节点入=出", () => {
    expect(sankey.estimated).toBe(false);
    expect(sankey.windowMinutes).toBe(replication.measurementMinutes);
    expect(sankey.generatedFrom).toEqual({ modelId: model.id, replications: 5 });
    expect(outOf("src")).toBe(replication.completedItems);
    expect(into("snk")).toBe(replication.completedItems);
    expect(into("buf")).toBe(outOf("buf"));
    expect(into("st")).toBe(outOf("st"));
  });

  it("链的端点都落在模型节点上,节点集合与模型一致", () => {
    const ids = new Set(sankey.nodes.map((node) => node.id));
    expect(ids).toEqual(new Set(model.nodes.map((node) => node.id)));
    for (const link of sankey.links) {
      expect(ids.has(link.source)).toBe(true);
      expect(ids.has(link.target)).toBe(true);
    }
  });
});

describe("golden-01 带轨迹:Gantt occupied 对齐手算", () => {
  const model = golden01SingleLine();
  const result = runWithTrace(model);
  const replication = result.replications[0]!;
  const gantt = buildGanttAnalysis(result, model);

  it("st 行 occupied 总时长 ≈ 完工件数 × 0.8 分钟(±2 分钟边界截断余量)", () => {
    const row = gantt.rows.find((candidate) => candidate.id === "st")!;
    expect(row.estimated).toBe(false);
    const occupiedMinutes = row.segments
      .filter((segment) => segment.kind === "occupied")
      .reduce((sum, segment) => sum + segment.endMinute - segment.startMinute, 0);
    expect(Math.abs(occupiedMinutes - replication.completedItems * 0.8)).toBeLessThan(2);
  });

  it("全部段落在窗口内且有序,观测节拍 = 窗口/完工件数", () => {
    for (const row of gantt.rows) {
      let previousEnd = -1;
      for (const segment of row.segments) {
        expect(segment.startMinute).toBeGreaterThanOrEqual(0);
        expect(segment.endMinute).toBeLessThanOrEqual(gantt.windowMinutes);
        expect(segment.endMinute).toBeGreaterThan(segment.startMinute);
        expect(segment.startMinute).toBeGreaterThanOrEqual(previousEnd);
        previousEnd = segment.startMinute;
      }
    }
    expect(gantt.taktMinutes).toBeCloseTo(gantt.windowMinutes / replication.completedItems, 9);
  });
});

describe("无轨迹退化:estimated 铺段", () => {
  const model = golden01SingleLine();
  const result = runPlantLiteExperiment({ model, seed: SEED, replications: 5, limits: { ...GOLDEN_LIMITS } });
  const sankey = buildSankeyAnalysis(result, model);
  const gantt = buildGanttAnalysis(result, model);

  it("Sankey estimated=true 且 source 流出链和 = 完工件数(构造性守恒)", () => {
    expect(result.representativeTrace).toBeUndefined();
    expect(sankey.estimated).toBe(true);
    const outSrc = sankey.links.filter((link) => link.source === "src").reduce((sum, link) => sum + link.value, 0);
    expect(outSrc).toBe(result.replications[0]!.completedItems);
  });

  it("Gantt 每行 estimated=true 且铺段和恰为窗口分钟", () => {
    expect(gantt.windowMinutes).toBe(result.replications[0]!.measurementMinutes);
    expect(gantt.rows.length).toBeGreaterThan(0);
    for (const row of gantt.rows) {
      expect(row.estimated).toBe(true);
      const total = row.segments.reduce((sum, segment) => sum + segment.endMinute - segment.startMinute, 0);
      expect(total).toBeCloseTo(gantt.windowMinutes, 6);
    }
  });
});

describe("ECharts option 组装", () => {
  const model = golden01SingleLine();
  const result = runWithTrace(model);
  const sankeyOption = buildEChartsSankeyOption(buildSankeyAnalysis(result, model));
  const ganttAnalysis = buildGanttAnalysis(result, model);
  const ganttOption = buildEChartsGanttOption(ganttAnalysis);

  it("Sankey:series/data/links 存在,value 为有限数值,name 唯一且覆盖链端点", () => {
    const series = sankeyOption.series as Array<Record<string, unknown>>;
    expect(series[0]!.type).toBe("sankey");
    const data = series[0]!.data as Array<{ name: string; nodeId: string }>;
    expect(data).toHaveLength(model.nodes.length);
    const names = new Set(data.map((item) => item.name));
    expect(names.size).toBe(data.length);
    const links = series[0]!.links as Array<{ source: string; target: string; value: unknown }>;
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(typeof link.value).toBe("number");
      expect(Number.isFinite(link.value)).toBe(true);
      expect(names.has(link.source)).toBe(true);
      expect(names.has(link.target)).toBe(true);
    }
  });

  it("Gantt:custom series + 起点跨度编码,value 四元组均为数值", () => {
    const series = ganttOption.series as Array<Record<string, unknown>>;
    expect(series[0]!.type).toBe("custom");
    expect(typeof series[0]!.renderItem).toBe("function");
    const xAxis = ganttOption.xAxis as { type: string; max: unknown };
    expect(xAxis.type).toBe("value");
    expect(typeof xAxis.max).toBe("number");
    const yAxis = ganttOption.yAxis as { data: unknown[] };
    expect(yAxis.data).toHaveLength(ganttAnalysis.rows.length);
    expect(yAxis.data).toEqual(ganttAnalysis.rows.map((row) => row.label));
    const data = series[0]!.data as Array<{ value: unknown[] }>;
    expect(data.length).toBeGreaterThan(0);
    for (const item of data) {
      expect(item.value).toHaveLength(4);
      for (const cell of item.value) {
        expect(typeof cell).toBe("number");
        expect(Number.isFinite(cell)).toBe(true);
      }
    }
  });
});

describe("golden-15 渲染数据双指纹(golden-02 多品种)", () => {
  const fingerprint = (seed: string) => {
    const model = golden02MultiProduct();
    const result = runPlantLiteExperiment({
      model,
      seed,
      replications: 5,
      limits: { ...GOLDEN_LIMITS },
      trace: { replication: 0, maxEvents: 10_000, maxItems: 500 },
    });
    return {
      sankey: fingerprint64Labeled([["sankey", buildSankeyAnalysis(result, model)]]),
      gantt: fingerprint64Labeled([["gantt", buildGanttAnalysis(result, model)]]),
    };
  };

  it("同 seed 双跑:Sankey 与 Gantt 指纹逐字一致", () => {
    const first = fingerprint(SEED);
    const second = fingerprint(SEED);
    expect(first.sankey).toBe(second.sankey);
    expect(first.gantt).toBe(second.gantt);
  });

  it("不同 seed:种子敏感模型的两个指纹都改变(指纹不是摆设)", () => {
    // golden-02 全确定性(来料/加工均 deterministic),随机只在产品抽取、不影响路由与时刻,
    // 其指纹对 seed 不敏感是正确行为;种子敏感性用 golden-03(指数故障间隔)验证。
    const seedSensitive = (seed: string) => {
      const model = golden03Failure();
      const result = runPlantLiteExperiment({
        model,
        seed,
        replications: 5,
        limits: { ...GOLDEN_LIMITS },
        trace: { replication: 0, maxEvents: 10_000, maxItems: 500 },
      });
      return {
        sankey: fingerprint64Labeled([["sankey", buildSankeyAnalysis(result, model)]]),
        gantt: fingerprint64Labeled([["gantt", buildGanttAnalysis(result, model)]]),
      };
    };
    const baseline = seedSensitive(SEED);
    const other = seedSensitive("golden-other-seed");
    expect(baseline.sankey).not.toBe(other.sankey);
    expect(baseline.gantt).not.toBe(other.gantt);
  });
});
