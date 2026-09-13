import { describe, expect, it } from "vitest";
import type { DashboardDataWidgetConfig, DashboardDataWidgetNode } from "@bim-studio/contracts";
import { assertDashboardSampleData } from "@bim-studio/contracts";
import { DASHBOARD_TEMPLATES } from "../components/dashboardTemplateCatalog";
import { buildDashboardTemplateNodes } from "../components/dashboardTemplateLayoutBuilder";
import { templateSupportsRealCover } from "./templateSampleData";
import { DAILY_PERIODS, DOMAIN_RHYTHMS, HOURLY_PERIODS, MONTH_PERIODS, WEEKLY_PERIODS, type RhythmAxis } from "./templateSampleDataProfiles";

/** 构建一页 1920×1080 的模板节点(经 buildDashboardTemplateNodes 内置的样例追加)。 */
function buildNodes(templateId: string, locale: "zh-CN" | "en-US" = "zh-CN"): DashboardDataWidgetNode[] {
  const template = DASHBOARD_TEMPLATES.find((candidate) => candidate.id === templateId)
    ?? DASHBOARD_TEMPLATES[0]!;
  return buildDashboardTemplateNodes(locale, { id: "test", name: "test", width: 1920, height: 1080, viewportFit: "contain", nodes: [] }, template, 0);
}

function widgetsOf(nodes: DashboardDataWidgetNode[]): DashboardDataWidgetConfig[] {
  return nodes.filter((node): node is Extract<DashboardDataWidgetNode, { kind: "data-widget" }> => node.kind === "data-widget").map((node) => node.widget);
}

function dataWidgetsOf(templateId: string, locale: "zh-CN" | "en-US" = "zh-CN"): DashboardDataWidgetConfig[] {
  return widgetsOf(buildNodes(templateId, locale)).filter((widget) => !["decoration", "filter", "text", "shape"].includes(widget.type));
}

function rowsWithoutSource(widget: DashboardDataWidgetConfig): unknown {
  const { sourceId: _sourceId, ...rest } = widget.sampleData!;
  return rest;
}

