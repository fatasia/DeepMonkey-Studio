import type { PlantLiteModel } from "@bim-studio/contracts";
import type { PlantLiteEdgeFlow } from "./plantLiteMaterialFlowModel";

export type PlantLiteFlowDiagramOrientation = "horizontal" | "vertical";

export interface PlantLiteFlowDiagramNode {
  id: string;
  name: string;
  displayName: string;
  kind: PlantLiteModel["nodes"][number]["kind"];
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlantLiteFlowDiagramLink {
  id: string;
  edgeIds: string[];
  fromNodeId: string;
  fromNodeName: string;
  toNodeId: string;
  toNodeName: string;
  capturedTransferCount: number;
  attribution: "exact" | "parallel-route-total";
  path: string;
  labelX: number;
  labelY: number;
  labelWidth: number;
  strokeWidth: number;
}

export interface PlantLiteFlowDiagram {
  width: number;
  height: number;
  nodes: PlantLiteFlowDiagramNode[];
  links: PlantLiteFlowDiagramLink[];
  maximumCapturedTransferCount: number;
  hasParallelRoutes: boolean;
}

interface RouteFlow {
  id: string;
  edgeIds: string[];
  fromNodeId: string;
  fromNodeName: string;
  toNodeId: string;
  toNodeName: string;
  capturedTransferCount: number;
  attribution: "exact" | "parallel-route-total";
}

interface DiagramGeometry {
  nodeWidth: number;
  nodeHeight: number;
  layerGap: number;
  rowGap: number;
  padding: number;
  minimumWidth: number;
  minimumHeight: number;
}

const HORIZONTAL: DiagramGeometry = {
  nodeWidth: 86,
  nodeHeight: 28,
  layerGap: 40,
  rowGap: 22,
  padding: 16,
  minimumWidth: 360,
  minimumHeight: 96,
};

const VERTICAL: DiagramGeometry = {
  nodeWidth: 112,
  nodeHeight: 26,
  layerGap: 24,
  rowGap: 14,
  padding: 16,
  minimumWidth: 320,
  minimumHeight: 180,
};

/** 只把已有边证据转成视觉几何；并行边按端点合并，禁止重复累计同一次转移。 */
export function buildPlantLiteMaterialFlowDiagram(
  model: PlantLiteModel,
  edgeFlows: PlantLiteEdgeFlow[],
  orientation: PlantLiteFlowDiagramOrientation,
): PlantLiteFlowDiagram {
  const routes = groupRouteFlows(edgeFlows);
  const layers = assignLayers(model, routes);
  const geometry = orientation === "horizontal" ? HORIZONTAL : VERTICAL;
  const layerCount = Math.max(0, ...layers.values()) + 1;
  const nodesByLayer = groupNodesByLayer(model, layers, layerCount);
  const maximumLayerSize = Math.max(1, ...nodesByLayer.map((nodes) => nodes.length));
  const width = orientation === "horizontal"
    ? Math.max(geometry.minimumWidth, geometry.padding * 2 + layerCount * geometry.nodeWidth + (layerCount - 1) * geometry.layerGap)
    : Math.max(geometry.minimumWidth, geometry.padding * 2 + maximumLayerSize * geometry.nodeWidth + (maximumLayerSize - 1) * geometry.rowGap);
  const height = orientation === "horizontal"
    ? Math.max(geometry.minimumHeight, geometry.padding * 2 + maximumLayerSize * geometry.nodeHeight + (maximumLayerSize - 1) * geometry.rowGap)
    : Math.max(geometry.minimumHeight, geometry.padding * 2 + layerCount * geometry.nodeHeight + (layerCount - 1) * geometry.layerGap);
  const nodes = layoutNodes(nodesByLayer, orientation, geometry, width, height);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const maximumCapturedTransferCount = Math.max(0, ...routes.map((route) => route.capturedTransferCount));
  const links = routes.flatMap((route) => {
    const from = nodeById.get(route.fromNodeId);
    const to = nodeById.get(route.toNodeId);
    if (!from || !to) return [];
    const linkGeometry = createLinkGeometry(from, to, orientation);
    return [{
      ...route,
      ...linkGeometry,
      labelWidth: Math.max(26, String(route.capturedTransferCount).length * 7 + 12),
      strokeWidth: flowStrokeWidth(route.capturedTransferCount, maximumCapturedTransferCount),
    }];
  });

  return {
    width,
    height,
    nodes,
    links,
    maximumCapturedTransferCount,
    hasParallelRoutes: routes.some((route) => route.attribution === "parallel-route-total"),
  };
}

function groupRouteFlows(edgeFlows: PlantLiteEdgeFlow[]): RouteFlow[] {
  const routes = new Map<string, RouteFlow>();
  for (const edge of edgeFlows) {
    const key = JSON.stringify([edge.fromNodeId, edge.toNodeId]);
    const count = edge.attribution === "exact"
      ? edge.capturedTransferCount ?? 0
      : edge.routeCapturedTransferCount;
    const current = routes.get(key);
    if (current) {
      current.edgeIds.push(edge.edgeId);
      current.attribution = "parallel-route-total";
      continue;
    }
    routes.set(key, {
      id: key,
      edgeIds: [edge.edgeId],
      fromNodeId: edge.fromNodeId,
      fromNodeName: edge.fromNodeName,
      toNodeId: edge.toNodeId,
      toNodeName: edge.toNodeName,
      capturedTransferCount: count,
      attribution: edge.attribution,
    });
  }
  return [...routes.values()];
}

function assignLayers(model: PlantLiteModel, routes: RouteFlow[]): Map<string, number> {
  const order = new Map(model.nodes.map((node, index) => [node.id, index]));
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(model.nodes.map((node) => [node.id, 0]));
  for (const route of routes) {
    if (!indegree.has(route.fromNodeId) || !indegree.has(route.toNodeId)) continue;
    outgoing.set(route.fromNodeId, [...(outgoing.get(route.fromNodeId) ?? []), route.toNodeId]);
    indegree.set(route.toNodeId, (indegree.get(route.toNodeId) ?? 0) + 1);
  }
  const queue = model.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const layers = new Map(model.nodes.map((node) => [node.id, 0]));
  let visited = 0;
  while (queue.length) {
    queue.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    const id = queue.shift()!;
    visited += 1;
    for (const target of outgoing.get(id) ?? []) {
      layers.set(target, Math.max(layers.get(target) ?? 0, (layers.get(id) ?? 0) + 1));
      const remaining = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
  }
  if (visited === model.nodes.length) return layers;
  return assignReachableLayers(model, outgoing);
}

function assignReachableLayers(model: PlantLiteModel, outgoing: Map<string, string[]>): Map<string, number> {
  const layers = new Map<string, number>();
  const pending = model.nodes.filter((node) => node.kind === "source").map((node) => node.id);
  for (const id of pending) layers.set(id, 0);
  while (pending.length) {
    const id = pending.shift()!;
    for (const target of outgoing.get(id) ?? []) {
      if (layers.has(target)) continue;
      layers.set(target, (layers.get(id) ?? 0) + 1);
      pending.push(target);
    }
  }
  let fallbackLayer = Math.max(0, ...layers.values()) + 1;
  for (const node of model.nodes) {
    if (!layers.has(node.id)) layers.set(node.id, fallbackLayer++);
  }
  return layers;
}

function groupNodesByLayer(model: PlantLiteModel, layers: Map<string, number>, layerCount: number) {
  const grouped: PlantLiteModel["nodes"][number][][] = Array.from({ length: layerCount }, () => []);
  for (const node of model.nodes) grouped[layers.get(node.id) ?? 0]!.push(node);
  return grouped;
}

function layoutNodes(
  grouped: PlantLiteModel["nodes"][number][][],
  orientation: PlantLiteFlowDiagramOrientation,
  geometry: DiagramGeometry,
  width: number,
  height: number,
): PlantLiteFlowDiagramNode[] {
  return grouped.flatMap((layerNodes, layer) => {
    const span = layerNodes.length * (orientation === "horizontal" ? geometry.nodeHeight : geometry.nodeWidth)
      + Math.max(0, layerNodes.length - 1) * geometry.rowGap;
    const start = ((orientation === "horizontal" ? height : width) - span) / 2;
    return layerNodes.map((node, row) => ({
      id: node.id,
      name: node.name,
      displayName: truncateName(node.name),
      kind: node.kind,
      x: orientation === "horizontal"
        ? geometry.padding + layer * (geometry.nodeWidth + geometry.layerGap)
        : start + row * (geometry.nodeWidth + geometry.rowGap),
      y: orientation === "horizontal"
        ? start + row * (geometry.nodeHeight + geometry.rowGap)
        : geometry.padding + layer * (geometry.nodeHeight + geometry.layerGap),
      width: geometry.nodeWidth,
      height: geometry.nodeHeight,
    }));
  });
}

function createLinkGeometry(from: PlantLiteFlowDiagramNode, to: PlantLiteFlowDiagramNode, orientation: PlantLiteFlowDiagramOrientation) {
  if (orientation === "horizontal") {
    const startX = from.x + from.width;
    const startY = from.y + from.height / 2;
    const endX = to.x;
    const endY = to.y + to.height / 2;
    const controlOffset = Math.max(22, Math.abs(endX - startX) * 0.5);
    return {
      path: `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`,
      labelX: (startX + endX) / 2,
      labelY: (startY + endY) / 2,
    };
  }
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height;
  const endX = to.x + to.width / 2;
  const endY = to.y;
  const controlOffset = Math.max(16, Math.abs(endY - startY) * 0.5);
  return {
    path: `M ${startX} ${startY} C ${startX} ${startY + controlOffset}, ${endX} ${endY - controlOffset}, ${endX} ${endY}`,
    labelX: (startX + endX) / 2,
    labelY: (startY + endY) / 2,
  };
}

function flowStrokeWidth(count: number, maximum: number): number {
  if (count <= 0 || maximum <= 0) return 1.5;
  return 2.5 + Math.sqrt(count / maximum) * 8.5;
}

function truncateName(name: string): string {
  const characters = Array.from(name);
  return characters.length > 8 ? `${characters.slice(0, 7).join("")}…` : name;
}
