import { createHash } from "node:crypto";
import type {
  AskDataAggregation,
  AskDataPlanningIssue,
  AskDataQueryPlan,
  AskDataQueryPlanInput,
  AskDataQueryPlanningResult,
  AskDataQueryReadResult,
  DataDatasetPreview,
  DataDatasetRecord,
  DataDatasetField,
} from "@bim-studio/contracts";

export function createDataQueryPlan(
  input: AskDataQueryPlanInput,
  dataset: DataDatasetRecord | undefined,
): AskDataQueryPlanningResult {
  if (!dataset) return needsInput("$.datasetId", "dataset-not-found", "数据集不存在或当前项目无权访问");

  const issues: AskDataPlanningIssue[] = [];
  const fieldsByKey = new Map(dataset.fields.map((field) => [field.key, field]));
  const selectedKeys = unique(input.fields);
  for (const key of referencedSourceFields(input)) {
    if (!fieldsByKey.has(key)) issues.push(issue(`$.fields.${key}`, "field-not-found", `数据集“${dataset.name}”没有字段 ${key}`));
  }
  validateFilters(input, fieldsByKey, issues);
  if (input.timeWindow) validateTimeWindow(input.timeWindow, fieldsByKey, issues);
  validateAggregations(input, fieldsByKey, issues);
  if (issues.length) return { status: "needs-input", issues };

  const normalized = {
    schemaVersion: 1 as const,
    datasetId: dataset.id,
    datasetName: dataset.name,
    datasetRevision: dataset.updatedAt,
    fields: selectedKeys,
    resolvedFields: selectedKeys.map((key) => ({ ...fieldsByKey.get(key)! })),
    ...(input.filters?.length ? { filters: input.filters.map((filter) => ({ ...filter, value: structuredClone(filter.value) })) } : {}),
    ...(input.timeWindow ? { timeWindow: { ...input.timeWindow } } : {}),
    ...(input.groupBy?.length ? { groupBy: unique(input.groupBy) } : {}),
    ...(input.aggregations?.length ? { aggregations: input.aggregations.map((aggregation) => ({ ...aggregation })) } : {}),
    ...(input.sort ? { sort: { ...input.sort } } : {}),
    limit: Math.max(1, Math.min(500, Math.floor(input.limit ?? 100))),
  };
  const plan: AskDataQueryPlan = { ...normalized, fingerprint: fingerprint(normalized) };
  return { status: "ready", plan, issues: [] };
}

export function validateDataQueryPlan(plan: AskDataQueryPlan, dataset: DataDatasetRecord | undefined): AskDataQueryPlanningResult {
  const planned = createDataQueryPlan(plan, dataset);
  if (!planned.plan) return planned;
  if (dataset?.updatedAt !== plan.datasetRevision) return needsInput("$.plan.datasetRevision", "invalid-plan", "数据集结构已更新，请重新生成查询计划");
  if (planned.plan.fingerprint !== plan.fingerprint) return needsInput("$.plan.fingerprint", "invalid-plan", "查询计划已被修改，请重新校验");
  return planned;
}

export function executeDataQuery(plan: AskDataQueryPlan, preview: DataDatasetPreview): AskDataQueryReadResult {
  const fieldTypes = new Map(preview.fields.map((field) => [field.key, field.type]));
  let rows = preview.rows.filter((row) => matchesTimeWindow(row, plan) && (plan.filters ?? []).every((filter) => matchesFilter(row[filter.field], filter.operator, filter.value, fieldTypes.get(filter.field))));
  const matchedRows = rows.length;
  if (plan.aggregations?.length) {
    rows = aggregateRows(rows, plan.groupBy ?? [], plan.aggregations);
    sortRows(rows, plan);
  } else {
    // 排序字段不必出现在最终列中，因此必须在投影前排序。
    sortRows(rows, plan);
    rows = rows.map((row) => selectFields(row, plan.fields));
  }
  const limited = rows.slice(0, plan.limit);
  const columns = resultColumns(plan, preview.fields);
  const resultBase = {
    planFingerprint: plan.fingerprint,
    datasetId: plan.datasetId,
    datasetName: plan.datasetName,
    columns,
    rows: limited,
    matchedRows,
    returnedRows: limited.length,
    truncated: rows.length > limited.length,
    sourceDurationMs: preview.durationMs,
  };
  return { ...resultBase, evidenceFingerprint: fingerprint(resultBase) };
}

