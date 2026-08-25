import type { DataDatasetField } from "@bim-studio/contracts";
import type { DashboardMetric } from "./DashboardWidgetRuntime";

export function mergeProductMetrics(current: Record<string, DashboardMetric>, productId: string, fields: readonly DataDatasetField[], rows: Array<Record<string, unknown>>): Record<string, DashboardMetric> {
  const next = { ...current };
  for (const field of fields) {
    const numericRows = [...rows].reverse().flatMap((row, index) => {
      const value = toFiniteNumber(row[field.key]);
      if (value === undefined) return [];
      const rawTime = row.recorded_at ?? row.time ?? row.timestamp;
      const time = typeof rawTime === "string" || typeof rawTime === "number" ? Date.parse(String(rawTime)) : Number.NaN;
      return [{ time: Number.isFinite(time) ? time : Date.now() - (rows.length - index) * 1_000, value }];
    });
    next[`${productId}.${field.key}`] = { value: rows[0]?.[field.key], samples: numericRows.slice(-60), rows };
  }
  return next;
}

function toFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}
