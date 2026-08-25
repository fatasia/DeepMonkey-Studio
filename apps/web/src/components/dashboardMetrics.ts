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

export function mergeDirectBindingMetric(current: Record<string, DashboardMetric>, key: string, value: unknown, data: unknown, time: number): Record<string, DashboardMetric> {
  const previous = current[key];
  const numeric = toFiniteNumber(value);
  const rows = recordRows(value) ?? recordRows(data) ?? previous?.rows;
  return {
    ...current,
    [key]: {
      value,
      samples: numeric === undefined ? previous?.samples ?? [] : [...(previous?.samples ?? []), { time, value: numeric }].slice(-60),
      ...(rows ? { rows } : {})
    }
  };
}

function recordRows(value: unknown): Array<Record<string, unknown>> | undefined {
  return Array.isArray(value) && value.every((item) => item && typeof item === "object" && !Array.isArray(item))
    ? value as Array<Record<string, unknown>>
    : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}
