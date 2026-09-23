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

/**
 * 清除 IEEE754 二进制表示噪声后再用于看板文本直渲（例如 46/59.33 这类
 * 计算会产生 77.46000000000001）。保留至多 12 位有效数字，不改变作者
 * 配置的合法小数精度；计算、条件规则与导出仍应消费原值。
 */
export function dashboardDisplayNumber(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Number(value.toPrecision(12));
}

/** 数字卡直渲文本：把数值噪声清理后转为字符串，保持 undefined/null 的占位语义。 */
export function dashboardDisplayText(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(dashboardDisplayNumber(value)) : "—";
  return String(value);
}

export function dashboardColorWithOpacity(color: string, opacity: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return color;
  const value = Number.parseInt(match[1]!, 16);
  return `rgba(${value >> 16},${(value >> 8) & 255},${value & 255},${Math.max(0, Math.min(1, opacity))})`;
}
