import type { TopologyNode } from "@bim-studio/contracts";
import { topologyProjectedPosition, type TopologyViewMode } from "./topologyEditorRuntime";

export const TOPOLOGY_MIN_ZOOM = 0.05;
export const TOPOLOGY_MAX_ZOOM = 1.5;
export interface TopologyBounds { x: number; y: number; width: number; height: number }

export function topologyContentBounds(nodes: readonly TopologyNode[], mode: TopologyViewMode): TopologyBounds {
  if (!nodes.length) return { x: 0, y: 0, width: 0, height: 0 };
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const node of nodes) {
    const position = topologyProjectedPosition(node, mode);
    // 包含端口、告警角标和 2.5D 高度标签，不只计算节点中心。
    left = Math.min(left, position.x - 8);
    top = Math.min(top, position.y - (mode === "2.5d" ? 28 : 8));
    right = Math.max(right, position.x + 172);
    bottom = Math.max(bottom, position.y + 84);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function topologyFitZoom(bounds: TopologyBounds, width: number, height: number): number {
  if (!bounds.width || !bounds.height || width <= 0 || height <= 0) return 1;
  return Math.max(TOPOLOGY_MIN_ZOOM, Math.min(1, (width - 64) / bounds.width, (height - 64) / bounds.height));
}

export function topologyCanvasOrigin(bounds: TopologyBounds) {
  return { x: Math.max(0, 32 - bounds.x), y: Math.max(0, 32 - bounds.y) };
}

export function topologyFitOrigin(bounds: TopologyBounds, width: number, height: number, zoom: number) {
  const origin = topologyCanvasOrigin(bounds);
  return {
    x: Math.max(origin.x, width / (2 * zoom) - bounds.x - bounds.width / 2),
    y: Math.max(origin.y, height / (2 * zoom) - bounds.y - bounds.height / 2),
  };
}
