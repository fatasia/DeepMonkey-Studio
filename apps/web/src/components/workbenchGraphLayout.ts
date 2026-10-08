import dagre from "@dagrejs/dagre";

export interface WorkbenchGraphEdge { readonly source: string; readonly target: string }
export const ONTOLOGY_NODE_SIZE = { width: 184, height: 84 } as const;

/** Positions are content coordinates; viewport resizing never relays out authored nodes. */
export function layoutWorkbenchGraph(ids: readonly string[], edges: readonly WorkbenchGraphEdge[],
  size: { width: number; height: number } = ONTOLOGY_NODE_SIZE): Map<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: "LR", nodesep: 48, ranksep: 150, marginx: 36, marginy: 36 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const id of ids) graph.setNode(id, { ...size });
  edges.forEach((edge, index) => {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target) && edge.source !== edge.target)
      graph.setEdge(edge.source, edge.target, {}, String(index));
  });
  dagre.layout(graph);
  return new Map(ids.map((id) => {
    const node = graph.node(id);
    return [id, { x: node.x - size.width / 2, y: node.y - size.height / 2 }];
  }));
}

export type GraphSide = "top" | "right" | "bottom" | "left";
export function graphEdgeSides(source: { x: number; y: number }, target: { x: number; y: number }):
  { sourceHandle: GraphSide; targetHandle: GraphSide } {
  const dx = target.x - source.x, dy = target.y - source.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0
    ? { sourceHandle: "right", targetHandle: "left" } : { sourceHandle: "left", targetHandle: "right" };
  return dy >= 0 ? { sourceHandle: "bottom", targetHandle: "top" }
    : { sourceHandle: "top", targetHandle: "bottom" };
}

/** Stable lanes for parallel and opposing relations, without changing their direction. */
export function graphEdgeLanes(edges: readonly (WorkbenchGraphEdge & { id: string })[]): Map<string, number> {
  const groups = new Map<string, Array<WorkbenchGraphEdge & { id: string }>>();
  for (const edge of edges) {
    const pair = [edge.source, edge.target].sort().join("\0");
    const group = groups.get(pair) ?? [];
    group.push(edge); groups.set(pair, group);
  }
  const lanes = new Map<string, number>();
  for (const group of groups.values()) group.forEach((edge, index) => {
    const offset = (index - (group.length - 1) / 2) * 44;
    lanes.set(edge.id, edge.source > edge.target ? -offset : offset);
  });
  return lanes;
}
