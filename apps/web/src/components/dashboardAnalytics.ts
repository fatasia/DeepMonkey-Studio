import type { DashboardAggregation, DashboardConditionalRule, DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { compileFormula, evaluateFormula } from "@bim-studio/data-runtime";
import type { DashboardMetric } from "./DashboardWidgetRuntime";

export interface DashboardAnalysisResult {
  rows: Array<Record<string, unknown>>;
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
  value: unknown;
}

export interface DashboardReportResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  grandTotal?: Record<string, number>;
}

export function analyzeDashboardMetric(widget: DashboardDataWidgetConfig, metric: DashboardMetric | undefined): DashboardAnalysisResult {
  const sourceRows = applyCalculatedFields(metric?.rows ?? [], widget.analysis?.calculatedFields ?? []);
  const analysis = widget.analysis;
  if (!analysis?.dimensionField || !analysis.measureField) {
    return {
      rows: sourceRows,
      categories: metric?.samples.map((_, index) => String(index + 1)) ?? [],
      series: [{ name: widget.title, values: metric?.samples.map((sample) => sample.value) ?? [] }],
      value: metric?.value,
    };
  }
  const grouped = new Map<string, Map<string, unknown[]>>();
  for (const row of sourceRows) {
    const dimension = String(readPath(row, analysis.dimensionField) ?? "未分类");
    const series = analysis.seriesField ? String(readPath(row, analysis.seriesField) ?? "默认") : widget.title;
    const seriesMap = grouped.get(dimension) ?? new Map<string, unknown[]>();
    const values = seriesMap.get(series) ?? [];
    values.push(readPath(row, analysis.measureField));
    seriesMap.set(series, values);
    grouped.set(dimension, seriesMap);
  }
  const seriesNames = [...new Set([...grouped.values()].flatMap((item) => [...item.keys()]))];
  let categories = [...grouped.keys()];
  const totals = (category: string) => seriesNames.reduce((sum, name) => sum + aggregate(grouped.get(category)?.get(name) ?? [], analysis.aggregation), 0);
  if (analysis.sort === "dimension-asc") categories.sort((a, b) => a.localeCompare(b));
  if (analysis.sort === "dimension-desc") categories.sort((a, b) => b.localeCompare(a));
  if (analysis.sort === "value-asc") categories.sort((a, b) => totals(a) - totals(b));
  if (analysis.sort === "value-desc") categories.sort((a, b) => totals(b) - totals(a));
  categories = categories.slice(0, Math.max(1, analysis.limit ?? 100));
  const series = seriesNames.map((name) => ({ name, values: categories.map((category) => aggregate(grouped.get(category)?.get(name) ?? [], analysis.aggregation)) }));
  return { rows: sourceRows, categories, series, value: series[0]?.values.at(-1) ?? metric?.value };
}