function validateTimeWindow(window: NonNullable<AskDataQueryPlanInput["timeWindow"]>, fields: Map<string, DataDatasetField>, issues: AskDataPlanningIssue[]): void {
  const field = fields.get(window.field);
  if (field && field.type !== "datetime") issues.push(issue("$.timeWindow.field", "field-type", `${field.label} 不是时间字段`));
  const start = window.start ? Date.parse(window.start) : undefined;
  const end = window.end ? Date.parse(window.end) : undefined;
  if (window.start && !Number.isFinite(start)) issues.push(issue("$.timeWindow.start", "invalid-window", "开始时间不是有效 ISO 时间"));
  if (window.end && !Number.isFinite(end)) issues.push(issue("$.timeWindow.end", "invalid-window", "结束时间不是有效 ISO 时间"));
  if (start !== undefined && end !== undefined && start > end) issues.push(issue("$.timeWindow", "invalid-window", "开始时间不能晚于结束时间"));
}

function validateAggregations(input: AskDataQueryPlanInput, fields: Map<string, DataDatasetField>, issues: AskDataPlanningIssue[]): void {
  if (input.groupBy?.length && !input.aggregations?.length) issues.push(issue("$.groupBy", "invalid-plan", "分组查询至少需要一个聚合指标"));
  const aliases = new Set<string>();
  for (const [index, aggregation] of (input.aggregations ?? []).entries()) {
    if (aliases.has(aggregation.as)) issues.push(issue(`$.aggregations[${index}].as`, "invalid-plan", `聚合别名 ${aggregation.as} 重复`));
    aliases.add(aggregation.as);
    if (aggregation.operator !== "count" && !aggregation.field) issues.push(issue(`$.aggregations[${index}].field`, "invalid-plan", `${aggregation.operator} 必须指定数值字段`));
    const field = aggregation.field ? fields.get(aggregation.field) : undefined;
    if (field && aggregation.operator !== "count" && field.type !== "number") issues.push(issue(`$.aggregations[${index}].field`, "field-type", `${field.label} 不是数值字段`));
  }
  if (input.sort && !fields.has(input.sort.field) && !aliases.has(input.sort.field)) issues.push(issue("$.sort.field", "field-not-found", `排序字段 ${input.sort.field} 不在源字段或聚合结果中`));
}

function validateFilters(input: AskDataQueryPlanInput, fields: Map<string, DataDatasetField>, issues: AskDataPlanningIssue[]): void {
  for (const [index, filter] of (input.filters ?? []).entries()) {
    const field = fields.get(filter.field);
    if (!field) continue;
    const path = `$.filters[${index}]`;
    const values = filter.operator === "in" && Array.isArray(filter.value) ? filter.value : [filter.value];
    if (filter.operator === "in" && (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 100)) {
      issues.push(issue(`${path}.value`, "invalid-plan", "in 过滤值必须是 1 至 100 项的数组"));
      continue;
    }
    if (filter.operator === "contains" && (field.type !== "string" || typeof filter.value !== "string")) {
      issues.push(issue(path, "field-type", "包含过滤只支持文本字段和文本值"));
      continue;
    }
    if (["gt", "gte", "lt", "lte"].includes(filter.operator) && !["number", "datetime"].includes(field.type)) {
      issues.push(issue(path, "field-type", `${field.label} 不支持大小比较`));
      continue;
    }
    if (!values.every((value) => valueMatchesField(value, field))) issues.push(issue(`${path}.value`, "field-type", `过滤值与 ${field.label} 的 ${field.type} 类型不一致`));
  }
}

function referencedSourceFields(input: AskDataQueryPlanInput): string[] {
  return unique([
    ...input.fields,
    ...(input.filters ?? []).map((filter) => filter.field),
    ...(input.timeWindow ? [input.timeWindow.field] : []),
    ...(input.groupBy ?? []),
    ...(input.aggregations ?? []).flatMap((aggregation) => aggregation.field ? [aggregation.field] : []),
    ...(input.sort && !(input.aggregations ?? []).some((item) => item.as === input.sort!.field) ? [input.sort.field] : []),
  ]);
}

