import type { EChartsCoreOption } from "echarts/core";
import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import type { DashboardAnalysisResult } from "./dashboardAnalytics";
import { readPath } from "./dashboardAnalytics";
import { dashboardColorWithOpacity as colorWithOpacity } from "./dashboardWidgetValues";
import type { DashboardChartPalette } from "./dashboardReadableChartOptions";

/**
 * 词云/箱线/瀑布/极坐标四类图表的 ECharts options 构造(纯函数,无 DOM 依赖)。
 * 色板一律来自 readDashboardChartPalette 的主题令牌,深浅主题自动一致;
 * 字号跟随组件设计字号,未设置时回退默认轴标签字号。
 */
const DEFAULT_LABEL_FONT_SIZE = 10;

/** Tukey 五数概括 [min, Q1, 中位数, Q3, max],分位数用线性插值,空集返回 undefined。 */
export function dashboardBoxplotSummary(values: readonly number[]): [number, number, number, number, number] | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const quantile = (p: number) => {
    const position = (sorted.length - 1) * p;
    const base = Math.floor(position);
    const next = sorted[base + 1];
    return next === undefined ? sorted[base]! : sorted[base]! + (position - base) * (next - sorted[base]!);
  };
  return [sorted[0]!, quantile(0.25), quantile(0.5), quantile(0.75), sorted[sorted.length - 1]!];
}

export function dashboardAdvancedChartOption(
  widget: DashboardDataWidgetConfig,
  analysis: DashboardAnalysisResult,
  palette: DashboardChartPalette,
  compact: boolean,
): EChartsCoreOption | undefined {
  switch (widget.type) {
    case "wordcloud": return wordCloudOption(widget, analysis, palette, compact);
    case "boxplot": return boxplotOption(widget, analysis, palette, compact);
    case "waterfall": return waterfallOption(widget, analysis, palette, compact);
    case "polarBar": return polarBarOption(widget, analysis, palette, compact);
    default: return undefined;
  }
}

function labelFontSize(widget: DashboardDataWidgetConfig): number {
  return widget.fontSize && Number.isFinite(widget.fontSize) ? widget.fontSize : DEFAULT_LABEL_FONT_SIZE;
}

/** 词云:字号映射权重由插件的 sizeRange 承担,颜色逐词取 accent 族,避免深色主题下默认黑字不可见。 */
function wordCloudOption(widget: DashboardDataWidgetConfig, analysis: DashboardAnalysisResult, palette: DashboardChartPalette, compact: boolean): EChartsCoreOption {
  const fontSize = labelFontSize(widget);
  const values = analysis.series[0]?.values ?? [];
  const words = analysis.categories
    .map((name, index) => ({ name, value: Number(values[index]) || 0 }))
    .filter((word) => word.name.trim() && word.value > 0);
  const colors = [palette.accent, ...palette.series];
  return {
    animation: !compact,
    tooltip: { trigger: "item", backgroundColor: palette.surface, borderColor: palette.line, textStyle: { color: palette.text, fontSize } },
    series: [
      {
        // 插件注册名是驼峰 series.wordCloud,ECharts 6 下必须用官方拼写,小写会被判为未知系列
        type: "wordCloud",
        shape: "circle",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        sizeRange: [fontSize, Math.round(fontSize * 3.4)],
        rotationRange: [-30, 30],
        rotationStep: 15,
        gridSize: Math.max(2, Math.round(fontSize / 4)),
        drawOutOfBound: false,
        shrinkToFit: true,
        textStyle: { fontWeight: 600 },
        data: words.map((word, index) => ({ ...word, textStyle: { color: colors[index % colors.length] } })),
      },
    ],
  };
}

/**
 * 箱线图:按维度聚合原始行数据的分布并画五数概括箱体。
 * 箱线的业务语义是"分布对比",seriesField 若被配置也并入同类目分布(单系列构图)。
 */