describe("templateSampleData", () => {
  it("每个模板的每个数据组件都带示例数据,且全部通过契约校验(行列上限/单元格类型)", () => {
    expect(DASHBOARD_TEMPLATES.length).toBeGreaterThan(200);
    for (const template of DASHBOARD_TEMPLATES) {
      for (const locale of ["zh-CN", "en-US"] as const) {
        for (const widget of dataWidgetsOf(template.id, locale)) {
          expect(widget.sampleData, `${template.id}/${locale}/${widget.key} 缺少 sampleData`).toBeDefined();
          expect(() => assertDashboardSampleData(widget.sampleData, `${template.id}/${widget.key}`)).not.toThrow();
          expect(widget.sampleData!.rows.length).toBeGreaterThan(0);
          expect(widget.analysis?.measureField).toBeTruthy();
        }
      }
    }
  });

  it("同模板同语言重复生成确定性一致(剔除随机 sourceId 后逐字节相等)", () => {
    for (const templateId of ["operations", "energy-supply", "logistics-risk"]) {
      const first = dataWidgetsOf(templateId).map(rowsWithoutSource);
      const second = dataWidgetsOf(templateId).map(rowsWithoutSource);
      expect(second).toEqual(first);
    }
  });

  it("不同模板生成不同数据(种子随 template.id 分叉,避免'换壳同数据')", () => {
    const operations = JSON.stringify(dataWidgetsOf("operations").map(rowsWithoutSource));
    const safety = JSON.stringify(dataWidgetsOf("safety").map(rowsWithoutSource));
    expect(safety).not.toBe(operations);
  });

  it("样例数据像真的:趋势有形状、占比全为正、排行降序、无全 0 序列", () => {
    // 趋势主图(executive → combo):同系列跨期间的值有波动
    const trend = dataWidgetsOf("operations").find((widget) => widget.key.includes(".primary."));
    const trendField = trend!.analysis!.measureField!;
    const trendValues = trend!.sampleData!.rows.map((row) => Number(row[trendField]));
    expect(Math.max(...trendValues)).toBeGreaterThan(Math.min(...trendValues));
    expect(Math.min(...trendValues)).toBeGreaterThan(0);

    // 饼图(executive → pie):占比行全为正
    const pie = dataWidgetsOf("operations").find((widget) => widget.key.includes(".secondary."));
    const pieField = pie!.analysis!.measureField!;
    for (const row of pie!.sampleData!.rows) expect(Number(row[pieField])).toBeGreaterThan(0);

    // 排行(明细):按度量降序
    const rankTemplate = DASHBOARD_TEMPLATES.find((template) => template.layout.detailType === "rank")!;
    const rank = dataWidgetsOf(rankTemplate.id).find((widget) => widget.key.includes(".detail."));
    const rankField = rank!.analysis!.measureField ?? rank!.field!;
    const rankValues = rank!.sampleData!.rows.map((row) => Number(row[rankField]));
    expect(rankValues).toEqual([...rankValues].sort((left, right) => right - left));

    // 无全 0 / 全常数序列
    for (const widget of dataWidgetsOf("operations")) {
      const field = widget.analysis?.measureField;
      if (!field || widget.type === "status") continue;
      const values = widget.sampleData!.rows.map((row) => row[field]);
      expect(new Set(values).size, `${widget.key} 是全常数序列`).toBeGreaterThan(1);
    }
  });

  it("百分比指标落在 0-100,进度槽位值在进度条语义内;状态位使用设备信号字面量", () => {
    for (const template of DASHBOARD_TEMPLATES) {
      const widgets = dataWidgetsOf(template.id);
      template.metrics.forEach((metric, index) => {
        const widget = widgets.find((candidate) => candidate.key === `${template.id}.${metric.dataKey}`);
        const type = template.layout.metricTypes[index];
        if (!widget || widget.type === "status") return;
        const values = widget.sampleData!.rows.map((row) => Number(row[widget.analysis!.measureField!]));
        for (const value of values) {
          if (type === "progress" || metric.unit === "%") expect(value).toBeGreaterThanOrEqual(0);
          if (type === "progress" || metric.unit === "%") expect(value).toBeLessThanOrEqual(100);
        }
      });
      // 状态位:值 ∈ 设备信号白名单(正常/预警/告警),首行固定"正常"
      widgets.filter((widget) => widget.type === "status").forEach((widget) => {
        const values = widget.sampleData!.rows.map((row) => row[widget.analysis!.measureField!]);
        for (const value of values) expect(["正常", "预警", "告警"]).toContain(value);
        expect(values[0]).toBe("正常");
      });
    }
  });

  it("行数据携带筛选联动列,值域与布局工厂筛选器选项(正常/预警/告警)对齐", () => {
    for (const template of DASHBOARD_TEMPLATES) {
      // production 保留手写小样例(按"产线 A/B/C"联动,非状态筛选),豁免
      if (template.id === "production") continue;
      for (const widget of dataWidgetsOf(template.id)) {
        // 桑基流向行(source/target/value)不参与状态筛选,其余行必须携带筛选列
        if (widget.type === "sankey") continue;
        for (const row of widget.sampleData!.rows) {
          const state = row[template.filterField];
          expect(state, `${template.id}/${widget.key} 缺少筛选联动列`).toBeDefined();
          expect(["正常", "预警", "告警"]).toContain(state);
        }
      }
    }
  });

  it("桑基为 source/target/value 流向行;旭日/树图挂两级 drillFields 层次", () => {
    const supply = DASHBOARD_TEMPLATES.find((template) => template.layout.primaryChart === "sankey")!;
    const sankey = dataWidgetsOf(supply.id).find((widget) => widget.key.includes(".primary."))!;
    for (const row of sankey.sampleData!.rows) {
      expect(typeof row.source).toBe("string");
      expect(typeof row.target).toBe("string");
      expect(Number(row.value)).toBeGreaterThan(0);
    }
    expect(sankey.analysis!.seriesField).toBe("target");

    const sunburstTemplate = DASHBOARD_TEMPLATES.find((template) => template.layout.secondaryChart === "sunburst")!;
    const sunburst = dataWidgetsOf(sunburstTemplate.id).find((widget) => widget.key.includes(".secondary."))!;
    expect(sunburst.analysis!.drillFields).toHaveLength(2);
    const treeTemplate = DASHBOARD_TEMPLATES.find((template) => template.layout.secondaryChart === "treemap")!;
    const tree = dataWidgetsOf(treeTemplate.id).find((widget) => widget.key.includes(".secondary."))!;
    expect(tree.analysis!.drillFields).toHaveLength(2);
  });

  it("主图缺失 GeoJSON 的 map 布局不做真渲染封面(诚实回退 SVG),其余全部参与", () => {
    for (const template of DASHBOARD_TEMPLATES) {
      expect(templateSupportsRealCover(template.layout)).toBe(template.layout.primaryChart !== "map");
    }
    const mapLayoutCount = DASHBOARD_TEMPLATES.filter((template) => !templateSupportsRealCover(template.layout)).length;
    expect(mapLayoutCount).toBeGreaterThan(0);
  });

  it("行/列规模在契约预算内(行 ≤100,列 ≤16)", () => {
    for (const template of DASHBOARD_TEMPLATES) {
      for (const widget of dataWidgetsOf(template.id)) {
        expect(widget.sampleData!.rows.length).toBeLessThanOrEqual(100);
        const columns = new Set(widget.sampleData!.rows.flatMap((row) => Object.keys(row)));
        expect(columns.size).toBeLessThanOrEqual(16);
      }
    }
  });
});

