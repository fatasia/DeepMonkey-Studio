import type { DashboardDataWidgetConfig, DataDatasetField } from "@bim-studio/contracts";

export const DASHBOARD_FIELD_MIME = "application/x-bim-data-field";
export type FieldRole = "dimension" | "measure" | "series";
export interface DashboardFieldProduct {
  key: string;
  name: string;
  fields: DataDatasetField[];
  status: "idle" | "loading" | "ready" | "error";
  error?: string | undefined;
}
export interface DashboardFieldDrag {
  productKey: string;
  fieldKey: string;
  fieldType: DataDatasetField["type"];
  label: string;
  unit?: string | undefined;
}

const chartTypes = new Set(["line", "area", "bar", "combo", "pie", "scatter", "radar", "funnel", "sankey", "sunburst", "treemap", "graph", "rank"]);
const metricTypes = new Set(["value", "gauge", "digital-flip", "liquid-fill", "progress"]);
export function dashboardFieldRoles(type: DashboardDataWidgetConfig["type"]): FieldRole[] {
  return chartTypes.has(type) ? ["dimension", "measure", "series"] : metricTypes.has(type) ? ["measure"] : [];
}
export function fieldMatchesRole(field: DataDatasetField, role: FieldRole) {
  return role === "measure" ? field.type === "number" : role === "series" ? field.type === "string" : field.type === "string" || field.type === "datetime";
}
export function widgetFieldProduct(widget: DashboardDataWidgetConfig) {
  return widget.pipelineId ? `pipeline:${widget.pipelineId}` : widget.datasetId ? `dataset:${widget.datasetId}` : "";
}
export function widgetRoleField(widget: DashboardDataWidgetConfig, role: FieldRole) {
  return role === "measure" ? widget.analysis?.measureField ?? widget.field : role === "dimension" ? widget.analysis?.dimensionField : widget.analysis?.seriesField;
}
export function readDashboardFieldDrag(value: string): DashboardFieldDrag | undefined {
  if (value.length > 10_000) return;
  try {
    const data: unknown = JSON.parse(value);
    if (!data || typeof data !== "object") return;
    const field = data as Record<string, unknown>;
    if (typeof field.productKey !== "string" || !/^(dataset|pipeline):.+$/.test(field.productKey) || typeof field.fieldKey !== "string" || !field.fieldKey) return;
    // 类型、名称与单位只作拖动展示；写入时必须重新使用当前项目的权威目录。
    return { productKey: field.productKey, fieldKey: field.fieldKey, fieldType: "json", label: field.fieldKey };
  } catch { return; }
}

export function bindDashboardField(widget: DashboardDataWidgetConfig, role: FieldRole, product: DashboardFieldProduct, fieldKey: string): DashboardDataWidgetConfig | undefined {
  const field = product.fields.find((candidate) => candidate.key === fieldKey);
  if (product.status !== "ready" || !/^(dataset|pipeline):.+$/.test(product.key) || !dashboardFieldRoles(widget.type).includes(role) || !field || !fieldMatchesRole(field, role)) return;
  const next = structuredClone(widget);
  const productChanged = widgetFieldProduct(widget) !== product.key;
  const analysis = { aggregation: "none" as const, ...next.analysis };
  if (productChanged) {
    delete next.directBinding;
    delete next.pipelineId;
    delete next.datasetId;
    const [kind, ...parts] = product.key.split(":");
    if (kind === "dataset") next.datasetId = parts.join(":");
    else next.pipelineId = parts.join(":");
    for (const candidate of ["dimension", "measure", "series"] as const) {
      const key = widgetRoleField(widget, candidate);
      if (!product.fields.some((item) => item.key === key && fieldMatchesRole(item, candidate))) {
        if (candidate === "dimension") delete analysis.dimensionField;
        if (candidate === "series") delete analysis.seriesField;
        if (candidate === "measure") { delete analysis.measureField; delete next.field; next.key = ""; }
      }
    }
    if (analysis.drillFields) analysis.drillFields = analysis.drillFields.filter((key) => product.fields.some((item) => item.key === key && fieldMatchesRole(item, "dimension")));
  }
  if (role === "dimension") analysis.dimensionField = field.key;
  if (role === "series") analysis.seriesField = field.key;
  if (role === "measure") {
    next.field = field.key;
    if (chartTypes.has(widget.type) || widget.analysis) analysis.measureField = field.key;
    if (!next.unit || productChanged) next.unit = field.unit ?? "";
  }
  if (chartTypes.has(widget.type) || widget.analysis) next.analysis = analysis;
  const measure = next.analysis?.measureField ?? next.field;
  next.key = measure ? `${next.pipelineId ?? next.datasetId}.${measure}` : "";
  return next;
}

export function unbindDashboardField(widget: DashboardDataWidgetConfig, role: FieldRole): DashboardDataWidgetConfig {
  const next = structuredClone(widget);
  if (role === "dimension" && next.analysis) delete next.analysis.dimensionField;
  if (role === "series" && next.analysis) delete next.analysis.seriesField;
  if (role === "measure") {
    if (next.analysis) delete next.analysis.measureField;
    delete next.field;
    next.key = ""; // 不留下旧 key 让看似解绑的组件继续订阅旧指标。
  }
  return next;
}