function matchesTimeWindow(row: Record<string, unknown>, plan: AskDataQueryPlan): boolean {
  if (!plan.timeWindow) return true;
  const timestamp = Date.parse(String(row[plan.timeWindow.field] ?? ""));
  if (!Number.isFinite(timestamp)) return false;
  if (plan.timeWindow.start && timestamp < Date.parse(plan.timeWindow.start)) return false;
  if (plan.timeWindow.end && timestamp > Date.parse(plan.timeWindow.end)) return false;
  return true;
}

function matchesFilter(actual: unknown, operator: string, expected: unknown, fieldType: DataDatasetField["type"] | undefined): boolean {
  if (operator === "eq") return Object.is(actual, expected);
  if (operator === "neq") return !Object.is(actual, expected);
  if (operator === "contains") return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
  if (operator === "in") return Array.isArray(expected) && expected.some((item) => Object.is(item, actual));
  const comparison = fieldType === "datetime"
    ? Date.parse(String(actual ?? "")) - Date.parse(String(expected ?? ""))
    : compareValues(actual, expected);
  if (!Number.isFinite(comparison)) return false;
  return operator === "gt" ? comparison > 0 : operator === "gte" ? comparison >= 0 : operator === "lt" ? comparison < 0 : operator === "lte" ? comparison <= 0 : false;
}

function aggregateRows(rows: Array<Record<string, unknown>>, groupBy: string[], aggregations: AskDataAggregation[]): Array<Record<string, unknown>> {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const key = JSON.stringify(groupBy.map((field) => row[field] ?? null));
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  if (!groups.size && groupBy.length === 0) groups.set("[]", []);
  return [...groups.values()].map((group) => {
    const output = Object.fromEntries(groupBy.map((field) => [field, group[0]?.[field] ?? null]));
    for (const aggregation of aggregations) output[aggregation.as] = aggregateValue(group, aggregation);
    return output;
  });
}

function aggregateValue(rows: Array<Record<string, unknown>>, aggregation: AskDataAggregation): number | null {
  if (aggregation.operator === "count") return aggregation.field ? rows.filter((row) => row[aggregation.field!] !== null && row[aggregation.field!] !== undefined).length : rows.length;
  const values = rows.map((row) => row[aggregation.field!]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!values.length) return null;
  if (aggregation.operator === "sum") return values.reduce((total, value) => total + value, 0);
  if (aggregation.operator === "avg") return values.reduce((total, value) => total + value, 0) / values.length;
  return aggregation.operator === "min" ? Math.min(...values) : Math.max(...values);
}

function resultColumns(plan: AskDataQueryPlan, source: DataDatasetField[]): DataDatasetField[] {
  const byKey = new Map(source.map((field) => [field.key, field]));
  if (!plan.aggregations?.length) return plan.fields.map((key) => ({ ...byKey.get(key)! }));
  return [
    ...(plan.groupBy ?? []).map((key) => ({ ...byKey.get(key)! })),
    ...plan.aggregations.map((item) => ({ key: item.as, label: item.as, type: "number" as const })),
  ];
}

function selectFields(row: Record<string, unknown>, fields: string[]): Record<string, unknown> { return Object.fromEntries(fields.map((field) => [field, row[field]])); }
function sortRows(rows: Array<Record<string, unknown>>, plan: AskDataQueryPlan): void { if (plan.sort) rows.sort((left, right) => compareValues(left[plan.sort!.field], right[plan.sort!.field]) * (plan.sort!.direction === "asc" ? 1 : -1)); }
function compareValues(left: unknown, right: unknown): number { return typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? "")); }
function valueMatchesField(value: unknown, field: DataDatasetField): boolean {
  if (value === null) return true;
  if (field.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "datetime") return typeof value === "string" && Number.isFinite(Date.parse(value));
  if (field.type === "string") return typeof value === "string";
  return typeof value === "object";
}
function issue(path: string, code: AskDataPlanningIssue["code"], message: string): AskDataPlanningIssue { return { path, code, message }; }
function needsInput(path: string, code: AskDataPlanningIssue["code"], message: string): AskDataQueryPlanningResult { return { status: "needs-input", issues: [issue(path, code, message)] }; }
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