export function buildDashboardReport(widget: DashboardDataWidgetConfig, metric: DashboardMetric | undefined): DashboardReportResult {
  const rows = applyCalculatedFields(metric?.rows ?? [], widget.analysis?.calculatedFields ?? []);
  const report = widget.report;
  if (!report || report.mode === "detail") {
    const columns = uniqueColumns(rows);
    return { columns, rows };
  }
  const rowField = report.rowField || widget.analysis?.dimensionField;
  const fallbackValueField = report.valueField || widget.analysis?.measureField || widget.field;
  const configuredValueFields = report.valueFields?.filter(Boolean) ?? [];
  const valueFields = configuredValueFields.length ? [...new Set(configuredValueFields)] : fallbackValueField ? [fallbackValueField] : [];
  if (!rowField || valueFields.length === 0) return { columns: uniqueColumns(rows), rows };
  const aggregation = report.aggregation ?? widget.analysis?.aggregation ?? "sum";
  const rowValues = [...new Set(rows.map((row) => String(readPath(row, rowField) ?? "未分类")))];
  if (report.mode === "grouped") {
    const groupedRows = rowValues.map((rowValue) => {
      const groupRows = rows.filter((row) => String(readPath(row, rowField) ?? "未分类") === rowValue);
      return Object.fromEntries([
        [rowField, rowValue],
        ...valueFields.map((valueField) => [
          valueField,
          aggregate(
            groupRows.map((row) => readPath(row, valueField)),
            aggregation,
          ),
        ]),
      ]);
    });
    const grandTotal = report.showGrandTotal
      ? Object.fromEntries(
          valueFields.map((valueField) => [
            valueField,
            aggregate(
              rows.map((row) => readPath(row, valueField)),
              aggregation,
            ),
          ]),
        )
      : undefined;
    return { columns: [rowField, ...valueFields], rows: groupedRows, ...(grandTotal ? { grandTotal } : {}) };
  }
  const columnField = report.columnField;
  if (!columnField) return { columns: uniqueColumns(rows), rows };
  const columnValues = [...new Set(rows.map((row) => String(readPath(row, columnField) ?? "未分类")))];
  const valueColumn = (columnValue: string, valueField: string) => (valueFields.length === 1 ? columnValue : `${columnValue} · ${valueField}`);
  const subtotalColumn = (valueField: string) => (valueFields.length === 1 ? "行总计" : `行总计 · ${valueField}`);
  const pivotColumns = columnValues.flatMap((columnValue) => valueFields.map((valueField) => valueColumn(columnValue, valueField)));
  const subtotalColumns = report.showSubtotal ? valueFields.map(subtotalColumn) : [];
  const pivotRows = rowValues.map((rowValue) => {
    const rowGroup = rows.filter((row) => String(readPath(row, rowField) ?? "未分类") === rowValue);
    return Object.fromEntries([
      [rowField, rowValue],
      ...columnValues.flatMap((columnValue) =>
        valueFields.map((valueField) => [
          valueColumn(columnValue, valueField),
          aggregate(
            rowGroup.filter((row) => String(readPath(row, columnField) ?? "未分类") === columnValue).map((row) => readPath(row, valueField)),
            aggregation,
          ),
        ]),
      ),
      ...subtotalColumns.map((column, index) => [
        column,
        aggregate(
          rowGroup.map((row) => readPath(row, valueFields[index]!)),
          aggregation,
        ),
      ]),
    ]);
  });
  const grandTotal = report.showGrandTotal
    ? Object.fromEntries([
        ...columnValues.flatMap((columnValue) =>
          valueFields.map((valueField) => [
            valueColumn(columnValue, valueField),
            aggregate(
              rows.filter((row) => String(readPath(row, columnField) ?? "未分类") === columnValue).map((row) => readPath(row, valueField)),
              aggregation,
            ),
          ]),
        ),
        ...subtotalColumns.map((column, index) => [
          column,
          aggregate(
            rows.map((row) => readPath(row, valueFields[index]!)),
            aggregation,
          ),
        ]),
      ])
    : undefined;
  return { columns: [rowField, ...pivotColumns, ...subtotalColumns], rows: pivotRows, ...(grandTotal ? { grandTotal } : {}) };
}

export function conditionalStyle(
  rules: readonly DashboardConditionalRule[] | undefined,
  row: Record<string, unknown>,
  fallbackValue?: unknown,
): { color?: string; backgroundColor?: string; fontWeight?: number; visible?: boolean; animation?: "none" | "pulse" } {
  const matched = rules?.find((rule) => matchesRule(rule, rule.field ? readPath(row, rule.field) : fallbackValue));
  return matched
    ? {
        ...(matched.color ? { color: matched.color } : {}),
        ...(matched.backgroundColor ? { backgroundColor: matched.backgroundColor } : {}),
        ...(matched.fontWeight !== undefined ? { fontWeight: matched.fontWeight } : {}),
        ...(matched.visible !== undefined ? { visible: matched.visible } : {}),
        ...(matched.animation ? { animation: matched.animation } : {}),
      }
    : {};
}

