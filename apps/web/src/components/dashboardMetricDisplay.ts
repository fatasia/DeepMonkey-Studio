import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { formatDashboardReportValue } from "./dashboardAnalytics";

/** 仅格式化数字卡文本，计算、条件规则、图表和导出仍消费原值。 */
export function formatDashboardMetricDisplay(value: unknown, widget: DashboardDataWidgetConfig, locale: string): string {
  if (typeof value !== "number") return value === undefined ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (!Number.isFinite(value)) return "—";
  const decimalPlaces = Number.isInteger(value) ? 0 : widget.unit === "%" ? 1 : 2;
  // KPI 的百分比值已是 0–100 口径，不能套用 percent 模式再次乘以 100。
  return formatDashboardReportValue(value, { ...widget, report: { mode: "detail", valueFormat: "number", decimalPlaces } }, locale);
}
