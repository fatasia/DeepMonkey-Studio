import { useEffect } from "react";
import { calculateDashboardEditorFocus } from "../components/dashboardWorkspaceModel";
import type { DashboardEditorFocusMode } from "../components/dashboardWorkspaceModel";
import type { DashboardPageDocument } from "@bim-studio/contracts";

export interface DashboardSurfaceResizeOptions {
  page: Pick<DashboardPageDocument, "id" | "width" | "height">;
  nodes: ReadonlyArray<Parameters<typeof calculateDashboardEditorFocus>[1][number]>;
  surfaceRef: React.RefObject<HTMLDivElement | null>;
  previousSurfaceSizeRef: React.MutableRefObject<{ width: number; height: number }>;
  zoom: number;
  setSurfaceSize: (size: { width: number; height: number }) => void;
  fitCanvasToViewport: (mode?: DashboardEditorFocusMode) => void;
}

/**
 * 画布表面尺寸跟随（自 DashboardWorkspace 抽出，控文件行数）。
 * resize 风暴期间不跟随，停稳 180ms 后最多执行一次自动聚焦：即时 fit 会改写
 * zoom/scroll 并触发 ResizeObserver 再判定，与滚动条出现/消失形成反馈振荡
 * （画布与滚动条抖动，U1-10 根因）。setSurfaceSize 仍即时跟进保证画布盒正确。
 */
export function useDashboardSurfaceResize(options: DashboardSurfaceResizeOptions) {
  const { page, nodes, surfaceRef, previousSurfaceSizeRef, zoom, setSurfaceSize, fitCanvasToViewport } = options;
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    let fitTimer = 0;
    const update = () => {
      const nextSize = { width: surface.clientWidth, height: surface.clientHeight };
      const previousSize = previousSurfaceSizeRef.current;
      const resized = previousSize.width > 0 && (previousSize.width !== nextSize.width || previousSize.height !== nextSize.height);
      const previousFocus = calculateDashboardEditorFocus(page, nodes, previousSize.width, previousSize.height, "smart");
      previousSurfaceSizeRef.current = nextSize;
      setSurfaceSize(nextSize);
      if (!resized || Math.abs(zoom - previousFocus.zoom) >= 0.006) return;
      window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => fitCanvasToViewport("smart"), 180);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => {
      window.clearTimeout(fitTimer);
      observer.disconnect();
    };
  }, [page.id, zoom]);
}
