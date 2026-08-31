import type { JsonValue } from "@bim-studio/contracts";

/** 把任意数据源值收敛为工作台事件允许传递的 JSON 值。 */
export function dashboardJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(dashboardJsonValue);
  if (value && typeof value === "object") return dashboardJsonRecord(value as Record<string, unknown>);
  return value === undefined ? null : String(value);
}

export function dashboardJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, dashboardJsonValue(item)]));
}

export function finiteDashboardNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

export function dashboardColorWithOpacity(color: string, opacity: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return color;
  const value = Number.parseInt(match[1]!, 16);
  return `rgba(${value >> 16},${(value >> 8) & 255},${value & 255},${Math.max(0, Math.min(1, opacity))})`;
}