// ---- 波次 D:行业节律形状(趋势带的"行业时钟") -------------------------------------
// 断言"封面上形状肉眼可辨"的数学等价物:双峰、周末低谷、停机凹坑、检修台阶、
// 交易日缺口、开幕脉冲、开门扰动;阈值均已吸收 ±11% 噪声半幅(最坏组合推演)。

const RHYTHM_PERIOD_COUNTS: Record<RhythmAxis, number> = { hourly: 24, weekly: 7, daily: 30, monthly: 12 };

/** executive 主图(combo → trendPatch)首系列按期间序的值与期间标签(所有系列同期共享节律系数)。 */
function trendSeriesOf(templateId: string): { label: string; value: number }[] {
  const trend = dataWidgetsOf(templateId).find((widget) => widget.key.includes(".primary."));
  const field = trend!.analysis!.measureField!;
  const periodColumn = trend!.analysis!.dimensionField!;
  const seriesColumn = trend!.analysis!.seriesField!;
  const rows = trend!.sampleData!.rows;
  const firstSeriesName = rows[0]![seriesColumn];
  const series: { label: string; value: number }[] = [];
  for (const row of rows) {
    if (row[seriesColumn] !== firstSeriesName) continue;
    series.push({ label: String(row[periodColumn]), value: Number(row[field]) });
  }
  return series;
}

const valuesOf = (templateId: string): number[] => trendSeriesOf(templateId).map((point) => point.value);
const median = (values: number[]): number => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;
const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
const quantile = (values: number[], q: number): number => [...values].sort((left, right) => left - right)[Math.floor(q * (values.length - 1))]!;
/** 孤立尖刺:越过 90 分位 1.3 倍且两邻期显著回落(双峰是平台/缓变,尖峰是 1-2 期孤点)。 */
const isolatedSpikes = (values: number[]): number[] =>
  values.filter((value, index) =>
    value > quantile(values, 0.9) * 1.3
    && (index === 0 || values[index - 1]! < value / 1.35)
    && (index === values.length - 1 || values[index + 1]! < value / 1.35));

