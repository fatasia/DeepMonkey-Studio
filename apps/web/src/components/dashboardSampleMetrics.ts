import type { DashboardDataWidgetConfig, DashboardSampleData, DataDatasetField, WidgetNode } from "@bim-studio/contracts";
import { aggregate } from "./dashboardAnalytics";
import type { DashboardMetric } from "./DashboardWidgetRuntime";

export function dashboardSampleFields(sample: DashboardSampleData | undefined): DataDatasetField[] {
  const rows = sample?.rows ?? [];
  const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
  return keys.map(key => {
    const values = rows.map(row => row[key]).filter(value => value !== null && value !== undefined);
    return { key, label: key, type: values.length && values.every(value => typeof value === "number") ? "number" : "string" };
  });
}

export function buildDashboardSampleMetric(widget: DashboardDataWidgetConfig, rows: DashboardSampleData["rows"]): DashboardMetric {
  const field = widget.analysis?.measureField ?? widget.field;
  const values = field ? rows.map(row => row[field]) : [];
  const mode = widget.analysis?.aggregation ?? "none";
  const value = mode === "none" ? values[0] : rows.length ? aggregate(values, mode) : undefined;
  return { value, rows, samples: values.flatMap((item, index) => typeof item === "number" ? [{ time: index, value: item }] : []) };
}

export function withDashboardSampleData(widget: DashboardDataWidgetConfig): DashboardDataWidgetConfig {
  const next = structuredClone(widget);
  delete next.datasetId;
  delete next.pipelineId;
  delete next.directBinding;
  delete next.semanticBinding;
  const field = next.analysis?.measureField || next.field || "value";
  const dimension = next.analysis?.dimensionField || "category";
  next.field = field;
  next.sampleData = { rows: [{ [dimension]: "A", [field]: 40 }, { [dimension]: "B", [field]: 60 }] };
  next.analysis = { aggregation: "none", ...next.analysis, measureField: field };
  if (!["value", "digital-flip", "progress", "status", "gauge", "liquid-fill"].includes(next.type)) next.analysis.dimensionField = dimension;
  return next;
}

/** 复制命令保留副本内部共享关系，但不继续订阅原件的示例快照或指标键。 */
export function isolateCopiedDashboardSamples(nodes: WidgetNode[]): WidgetNode[] {
  const sources = new Map<string, string>();
  for (const node of nodes) {
    const source = node.kind === "data-widget" ? node.widget.sampleData?.sourceId : undefined;
    if (source && !sources.has(source)) sources.set(source, `sample:${crypto.randomUUID()}`);
  }
  return nodes.map(node => {
    if (node.kind !== "data-widget") return node;
    const source = node.widget.sampleData?.sourceId;
    if (!node.widget.sampleData) return node;
    return { ...node, widget: { ...node.widget, key: `sample:${node.id}`,
      sampleData: { ...structuredClone(node.widget.sampleData), ...(source ? { sourceId: sources.get(source)! } : {}) } } };
  });
}
