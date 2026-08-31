import type { TopologyDocument, TopologyEdge, TopologyNode } from "@bim-studio/contracts";
import type { TopologyNodePosition } from "./topologyEditor.js";

export type TopologyAlignment =
  | "left"
  | "horizontal-center"
  | "right"
  | "top"
  | "vertical-center"
  | "bottom"
  | "distribute-horizontal"
  | "distribute-vertical";

export interface DuplicatedTopologySelection {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  nodeIds: string[];
}

/** 基于有向关系生成稳定分层布局；环路单独落到末层，不依赖浏览器或第三方布局运行时。 */
export function layoutTopologyNodes(document: TopologyDocument): TopologyNodePosition[] {
  const nodes = [...document.nodes].sort(compareNodes);
  if (nodes.length === 0) return [];
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of document.edges) {
    if (!indegree.has(edge.sourceNodeId) || !indegree.has(edge.targetNodeId)) continue;
    indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1);
    outgoing.get(edge.sourceNodeId)?.push(edge.targetNodeId);
  }
  const layerById = new Map<string, number>();
  const queue = nodes.filter((node) => indegree.get(node.id) === 0);
  for (const node of queue) layerById.set(node.id, 0);
  while (queue.length > 0) {
    const node = queue.shift()!;
    const nextLayer = (layerById.get(node.id) ?? 0) + 1;
    for (const targetId of outgoing.get(node.id) ?? []) {
      layerById.set(targetId, Math.max(layerById.get(targetId) ?? 0, nextLayer));
      indegree.set(targetId, (indegree.get(targetId) ?? 1) - 1);
      if (indegree.get(targetId) === 0) {
        const target = nodes.find((candidate) => candidate.id === targetId);
        if (target) queue.push(target);
      }
    }
  }
  const lastLayer = Math.max(0, ...layerById.values());
  for (const node of nodes) if (!layerById.has(node.id)) layerById.set(node.id, lastLayer + 1);
  const layers = new Map<number, TopologyNode[]>();
  for (const node of nodes) {
    const layer = layerById.get(node.id) ?? 0;
    layers.set(layer, [...(layers.get(layer) ?? []), node]);
  }
  return [...layers.entries()].flatMap(([layer, items]) =>
    items.sort(compareNodes).map((node, row) => ({ nodeId: node.id, x: 80 + layer * 240, y: 80 + row * 128 })),
  );
}

/** 多选节点对齐和等距分布共享一套确定性坐标算法，方便撤销、测试和脚本复用。 */
export function alignTopologyNodes(
  document: TopologyDocument,
  nodeIds: readonly string[],
  alignment: TopologyAlignment,
): TopologyNodePosition[] {
  const selected = uniqueNodes(document, nodeIds);
  if (selected.length < 2) return selected.map(positionOf);
  if (alignment.startsWith("distribute-") && selected.length < 3) return selected.map(positionOf);
  const xs = selected.map((node) => node.x);
  const ys = selected.map((node) => node.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (alignment === "distribute-horizontal") return distribute(selected, "x", minX, maxX);
  if (alignment === "distribute-vertical") return distribute(selected, "y", minY, maxY);
  const x = alignment === "left" ? minX : alignment === "right" ? maxX : (minX + maxX) / 2;
  const y = alignment === "top" ? minY : alignment === "bottom" ? maxY : (minY + maxY) / 2;
  return selected.map((node) => ({
    nodeId: node.id,
    x: alignment === "left" || alignment === "right" || alignment === "horizontal-center" ? x : node.x,
    y: alignment === "top" || alignment === "bottom" || alignment === "vertical-center" ? y : node.y,
  }));
}

/** 复制节点时一并复制选区内部连线，外部连线不复制，避免意外改写原网络。 */
export function duplicateTopologySelection(
  document: TopologyDocument,
  nodeIds: readonly string[],
  createId: (kind: "node" | "edge", sourceId: string) => string,
  offset = 32,
): DuplicatedTopologySelection {
  const selected = uniqueNodes(document, nodeIds);
  const idMap = new Map(selected.map((node) => [node.id, createId("node", node.id)]));
  const nodes = selected.map((node) => ({
    ...node,
    id: idMap.get(node.id)!,
    x: node.x + offset,
    y: node.y + offset,
    properties: structuredClone(node.properties),
  }));
  const edges = document.edges
    .filter((edge) => idMap.has(edge.sourceNodeId) && idMap.has(edge.targetNodeId))
    .map((edge) => ({
      ...edge,
      id: createId("edge", edge.id),
      sourceNodeId: idMap.get(edge.sourceNodeId)!,
      targetNodeId: idMap.get(edge.targetNodeId)!,
      properties: structuredClone(edge.properties),
    }));
  return { nodes, edges, nodeIds: nodes.map((node) => node.id) };
}

function uniqueNodes(document: TopologyDocument, nodeIds: readonly string[]): TopologyNode[] {
  const wanted = new Set(nodeIds);
  return document.nodes.filter((node) => wanted.has(node.id));
}

function positionOf(node: TopologyNode): TopologyNodePosition {
  return { nodeId: node.id, x: node.x, y: node.y };
}

function compareNodes(left: TopologyNode, right: TopologyNode): number {
  const leftLabel = typeof left.properties.label === "string" ? left.properties.label : left.id;
  const rightLabel = typeof right.properties.label === "string" ? right.properties.label : right.id;
  return leftLabel.localeCompare(rightLabel) || left.id.localeCompare(right.id);
}

function distribute(nodes: TopologyNode[], axis: "x" | "y", min: number, max: number): TopologyNodePosition[] {
  const sorted = [...nodes].sort((left, right) => left[axis] - right[axis] || compareNodes(left, right));
  const gap = (max - min) / (sorted.length - 1);
  return sorted.map((node, index) => ({
    nodeId: node.id,
    x: axis === "x" ? min + gap * index : node.x,
    y: axis === "y" ? min + gap * index : node.y,
  }));
}