export function dashboardReportCsv(report: DashboardReportResult): string {
  const rows = [report.columns, ...report.rows.map((row) => report.columns.map((column) => row[column] ?? ""))];
  if (report.grandTotal) rows.push(report.columns.map((column, index) => (index === 0 ? "总计" : (report.grandTotal?.[column] ?? ""))));
  return `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

export function sortDashboardReportRows(rows: readonly Record<string, unknown>[], column: string, direction: "asc" | "desc"): Array<Record<string, unknown>> {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => compareReportValues(left[column], right[column]) * multiplier);
}

export function formatDashboardReportValue(value: unknown, widget: DashboardDataWidgetConfig, locale: string): string {
  if (value === undefined || value === null || value === "") return "—";
  const mode = widget.report?.valueFormat ?? "auto";
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (mode === "auto" || !Number.isFinite(numeric)) return typeof value === "object" ? JSON.stringify(value) : String(value);
  const digits = Math.max(0, Math.min(8, widget.report?.decimalPlaces ?? (mode === "percent" ? 1 : 2)));
  const options: Intl.NumberFormatOptions = { minimumFractionDigits: digits, maximumFractionDigits: digits };
  if (mode === "percent") options.style = "percent";
  if (mode === "currency") {
    options.style = "currency";
    options.currency = widget.report?.currency || "CNY";
  }
  return new Intl.NumberFormat(locale, options).format(numeric);
}

export function aggregate(values: readonly unknown[], mode: DashboardAggregation): number {
  if (mode === "count") return values.filter((value) => value !== undefined && value !== null && value !== "").length;
  if (mode === "distinct-count") return new Set(values.filter((value) => value !== undefined && value !== null).map(String)).size;
  const numbers = values.flatMap((value) => {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? [number] : [];
  });
  if (numbers.length === 0) return 0;
  if (mode === "average") return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  if (mode === "minimum") return Math.min(...numbers);
  if (mode === "maximum") return Math.max(...numbers);
  if (mode === "none") return numbers.at(-1) ?? 0;
  return numbers.reduce((sum, value) => sum + value, 0);
}

function applyCalculatedFields(rows: Array<Record<string, unknown>>, fields: readonly { key: string; formula: string }[]): Array<Record<string, unknown>> {
  if (fields.length === 0) return rows;
  const compiled = fields
    .map((field) => {
      try {
        return { key: field.key, formula: compileFormula(field.formula) };
      } catch {
        return undefined;
      }
    })
    .filter((field): field is NonNullable<typeof field> => Boolean(field));
  return rows.map((row) =>
    compiled.reduce<Record<string, unknown>>(
      (next, field) => {
        try {
          next[field.key] = evaluateFormula(field.formula, next);
        } catch {
          next[field.key] = null;
        }
        return next;
      },
      { ...row },
    ),
  );
}

function matchesRule(rule: DashboardConditionalRule, value: unknown): boolean {
  const left = typeof value === "number" ? value : Number(value);
  const right = typeof rule.value === "number" ? rule.value : Number(rule.value);
  if (rule.operator === "contains") return String(value ?? "").includes(String(rule.value));
  if (rule.operator === "eq") return String(value ?? "") === String(rule.value);
  if (rule.operator === "ne") return String(value ?? "") !== String(rule.value);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (rule.operator === "gt") return left > right;
  if (rule.operator === "gte") return left >= right;
  if (rule.operator === "lt") return left < right;
  if (rule.operator === "lte") return left <= right;
  return left >= right && left <= (rule.valueTo ?? right);
}

function readPath(row: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((current, segment) => (current && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined), row);
}

function uniqueColumns(rows: Array<Record<string, unknown>>): string[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row)))];
}

function csvCell(value: unknown): string {
  const text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function compareReportValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined || left === null || left === "") return 1;
  if (right === undefined || right === null || right === "") return -1;
  const leftNumber = typeof left === "number" ? left : Number(left);
  const rightNumber = typeof right === "number" ? right : Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return String(left).localeCompare(String(right), "zh-CN", { numeric: true, sensitivity: "base" });
}
