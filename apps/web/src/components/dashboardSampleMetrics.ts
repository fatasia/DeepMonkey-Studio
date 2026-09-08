import type { DashboardDataWidgetConfig, DashboardSampleData, DataDatasetField, WidgetNode } from "@bim-studio/contracts";
import { aggregate } from "./dashboardAnalytics";
import type { DashboardMetric } from "./DashboardWidgetRuntime";

export function dashboardSampleFields(sample: DashboardSampleData | undefined): DataDatasetField[] {
  if (sample?.columns) return sample.columns.map(column => ({ ...column, label: column.key }));
  const rows = sample?.rows ?? [];
  const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
  return keys.map(key => {
    const values = rows.map(row => row[key]).filter(value => value !== null && value !== undefined);
    return { key, label: key, type: values.length && values.every(value => typeof value === "number") ? "number" : values.length && values.every(value => typeof value === "boolean") ? "boolean" : "string" };
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
  const packFilters = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind === "data-widget" && node.widget.type === "filter"
      && nodes.some(item => item.kind === "data-widget" && item.widget.sampleData?.sourceId?.startsWith(`${node.widget.key}:page:`))) {
      packFilters.set(node.widget.key, `sample-pack:${crypto.randomUUID()}:filter`);
    }
  }
  for (const node of nodes) {
    const source = node.kind === "data-widget" ? node.widget.sampleData?.sourceId : undefined;
    const filter = source && [...packFilters.keys()].find(key => source.startsWith(`${key}:page:`));
    if (source && !sources.has(source)) sources.set(source, filter ? `${packFilters.get(filter)}:page:${crypto.randomUUID()}` : `sample:${crypto.randomUUID()}`);
  }
  return nodes.map(node => {
    if (node.kind !== "data-widget") return node;
    const source = node.widget.sampleData?.sourceId;
    if (!node.widget.sampleData) {
      if (packFilters.has(node.widget.key)) return { ...node, widget: { ...node.widget, key: packFilters.get(node.widget.key)! } };
      const filterSource = [...sources.keys()].find(id => node.widget.type === "filter" && node.widget.key.startsWith(`${id}:`));
      return filterSource ? { ...node, widget: { ...node.widget, key: `${sources.get(filterSource)}:${node.id}` } } : node;
    }
    return { ...node, widget: { ...node.widget, key: `${source ? sources.get(source) : "sample"}:${node.id}`,
      sampleData: { ...structuredClone(node.widget.sampleData), ...(source ? { sourceId: sources.get(source)! } : {}) } } };
  });
}

export function dashboardSampleFilterWidgets(widget: DashboardDataWidgetConfig, widgets: readonly DashboardDataWidgetConfig[]): DashboardDataWidgetConfig[] {
  const sources = [...new Set(widgets.flatMap(item => item.sampleData?.sourceId ? [item.sampleData.sourceId] : []))];
  return widgets.filter(item => item.type === "filter"
    && !sources.some(source => source !== widget.sampleData?.sourceId && item.key.startsWith(`${source}:`))
    && (!sources.some(source => source.startsWith(`${item.key}:page:`)) || Boolean(widget.sampleData?.sourceId?.startsWith(`${item.key}:page:`))));
}