describe("行业节律形状(波次 D)", () => {
  it("电力交易:负荷曲线早晚双峰、凌晨低谷,走 24 时刻轴", () => {
    const series = trendSeriesOf("power-trading");
    expect(series).toHaveLength(24);
    expect(series[0]!.label).toBe("00时");
    const values = series.map((point) => point.value);
    expect(Math.min(...values.slice(8, 11))).toBeGreaterThan(Math.max(...values.slice(13, 16)) * 1.15);
    expect(Math.min(...values.slice(18, 21))).toBeGreaterThan(Math.max(...values.slice(13, 16)) * 1.15);
    expect(Math.max(...values.slice(2, 5))).toBeLessThan(Math.min(...values.slice(8, 11)) * 0.6);
  });

  it("交通枢纽:早晚尖锐双峰,凌晨近停运", () => {
    const values = valuesOf("transport");
    expect(Math.min(...values.slice(8, 10))).toBeGreaterThan(Math.max(...values.slice(11, 16)) * 1.15);
    expect(Math.min(...values.slice(18, 20))).toBeGreaterThan(Math.max(...values.slice(11, 16)) * 1.15);
    expect(Math.max(...values.slice(2, 5))).toBeLessThan(Math.min(...values.slice(8, 10)) * 0.2);
  });

  it("水务:清晨峰与傍晚峰显著高于夜间低谷", () => {
    const values = valuesOf("water");
    expect(Math.min(...values.slice(6, 9))).toBeGreaterThan(Math.max(...values.slice(1, 5)) * 1.8);
    expect(Math.min(...values.slice(18, 21))).toBeGreaterThan(Math.max(...values.slice(1, 5)) * 1.8);
  });

  it("医院:工作日高、周末门诊低谷", () => {
    const values = valuesOf("healthcare");
    expect(trendSeriesOf("healthcare")).toHaveLength(7);
    expect(trendSeriesOf("healthcare")[5]!.label).toBe("周六");
    expect(mean(values.slice(5, 7))).toBeLessThan(mean(values.slice(0, 5)) * 0.65);
  });

  it("政务:周末闭厅(近零)", () => {
    const values = valuesOf("government");
    expect(Math.max(...values.slice(5, 7))).toBeLessThan(mean(values.slice(0, 5)) * 0.1);
  });

  it("金融:交易日历缺口,周末无交易(近零)", () => {
    const values = valuesOf("finance");
    expect(Math.max(...values.slice(5, 7))).toBeLessThan(mean(values.slice(0, 5)) * 0.05);
  });

  it("文旅:周末脉冲高于周中", () => {
    const values = valuesOf("tourism");
    expect(Math.min(...values.slice(5, 7))).toBeGreaterThan(mean(values.slice(1, 4)) * 1.25);
  });

  it("生产族(半导体):平稳运行 + 偶发停机凹坑(连续 2 期深坑)", () => {
    const values = valuesOf("semiconductor");
    const base = median(values);
    const dipStart = values.findIndex((value, index) =>
      value < base * 0.3 && values[index + 1] !== undefined && values[index + 1]! < base * 0.3);
    expect(dipStart).toBeGreaterThanOrEqual(0);
    const steady = values.filter((_, index) => index !== dipStart && index !== dipStart + 1);
    expect(Math.max(...steady) / Math.min(...steady)).toBeLessThan(1.75);
  });

  it("化工:连续稳态 + 计划检修台阶(连续 2 期降负荷)", () => {
    const values = valuesOf("petrochemical");
    const base = median(values);
    const stepStart = values.findIndex((value) => value < base * 0.75);
    expect(stepStart).toBeGreaterThanOrEqual(0);
    expect(values[stepStart + 1]!).toBeLessThan(base * 0.75);
    const steady = values.filter((_, index) => index !== stepStart && index !== stepStart + 1);
    expect(Math.max(...steady) / Math.min(...steady)).toBeLessThan(1.3);
  });

  it("农业:季节缓变(相邻月差小、峰谷差明显)", () => {
    const values = valuesOf("agriculture");
    const base = median(values);
    for (let index = 1; index < values.length; index++) {
      expect(Math.abs(values[index]! - values[index - 1]!)).toBeLessThan(base * 0.4);
    }
    expect(Math.max(...values) / Math.min(...values)).toBeGreaterThan(1.25);
  });

  it("冷链:夜间低温稳态低位、营业时段高频,并存在开门扰动尖峰", () => {
    const values = valuesOf("cold-chain");
    expect(mean(values.slice(0, 5))).toBeLessThan(mean(values.slice(9, 17)) * 0.15);
    expect(values.some((value, index) => index > 0 && value > values[index - 1]! * 1.4)).toBe(true);
  });

  it("会展:开幕日脉冲,峰值落在展期前段(30 天轴)", () => {
    const series = trendSeriesOf("expo");
    expect(series).toHaveLength(30);
    expect(series[0]!.label).toBe("第1天");
    const values = series.map((point) => point.value);
    const peakIndex = values.indexOf(Math.max(...values));
    expect(Math.max(...values)).toBeGreaterThan(median(values) * 2);
    expect(peakIndex).toBeLessThan(values.length / 3);
  });

  it("未收录的域回退通用月轴周期(12 期、期间列)", () => {
    expect(DOMAIN_RHYTHMS.operations).toBeUndefined();
    const series = trendSeriesOf("operations");
    expect(series).toHaveLength(12);
    expect(series[0]!.label).toBe("1月");
  });
});

