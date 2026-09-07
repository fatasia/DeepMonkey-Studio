import type { DashboardAggregation, DashboardDataWidgetConfig, SemanticModelRecord } from "@bim-studio/contracts";

export type SemanticBinding = NonNullable<DashboardDataWidgetConfig["semanticBinding"]>;
export const semanticParameterKey = (modelId: string, key: string) => `semantic.${modelId}.parameter.${key}`;
export const semanticSelectionKey = (widget: DashboardDataWidgetConfig) => `semantic.selection.${widget.key}`;
export const isSemanticSelectionWidget = (widget: DashboardDataWidgetConfig) => ["bar", "line", "area", "combo", "pie"].includes(widget.type);
export const supportsSemanticWidget = (widget: DashboardDataWidgetConfig) => isSemanticSelectionWidget(widget) || ["value", "digital-flip", "progress", "status", "gauge", "liquid-fill", "table", "scroll-table", "filter"].includes(widget.type);
const aggregations: Record<string, DashboardAggregation> = { count: "count", countDistinct: "distinct-count", sum: "sum", avg: "average", min: "minimum", max: "maximum" };

export function resolveSemanticWidget(widget: DashboardDataWidgetConfig, models: readonly SemanticModelRecord[]) {
  const binding = widget.semanticBinding;
  if (!binding) return { widget };
  if (!supportsSemanticWidget(widget)) return { widget, error: "此组件尚未支持语义绑定，请改用基础图表、指标、表格或参数组件。" };
  const model = models.find((item) => item.id === binding.modelId);
  if (!model) return { widget, error: "语义模型不存在，请重新选择模型。" };
  if (model.revision !== binding.revision) return { widget, error: `语义口径已更新（v${binding.revision} → v${model.revision}），请在数据面板重新确认。` };
  const metric = model.metrics.find((item) => item.key === binding.metricKey);
  const dimension = model.dimensions.find((item) => item.key === binding.dimensionKey);
  const parameter = model.parameters.find((item) => item.key === binding.parameterKey);
  if (binding.metricKey && !metric || binding.dimensionKey && !dimension || binding.parameterKey && !parameter) return { widget, error: "引用的指标、维度或参数已删除，请重新绑定。" };
  if (widget.type === "filter" ? !parameter : !metric) return { widget, error: widget.type === "filter" ? "请选择语义参数。" : "请选择语义指标。" };
  const next = structuredClone(widget);
  delete next.datasetId;
  delete next.pipelineId;
  delete next.directBinding;
  delete next.sampleData;
  if (model.source.kind === "dataset") next.datasetId = model.source.id;
  else next.pipelineId = model.source.id;
  if (metric) {
    next.field = metric.fieldKey || "__semantic_value";
    next.unit = metric.unit ?? "";
    next.analysis = {
      aggregation: aggregations[metric.aggregation]!, measureField: next.field,
      ...(dimension ? { dimensionField: dimension.fieldKey, drillFields: dimension.hierarchy?.map((level) => level.fieldKey) ?? [dimension.fieldKey] } : {}),
    };
    if (next.report && next.report.mode !== "detail") next.report = {
      ...next.report, aggregation: next.analysis.aggregation, valueField: next.field, valueFields: [next.field],
      ...(dimension ? { rowField: dimension.fieldKey } : {}),
    };
  }
  if (parameter) {
    next.key = semanticParameterKey(model.id, parameter.key);
    const source = parameter.optionsSource;
    const optionDimension = source?.kind === "dimension" ? model.dimensions.find((item) => item.key === source.dimensionKey) : undefined;
    if (parameter.optionsSource?.kind === "dimension" && !optionDimension) return { widget, error: "参数选项引用的维度不存在。" };
    next.filterField = optionDimension?.fieldKey ?? parameter.key;
    next.filterMode = parameter.type === "text" ? "text" : parameter.type === "datetime" ? "date" : "select";
    delete next.parentFilterKey;
    if (parameter.parentKey) next.parentFilterKey = semanticParameterKey(model.id, parameter.parentKey);
  }
  return { widget: next, model, metric, parameter };
}

/** 绑定作为单条作者命令；运行配置每次由已确认版本解析，不持久化计算结果。 */
export function bindSemanticWidget(widget: DashboardDataWidgetConfig, nodeId: string, model: SemanticModelRecord, patch: Partial<SemanticBinding> = {}): DashboardDataWidgetConfig {
  const previous = widget.semanticBinding?.modelId === model.id ? widget.semanticBinding : undefined;
  const semanticBinding: SemanticBinding = {
    modelId: model.id, revision: model.revision, autoLink: previous?.autoLink ?? true,
    ...(widget.type === "filter" ? { parameterKey: previous?.parameterKey ?? model.parameters[0]?.key ?? "" } : {
      metricKey: previous?.metricKey ?? model.metrics[0]?.key ?? "",
      dimensionKey: previous?.dimensionKey ?? (isSemanticSelectionWidget(widget) ? model.dimensions[0]?.key ?? "" : ""),
    }), ...patch,
  };
  const next = { ...widget, key: `semantic.${model.id}.widget.${nodeId}`, semanticBinding };
  return resolveSemanticWidget(next, [model]).widget;
}
