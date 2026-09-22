import type { DashboardButtonGroup, DashboardDataTextBox } from "./dashboardDataRasterTypes";
import type { DashboardRasterTextStyle } from "./dashboardRasterTypes";

/** Bounded compilation densities; this does not promise arbitrary runtime zoom. */
export function dashboardTextRasterScale(value: number | undefined): 1 | 2 {
  if (value === undefined || value === 1) return 1;
  if (value === 2) return 2;
  throw new Error("Text raster scale must be 1 or 2");
}
export function scaleRasterTextStyle(style: DashboardRasterTextStyle, scale: number): DashboardRasterTextStyle {
  return { ...style, fontSize: style.fontSize * scale, lineHeight: style.lineHeight * scale };
}
export function scaleRasterRect(rect: DashboardDataTextBox["rect"], scale: number): DashboardDataTextBox["rect"] {
  return [rect[0] * scale, rect[1] * scale, rect[2] * scale, rect[3] * scale];
}
export function scaleRasterButtonGroup(group: DashboardButtonGroup, scale: number): DashboardButtonGroup {
  return { ...group, rect: scaleRasterRect(group.rect, scale), radius: group.radius * scale,
    borderWidth: group.borderWidth * scale };
}