describe("行业节律的工程约束(波次 D)", () => {
  it("profile 表完整性:各域 shape 长度与轴期数一致,系数与事件参数为正", () => {
    for (const [domainId, rhythm] of Object.entries(DOMAIN_RHYTHMS)) {
      expect(rhythm.shape, `${domainId} shape`).toHaveLength(RHYTHM_PERIOD_COUNTS[rhythm.axis]);
      expect(rhythm.shape.every((factor) => factor > 0), `${domainId} factors`).toBe(true);
      if (rhythm.event) {
        expect(rhythm.event.width, `${domainId} event width`).toBeLessThanOrEqual(rhythm.shape.length);
        expect(rhythm.event.factor, `${domainId} event factor`).toBeGreaterThan(0);
      }
    }
    expect(HOURLY_PERIODS).toHaveLength(24);
    expect(WEEKLY_PERIODS).toHaveLength(7);
    expect(DAILY_PERIODS).toHaveLength(30);
    expect(MONTH_PERIODS).toHaveLength(12);
  });

  it("节律域全部模板的行数不越契约上限;趋势类主图每期系列数一致", () => {
    // sankey/scatter/funnel 等主图无期间轴,系列一致性仅对趋势类(含 map 的趋势带回退)断言。
    const TREND_TYPES = new Set(["line", "area", "combo", "bar", "map"]);
    for (const domainId of Object.keys(DOMAIN_RHYTHMS)) {
      for (const template of DASHBOARD_TEMPLATES.filter((candidate) => candidate.domainId === domainId)) {
        for (const widget of dataWidgetsOf(template.id).filter((candidate) => candidate.key.includes(".primary."))) {
          expect(widget.sampleData!.rows.length, `${template.id} rows`).toBeLessThanOrEqual(100);
          if (!TREND_TYPES.has(widget.type)) continue;
          const dimensionField = widget.analysis!.dimensionField!;
          const seriesField = widget.analysis!.seriesField!;
          const perPeriod = new Map<string, Set<unknown>>();
          for (const row of widget.sampleData!.rows) {
            const key = String(row[dimensionField]);
            const bucket = perPeriod.get(key) ?? new Set<unknown>();
            bucket.add(row[seriesField]);
            perPeriod.set(key, bucket);
          }
          expect(new Set([...perPeriod.values()].map((series) => series.size)).size, `${template.id} series`)
            .toBe(1);
        }
      }
    }
  });

  it("节律域趋势确定性复现(同 id 两次生成逐字节一致)", () => {
    for (const templateId of ["power-trading", "expo", "finance"]) {
      const first = dataWidgetsOf(templateId).map(rowsWithoutSource);
      const second = dataWidgetsOf(templateId).map(rowsWithoutSource);
      expect(second).toEqual(first);
    }
  });

  it("告警语义趋势(risk 视角)保证 1-2 个越限尖刺,且与停机/检修事件不重叠", () => {
    for (const domainId of ["power-trading", "semiconductor", "water"]) {
      const values = valuesOf(`${domainId}-risk`);
      const spikes = isolatedSpikes(values);
      expect(spikes.length, `${domainId}-risk 越限尖刺数`).toBeGreaterThanOrEqual(1);
      expect(spikes.length, `${domainId}-risk 越限尖刺数`).toBeLessThanOrEqual(2);
      // 停机/检修类事件域:越限尖刺与深坑不同期(候选池排除事件窗口的构造保证)。
      if (domainId === "semiconductor") {
        const base = median(values);
        const dipIndexes = values.map((value, index) => (value < base * 0.3 ? index : -1)).filter((index) => index >= 0);
        const spikeIndexes = values.map((value, index) => (spikes.includes(value) ? index : -1)).filter((index) => index >= 0);
        for (const dip of dipIndexes) expect(spikeIndexes).not.toContain(dip);
      }
    }
  });

  it("非告警语义趋势不出现概率尖刺(双峰是平台,不是孤点)", () => {
    for (const templateId of ["power-trading", "water", "operations"]) {
      expect(isolatedSpikes(valuesOf(templateId)), `${templateId} 无尖刺`).toHaveLength(0);
    }
  });
});
