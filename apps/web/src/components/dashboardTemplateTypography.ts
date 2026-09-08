import type { CSSProperties } from "react";
import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";

/** 设计画布上的显式字号；不改没有字号设置的旧节点。 */
export function dashboardAuthoredTypography(widget: DashboardDataWidgetConfig): CSSProperties | undefined {
  if (!Number.isFinite(widget.fontSize) || !widget.fontSize || widget.fontSize <= 0) return undefined;
  return { "--dashboard-authored-font": `${widget.fontSize}px` } as CSSProperties;
}