function boxplotOption(widget: DashboardDataWidgetConfig, analysis: DashboardAnalysisResult, palette: DashboardChartPalette, compact: boolean): EChartsCoreOption {
  const fontSize = labelFontSize(widget);
  const dimension = widget.analysis?.dimensionField;
  const measure = widget.analysis?.measureField ?? widget.field ?? "value";
  const buckets = new Map<string, number[]>();
  for (const row of analysis.rows) {
    const value = Number(readPath(row, measure));
    if (!Number.isFinite(value)) continue;
    const category = String((dimension && readPath(row, dimension)) ?? "全部");
    const bucket = buckets.get(category);
    if (bucket) bucket.push(value);
    else buckets.set(category, [value]);
  }
  const categories = [...buckets.keys()];
  const data = categories.map((category) => dashboardBoxplotSummary(buckets.get(category)!));
  return {
    animation: !compact,
    grid: { top: fontSize * 1.2, right: fontSize, bottom: fontSize * 0.8, left: fontSize * 0.5, containLabel: true },
    tooltip: { trigger: "item", backgroundColor: palette.surface, borderColor: palette.line, textStyle: { color: palette.text, fontSize } },
    xAxis: { type: "category", data: categories, axisLabel: { color: palette.muted, fontSize, hideOverlap: true }, axisTick: { show: false }, axisLine: { lineStyle: { color: palette.line } } },
    yAxis: { type: "value", scale: true, axisLabel: { color: palette.muted, fontSize }, splitLine: { lineStyle: { color: palette.line } } },
    series: [
      {
        name: widget.title,
        type: "boxplot",
        data,
        itemStyle: { color: colorWithOpacity(palette.accent, 0.32), borderColor: palette.accent, borderWidth: 1.5 },
      },
    ],
  };
}

/**
 * 瀑布图:首项为基期量(从 0 满柱),其后每项为期变化量;
 * 用透明占位柱托起浮动柱,升降色取主题语义令牌(升红降绿)。
 */
function waterfallOption(widget: DashboardDataWidgetConfig, analysis: DashboardAnalysisResult, palette: DashboardChartPalette, compact: boolean): EChartsCoreOption {
  const fontSize = labelFontSize(widget);
  const changes = (analysis.series[0]?.values ?? []).map((value) => Number(value) || 0);
  const bases: number[] = [];
  const bars: Array<{ value: number; itemStyle: { color: string } }> = [];
  let running = 0;
  changes.forEach((change, index) => {
    if (index === 0) {
      bases.push(0);
      bars.push({ value: change, itemStyle: { color: palette.accent } });
      running = change;
      return;
    }
    const next = running + change;
    bases.push(Math.min(running, next));
    bars.push({ value: Math.abs(change), itemStyle: { color: change >= 0 ? palette.rise ?? palette.accent : palette.fall ?? palette.accent } });
    running = next;
  });
  return {
    animation: !compact,
    grid: { top: fontSize * 1.2, right: fontSize, bottom: fontSize * 0.8, left: fontSize * 0.5, containLabel: true },
    tooltip: { trigger: "axis", backgroundColor: palette.surface, borderColor: palette.line, textStyle: { color: palette.text, fontSize } },
    xAxis: { type: "category", data: analysis.categories, axisLabel: { color: palette.muted, fontSize, hideOverlap: true }, axisTick: { show: false }, axisLine: { lineStyle: { color: palette.line } } },
    yAxis: { type: "value", scale: true, axisLabel: { color: palette.muted, fontSize }, splitLine: { lineStyle: { color: palette.line } } },
    series: [
      // 占位柱透明且不响应交互,只负责把变化量顶到累计高度
      { name: "占位", type: "bar", stack: "waterfall", silent: true, itemStyle: { color: "transparent" }, emphasis: { itemStyle: { color: "transparent" } }, data: bases },
      { name: widget.title, type: "bar", stack: "waterfall", barMaxWidth: 26, data: bars },
    ],
  };
}

/** 极坐标柱:类目环布角度轴,多系列在极坐标下按原生能力堆叠成环(并排分组非极坐标语义)。 */
function polarBarOption(widget: DashboardDataWidgetConfig, analysis: DashboardAnalysisResult, palette: DashboardChartPalette, compact: boolean): EChartsCoreOption {
  const fontSize = labelFontSize(widget);
  const seriesValues = analysis.series.length ? analysis.series : [{ name: widget.title, values: analysis.categories.map(() => 0) }];
  const showLegend = widget.chart?.showLegend ?? seriesValues.length > 1;
  return {
    animation: !compact,
    color: [palette.accent, ...palette.series],
    legend: showLegend
      ? { bottom: 0, left: "center", textStyle: { color: palette.text, fontSize }, itemWidth: fontSize, itemHeight: fontSize * 0.55 }
      : undefined,
    polar: { radius: ["14%", showLegend ? "66%" : "78%"] },
    tooltip: { trigger: "item", backgroundColor: palette.surface, borderColor: palette.line, textStyle: { color: palette.text, fontSize } },
    angleAxis: { type: "category", data: analysis.categories, startAngle: 90, axisLine: { lineStyle: { color: palette.line } }, axisLabel: { color: palette.muted, fontSize, hideOverlap: true } },
    radiusAxis: { type: "value", axisLabel: { color: palette.muted, fontSize: Math.max(8, fontSize - 2) }, splitLine: { lineStyle: { color: palette.line } } },
    series: seriesValues.map((item) => ({
      name: item.name,
      type: "bar",
      coordinateSystem: "polar",
      stack: "total",
      data: item.values,
      barMaxWidth: 18,
    })),
  };
}
