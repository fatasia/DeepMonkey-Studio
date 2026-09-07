import type { CSSProperties } from "react";

/** 打印按设计画布等比适配纸张，不复用窗口缩放，避免窄窗打印截断。 */
export function dashboardPrintLayout(width: number, height: number) {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1920;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1080;
  const landscape = safeWidth >= safeHeight;
  const paperWidth = landscape ? 297 : 210;
  const paperHeight = landscape ? 210 : 297;
  const margin = 8;
  const pixelsPerMillimeter = 96 / 25.4;
  const availableWidth = (paperWidth - margin * 2) * pixelsPerMillimeter;
  const availableHeight = (paperHeight - margin * 2) * pixelsPerMillimeter;
  const scale = Math.min(availableWidth / safeWidth, availableHeight / safeHeight);
  return {
    orientation: landscape ? "landscape" : "portrait",
    scale,
    style: {
      "--dashboard-print-width": `${paperWidth - margin * 2}mm`,
      "--dashboard-print-height": `${paperHeight - margin * 2}mm`,
      "--dashboard-print-scale": scale,
      "--dashboard-print-left": `${(availableWidth - safeWidth * scale) / 2}px`,
      "--dashboard-print-top": `${(availableHeight - safeHeight * scale) / 2}px`,
    } as CSSProperties,
  };
}
