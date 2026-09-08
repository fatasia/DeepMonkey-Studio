import type { CSSProperties } from "react";
import type { DashboardPageDocument } from "@bim-studio/contracts";

export function dashboardPageUsesSampleData(page: DashboardPageDocument): boolean {
  return page.nodes.some(node => node.visible !== false && node.kind === "data-widget" && node.widget.sampleData !== undefined);
}

/** 打印按设计画布等比适配纸张，不复用窗口缩放，避免窄窗打印截断。 */
export function dashboardPrintLayout(width: number, height: number) {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1920;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1080;
  const landscape = safeWidth >= safeHeight;
  const paperWidth = landscape ? 297 : 210;
  const paperHeight = landscape ? 210 : 297;
  // 上下边距 10mm 留给每页页眉/页脚；左右 8mm 与 DashboardPrint.css 的 @page 保持一致。
  const marginX = 8;
  const marginY = 10;
  const contentInset = 8;
  const pixelsPerMillimeter = 96 / 25.4;
  const availableWidth = (paperWidth - marginX * 2) * pixelsPerMillimeter;
  const availableHeight = (paperHeight - marginY * 2 - contentInset * 2) * pixelsPerMillimeter;
  const scale = Math.min(availableWidth / safeWidth, availableHeight / safeHeight);
  return {
    orientation: landscape ? "landscape" : "portrait",
    scale,
    style: {
      "--dashboard-print-width": `${paperWidth - marginX * 2}mm`,
      "--dashboard-print-height": `${paperHeight - marginY * 2}mm`,
      "--dashboard-print-content-height": `${paperHeight - marginY * 2 - contentInset * 2}mm`,
      "--dashboard-print-content-inset": `${contentInset}mm`,
      "--dashboard-print-scale": scale,
      "--dashboard-print-left": `${(availableWidth - safeWidth * scale) / 2}px`,
      "--dashboard-print-top": `${(availableHeight - safeHeight * scale) / 2}px`,
    } as CSSProperties,
  };
}
