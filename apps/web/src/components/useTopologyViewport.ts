import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TopologyDocument } from "@bim-studio/contracts";
import type { TopologyViewMode } from "./topologyEditorRuntime";
import { topologyCanvasOrigin, topologyContentBounds, topologyFitOrigin, topologyFitZoom, TOPOLOGY_MAX_ZOOM, TOPOLOGY_MIN_ZOOM } from "./topologyViewportGeometry";

/** 视图变化不进入文档、撤销栈或自动保存。手动缩放/滚动后不强制抢回视角。 */
export function useTopologyViewport(document: TopologyDocument, mode: TopologyViewMode) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [request, setRequest] = useState(0);
  const autoFit = useRef(true);
  const pendingCenter = useRef<{ x: number; y: number } | undefined>(undefined);
  const bounds = useMemo(() => topologyContentBounds(document.nodes, mode), [document.nodes, mode]);
  const [fitOrigin, setFitOrigin] = useState({ x: 0, y: 0 });
  const baseOrigin = topologyCanvasOrigin(bounds);
  const origin = { x: Math.max(baseOrigin.x, fitOrigin.x), y: Math.max(baseOrigin.y, fitOrigin.y) };
  const current = useRef({ bounds, origin, zoom });
  current.current = { bounds, origin, zoom };

  const fitView = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !viewport.clientWidth || !viewport.clientHeight) return;
    const { bounds } = current.current;
    const nextZoom = topologyFitZoom(bounds, viewport.clientWidth, viewport.clientHeight);
    const origin = topologyFitOrigin(bounds, viewport.clientWidth, viewport.clientHeight, nextZoom);
    setFitOrigin(origin);
    autoFit.current = true;
    pendingCenter.current = { x: bounds.x + bounds.width / 2 + origin.x, y: bounds.y + bounds.height / 2 + origin.y };
    setZoom(nextZoom);
    setRequest(value => value + 1);
  }, []);

  useEffect(() => { fitView(); }, [document.id, mode, fitView]);
  useEffect(() => {
    // 首个节点或结构增删后，概览模式需要重新适配；手动视角不因普通编辑跳动。
    if (autoFit.current) fitView();
  }, [document.nodes.length, fitView]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => { if (autoFit.current) fitView(); });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fitView]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const center = pendingCenter.current;
    if (!viewport || !center) return;
    viewport.scrollLeft = Math.max(0, center.x * zoom - viewport.clientWidth / 2);
    viewport.scrollTop = Math.max(0, center.y * zoom - viewport.clientHeight / 2);
    pendingCenter.current = undefined;
  }, [zoom, request]);

  function updateZoom(next: number) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    autoFit.current = false;
    pendingCenter.current = {
      x: (viewport.scrollLeft + viewport.clientWidth / 2) / zoom,
      y: (viewport.scrollTop + viewport.clientHeight / 2) / zoom,
    };
    setZoom(Math.max(TOPOLOGY_MIN_ZOOM, Math.min(TOPOLOGY_MAX_ZOOM, Math.round(next * 100) / 100)));
    setRequest(value => value + 1);
  }

  return {
    viewportRef, zoom, fitView,
    markManualView: () => { autoFit.current = false; },
    zoomIn: () => updateZoom(zoom + 0.1),
    zoomOut: () => updateZoom(zoom - 0.1),
    resetZoom: () => updateZoom(1),
    canvasOffset: { left: origin.x * zoom, top: origin.y * zoom },
    stageSize: {
      width: (Math.max(1600, bounds.x + bounds.width + 32) + origin.x) * zoom,
      height: (Math.max(1000, bounds.y + bounds.height + 32) + origin.y) * zoom,
    },
  };
}
