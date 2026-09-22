import type { DashboardDataWidgetNode } from "@bim-studio/contracts";
import type { DashboardRasterCompileInput } from "./dashboardRasterTypes";
import { DASHBOARD_CONTENT_INSET } from "./dashboardShapeContent";

/** Keep the plot below the measured heading; the author container remains full-size. */
export function dashboardChartContentFrame(node: DashboardDataWidgetNode, input: DashboardRasterCompileInput): [number, number, number, number] {
  const data = input.data?.[node.id], inset = DASHBOARD_CONTENT_INSET;
  const headings = data && "layout" in data ? data.layout.textBoxes.filter(box =>
    box.role.kind === "title" || box.role.kind === "unit") : [];
  const top = headings.length ? Math.max(...headings.map(box => box.rect[1] + box.rect[3])) + inset : inset;
  const width = node.frame.width - inset * 2, height = node.frame.height - top - inset;
  if (!Number.isFinite(top) || width < 32 || height < 32)
    throw new Error("Chart content box is too small below its measured heading");
  return [node.frame.x + inset, node.frame.y + top, width, height];
}
