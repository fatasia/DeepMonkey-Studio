import type { TopologyDocument, TopologyNode } from "@bim-studio/contracts";
import { topologyProjectedPosition, type TopologyViewMode } from "./topologyEditorRuntime";

export function topologyNodeZone(node: TopologyNode): string {
  return typeof node.properties.zone === "string" ? node.properties.zone.trim() : "";
}

/** 从持久化区域名称形成底板；不推断设备所属工艺区。 */
export function topologyZones(nodes: readonly TopologyNode[]) {
  const zones = new Map<string, TopologyNode[]>();
  for (const node of nodes) {
    const name = topologyNodeZone(node);
    if (name) zones.set(name, [...(zones.get(name) ?? []), node]);
  }
  return [...zones].map(([name, members]) => ({ name, nodes: members }));
}

export function topologyZoneOutline(nodes: readonly TopologyNode[]) {
  if (!nodes.length) return "";
  const left = Math.min(...nodes.map(node => node.x)) - 82;
  const right = Math.max(...nodes.map(node => node.x)) + 112;
  const top = Math.min(...nodes.map(node => node.y)) - 82;
  const bottom = Math.max(...nodes.map(node => node.y)) + 112;
  // 底板与设备使用相同工程坐标投影，区域保持等轴方向而非屏幕包围矩形。
  return [[left,top],[right,top],[right,bottom],[left,bottom]].map(([x,y]) => {
    const point = topologyProjectedPosition({x:x!,y:y!,properties:{}},"2.5d");
    return `${point.x + 82},${point.y + 60}`;
  }).join(" ");
}

export function topologyConnectedIds(document: TopologyDocument, nodeId: string | undefined, direction: "upstream" | "downstream" | "all") {
  if (!nodeId) return new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const edge of document.edges) {
    if (direction !== "upstream") adjacency.set(edge.sourceNodeId, [...(adjacency.get(edge.sourceNodeId) ?? []), edge.targetNodeId]);
    if (direction !== "downstream") adjacency.set(edge.targetNodeId, [...(adjacency.get(edge.targetNodeId) ?? []), edge.sourceNodeId]);
  }
  const visited = new Set([nodeId]);
  const pending = [nodeId];
  while (pending.length) for (const neighbor of adjacency.get(pending.pop()!) ?? []) {
    if (!visited.has(neighbor)) { visited.add(neighbor); pending.push(neighbor); }
  }
  return visited;
}

export function topologyConnectionPath(source: TopologyNode, target: TopologyNode, mode: TopologyViewMode) {
  const a = topologyProjectedPosition(source, mode), b = topologyProjectedPosition(target, mode);
  const x1 = a.x + 164, y1 = a.y + (mode === "2d" ? 38 : 60);
  const x2 = b.x, y2 = b.y + (mode === "2d" ? 38 : 60);
  if (mode === "2d") {
    const curve = Math.max(70, Math.abs(x2 - x1) * 0.45);
    return { path: `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`, labelX: (x1 + x2) / 2, labelY: (y1 + y2) / 2 - 7 };
  }
  // 所有管线段遵守同一 ±30° 轴向；端口、箭头和标签共用此几何。
  const slope = 1 / Math.sqrt(3);
  const middleX = (x1 + x2 + (y2 - y1) / slope) / 2;
  const middleY = y1 + (middleX - x1) * slope;
  return { path: `M ${x1} ${y1} L ${middleX} ${middleY} L ${x2} ${y2}`, labelX: middleX, labelY: middleY - 9 };
}
