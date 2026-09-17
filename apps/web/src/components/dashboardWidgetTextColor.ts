import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";

/** Published author-node default, shared with frozen layout capture. */
export function dashboardWidgetTextColor(widget: DashboardDataWidgetConfig): string {
  return widget.textColor ?? "#eef2f4";
}
