import type { DashboardDataWidgetConfig, DataDatasetField, JsonValue, SemanticMetricFilter, SemanticModelRecord } from "@bim-studio/contracts";
import { compileFormula, evaluateFormula } from "@bim-studio/data-runtime";
import { aggregate } from "./dashboardAnalytics";
import type { DashboardMetric } from "./DashboardWidgetRuntime";
import { isSemanticSelectionWidget, resolveSemanticWidget, semanticParameterKey, semanticSelectionKey } from "./dashboardSemanticBinding";

function read(row: Record<string, unknown>, key: string): unknown {
  if (key in row) return row[key];
  return key.split(".").reduce<unknown>((value, part) => value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined, row);
}
function equal(left: unknown, right: unknown) { return left === right || left !== null && left !== undefined && right !== null && right !== undefined && String(left) === String(right); }
const active = (value: unknown) => value !== undefined && value !== null && value !== "" && !/^(全部|all)$/i.test(String(value));
function matches(row: Record<string, unknown>, filter: SemanticMetricFilter) {
  const value = read(row, filter.fieldKey);
  if (filter.op === "eq") return equal(value, filter.value);
  if (filter.op === "neq") return !equal(value, filter.value);
  if (filter.op === "in") return Array.isArray(filter.value) && filter.value.some((item) => equal(value, item));
  if (filter.op === "contains") return String(value ?? "").includes(String(filter.value));
  if (value === null || value === undefined || value === "") return false;
  const left = Number(value), right = Number(filter.value);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return filter.op === "gt" ? left > right : filter.op === "gte" ? left >= right : filter.op === "lt" ? left < right : left <= right;
}

/** 同模型隔离、同源组件取自己的结果；默认口径过滤与多组件条件均为 AND。 */
export function semanticRows(rows: Record<string, unknown>[], target: DashboardDataWidgetConfig, widgets: readonly DashboardDataWidgetConfig[], model: SemanticModelRecord, filters: Readonly<Record<string, JsonValue>>) {
  return rows.filter((row) => widgets.every((source) => {
    if (source.semanticBinding?.modelId !== model.id || source.semanticBinding.revision !== model.revision || source.key === target.key) return true;
    if (source.type === "filter") {
      const resolved = resolveSemanticWidget(source, [model]);
      if (!resolved.parameter || resolved.error) return true;
      const key = semanticParameterKey(model.id, resolved.parameter.key);
      const value = filters[key];
      if (!active(value) || resolved.widget.parentFilterKey && !active(filters[resolved.widget.parentFilterKey])) return true;
      const candidate = read(row, resolved.widget.filterField!);
      return Array.isArray(value) ? value.some((item) => equal(candidate, item)) : resolved.widget.filterMode === "text" ? String(candidate ?? "").toLowerCase().includes(String(value).toLowerCase()) : equal(candidate, value);
    }
    if (target.semanticBinding?.autoLink === false || source.semanticBinding.autoLink === false || !isSemanticSelectionWidget(source)) return true;
    const selection = filters[semanticSelectionKey(source)];
    if (!selection || typeof selection !== "object" || Array.isArray(selection) || typeof selection.field !== "string") return true;
    const dimension = model.dimensions.find((item) => item.key === source.semanticBinding?.dimensionKey);
    if (![dimension?.fieldKey, ...(dimension?.hierarchy?.map((level) => level.fieldKey) ?? [])].includes(selection.field)) return true;
    const conditions = Array.isArray(selection.path) ? selection.path : [selection];
    const allowed = [dimension?.fieldKey, ...(dimension?.hierarchy?.map((level) => level.fieldKey) ?? [])];
    return conditions.every((condition) => condition && typeof condition === "object" && !Array.isArray(condition) && typeof condition.field === "string" && allowed.includes(condition.field) && equal(read(row, condition.field), condition.value));
  }));
}

export function buildSemanticMetric(widget: DashboardDataWidgetConfig, models: readonly SemanticModelRecord[], rows: Record<string, unknown>[], fields: readonly DataDatasetField[], widgets: readonly DashboardDataWidgetConfig[], filters: Readonly<Record<string, JsonValue>>): DashboardMetric {
  const resolved = resolveSemanticWidget(widget, models);
  const empty = { value: undefined, samples: [], semanticWidget: widget };
  if (resolved.error || !resolved.model) return { ...empty, semanticError: resolved.error ?? "语义模型不可用。" };
  try {
    const { model, metric, parameter } = resolved;
    const next = resolved.widget;
    const required = [metric?.fieldKey, ...(metric?.defaultFilters?.map((filter) => filter.fieldKey) ?? []), next.analysis?.dimensionField, ...(next.analysis?.drillFields ?? []), parameter ? next.filterField : undefined].filter((field): field is string => Boolean(field));
    const expression = metric?.expression ? compileFormula(metric.expression) : undefined;
    if (expression) required.push(...expression.dependencies);
    const missing = required.filter((key) => !fields.some((field) => field.key === key));
    if (missing.length) throw new Error(`源字段已失效：${[...new Set(missing)].join("、")}。请到数据中心修复口径。`);
    let result = semanticRows(rows, next, widgets, model, filters);
    if (parameter) {
      const values = parameter.optionsSource?.kind === "static" ? parameter.optionsSource.options.map((option) => String(option.value)) : [...new Set(result.map((row) => read(row, next.filterField!)).filter((value) => value !== null && value !== undefined).map(String))];
      return { ...empty, rows: result, semanticSource: { rows, fields }, semanticWidget: { ...next, options: ["全部", ...values.filter((value) => value !== "全部")] } };
    }
    result = result.filter((row) => metric?.defaultFilters?.every((filter) => matches(row, filter)) ?? true);
    if (!metric?.fieldKey) result = result.map((row) => ({ ...row, __semantic_value: expression ? evaluateFormula(expression, row) : metric?.aggregation === "countDistinct" ? JSON.stringify(row) : 1 }));
    const value = aggregate(result.map((row) => read(row, next.field!)), next.analysis!.aggregation);
    return { value, samples: [], rows: result, semanticWidget: next };
  } catch (error) {
    return { ...empty, semanticError: error instanceof Error ? error.message : "语义取数失败。" };
  }
}

export function previewSemanticParameter(widget: DashboardDataWidgetConfig, metric: DashboardMetric | undefined, models: readonly SemanticModelRecord[], widgets: readonly DashboardDataWidgetConfig[], draftFilters: Readonly<Record<string, JsonValue>>) {
  if (!widget.semanticBinding || !metric?.semanticSource || metric.semanticError) return metric;
  return buildSemanticMetric(widget, models, metric.semanticSource.rows, metric.semanticSource.fields, widgets, draftFilters);
}
