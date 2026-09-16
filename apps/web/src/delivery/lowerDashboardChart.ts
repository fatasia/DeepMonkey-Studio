import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { compileChartSpec, type ChartIR, type ChartSpec } from "@bim-studio/deep-engine";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { validateFrozenDashboardMetric } from "./dashboardDataValidation";
import { analyzeDashboardMetric } from "../components/dashboardAnalytics";
import type { DashboardFrozenData } from "./dashboardDataRasterTypes";

export interface DashboardChartDiagnostic {
  readonly path: string;
  readonly message: string;
}
export interface DashboardChartLowering {
  /** 数据语义转换不等于 Web 图表外观、布局和交互已交付。 */
  readonly status: "blocked" | "degraded";
  readonly chart?: { readonly id: string; readonly revision: number; readonly value: ChartIR };
  readonly sourceSha256?: string;
  readonly diagnostics: readonly DashboardChartDiagnostic[];
}
export type DashboardChartFrozenData = Pick<DashboardFrozenData, "source" | "metric">;

/** 纯作者数据转换；不执行查询、刷新、筛选或注入演示数据。 */
export function lowerDashboardChart(input: {
  readonly nodeId: string;
  readonly revision: number;
  readonly widget: DashboardDataWidgetConfig;
  readonly data?: DashboardChartFrozenData;
}): DashboardChartLowering {
  const diagnostics: DashboardChartDiagnostic[] = [];
  const blocked = (): DashboardChartLowering => ({ status: "blocked", diagnostics });
  const reject = (path: string, message: string): void => { diagnostics.push({ path, message }); };
  const { widget, data } = input;
  if (!input.nodeId || !Number.isSafeInteger(input.revision) || input.revision < 1)
    reject("node", "图表必须绑定有效作者节点与 revision");
  if (!["bar", "line", "scatter", "pie"].includes(widget.type))
    reject("widget.type", "该作者图表类型尚无等价 ChartIR lowering");
  if (widget.semanticBinding) reject("widget.semanticBinding", "语义绑定尚需明确的解析后作者配置快照");
  if (widget.analysis?.drillFields?.length) reject("widget.analysis.drillFields", "钻取状态尚未编译");
  if (widget.chart?.stacked) reject("widget.chart.stacked", "ChartIR 尚未表达堆叠");
  if (widget.chart?.showDataLabels) reject("widget.chart.showDataLabels", "ChartIR 尚未表达数据标签");
  if (widget.chart?.secondaryAxisSeries?.length) reject("widget.chart.secondaryAxisSeries", "作者双轴映射尚未编译");
  for (const key of Object.keys(widget.chart ?? {})) {
    if (!["stacked", "showDataLabels", "showLegend", "secondaryAxisSeries"].includes(key))
      reject(`widget.chart.${key}`, "未知作者图表配置");
  }
  for (const key of Object.keys(widget.analysis ?? {})) {
    if (!["dimensionField", "drillFields", "seriesField", "measureField", "aggregation", "calculatedFields", "sort", "limit"].includes(key))
      reject(`widget.analysis.${key}`, "未知作者分析配置");
  }
  if (!data) { reject("data", "缺少明确冻结的数据快照"); return blocked(); }
  try { validateFrozenDashboardMetric(data); }
  catch (error) { reject("data", error instanceof Error ? error.message : "Invalid frozen metric"); }
  if (diagnostics.length) return blocked();
  const metric = { value: data.metric.value, samples: data.metric.samples.map(sample => ({ ...sample })),
    ...(data.metric.rows ? { rows: data.metric.rows.map(row => ({ ...row })) } : {}) };
  const analysis = analyzeDashboardMetric(widget, metric);
  const id = `chart.${runtimeContentSha256(input.nodeId)}`;
  const datasets: ChartSpec["datasets"][number][] = [];
  const series: ChartSpec["series"][number][] = [];
  let categories = analysis.categories.length ? analysis.categories : metric.samples.map((_, index) => String(index + 1));
  let values = analysis.series.length ? analysis.series : [{ name: widget.title, values: metric.samples.map(sample => sample.value) }];
  if (widget.type === "scatter") {
    categories = metric.samples.map((_, index) => String(index));
    values = [{ name: widget.title, values: metric.samples.map(sample => sample.value) }];
  }
  if (!categories.length || !values.length) {
    reject("data.metric", "冻结快照没有可绘制图表数据"); return blocked();
  }
  // Web 两条饼图路径对超过 20 类的截取不同；不擅自修正或丢弃作者数据。
  if (widget.type === "pie" && categories.length > 20) {
    reject("data.metric", "超过 20 类的饼图需先统一 Web 截取语义"); return blocked();
  }
  const selected = widget.type === "pie" ? values.slice(0, 1) : values;
  selected.forEach((item, index) => {
    const datasetId = `data.${index}`;
    datasets.push({ id: datasetId, dimensions: ["category", "value"],
      rows: categories.map((category, row) => [widget.type === "scatter" ? row : category, item.values[row]!]) });
    series.push(widget.type === "pie"
      ? { id: `series.${index}`, label: item.name, type: "pie", datasetId, name: "category", value: "value" }
      : { id: `series.${index}`, label: item.name, type: widget.type as "line" | "bar" | "scatter",
        datasetId, x: "category", y: "value", xAxisId: "axis.x", yAxisId: "axis.y" });
  });
  const readable = Boolean(widget.fontSize && Number.isFinite(widget.fontSize));
  const showLegend = widget.type === "scatter" ? false
    : widget.type === "pie" && !readable ? false : widget.chart?.showLegend ?? widget.type === "pie";
  const compiled = compileChartSpec({ schemaVersion: 1, id, datasets, series,
    axes: widget.type === "pie" ? [] : [
      { id: "axis.x", channel: "x", scale: widget.type === "scatter" ? "linear" : "category" },
      { id: "axis.y", channel: "y", scale: "linear" }],
    legend: { visible: showLegend, position: readable ? "bottom" : "top" },
    tooltip: { enabled: true, trigger: widget.type === "pie" || widget.type === "scatter" ? "item" : "axis" },
  });
  if (!compiled.ok || !compiled.ir) {
    compiled.diagnostics.forEach(item => reject(item.path, item.message)); return blocked();
  }
  reject("presentation", "Web 字体、配色、网格、平滑曲线及饼环外观仍需呈现合同和像素验收");
  reject("interaction", "作者点击联动、筛选和动画尚未编译");
  // 逐字段报告，不能因得到 IR 就将作者未知属性标记为已编译。
  for (const key of Object.keys(widget)) {
    if (!["type", "title", "key", "analysis", "chart", "datasetId", "pipelineId", "directBinding", "sampleData", "field", "semanticBinding"].includes(key))
      reject(`widget.${key}`, "此属性未进入图表数据 IR，须由呈现或宿主编译器处理");
  }
  return { status: "degraded", chart: { id, revision: input.revision, value: compiled.ir },
    sourceSha256: runtimeContentSha256({ nodeId: input.nodeId, revision: input.revision, widget, data }), diagnostics };
}
