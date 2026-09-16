import type { DashboardAggregation, DashboardDataWidgetConfig, DashboardSampleData } from "@bim-studio/contracts";

/** Shared author-sample semantics for Web preview and frozen publication data. */
export function buildDashboardSampleMetric(widget: DashboardDataWidgetConfig, rows: DashboardSampleData["rows"]) {
  const field = widget.analysis?.measureField ?? widget.field;
  const values = field ? rows.map(row => row[field]) : [];
  const mode = widget.analysis?.aggregation ?? "none";
  const value = mode === "none" ? values[0] : rows.length ? aggregate(values, mode) : undefined;
  return { value, rows, samples: values.flatMap((item, index) => typeof item === "number" ? [{ time: index, value: item }] : []) };
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
