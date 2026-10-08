import type { DataPipelineDefinition, DataPipelineNode } from "@bim-studio/contracts";

/** Validate a single edit; incomplete drafts remain editable until run validation. */
export function pipelineConnectionIssue(definition: DataPipelineDefinition, sourceId: string, targetId: string,
  replacedEdgeId?: string): string | undefined {
  const source = definition.nodes.find(node => node.id === sourceId);
  const target = definition.nodes.find(node => node.id === targetId);
  if (!source || !target) return "连接的节点不存在";
  if (sourceId === targetId) return "节点不能连接自身";
  if (source.type === "output") return "输出节点不能再连接下游";
  if (target.type === "source") return "数据源不能接收输入";
  const edges = definition.edges.filter(edge => edge.id !== replacedEdgeId);
  if (edges.some(edge => edge.sourceNodeId === sourceId && edge.targetNodeId === targetId)) return "这条连接已存在";
  if (target.type !== "merge" && edges.some(edge => edge.targetNodeId === targetId)) return "该节点已有输入；合并多路数据请使用合并节点";
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) outgoing.set(edge.sourceNodeId, [...(outgoing.get(edge.sourceNodeId) ?? []), edge.targetNodeId]);
  const pending = [targetId], visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === sourceId) return "这条连接会形成环路";
    if (visited.has(id)) continue;
    visited.add(id); pending.push(...(outgoing.get(id) ?? []));
  }
  return undefined;
}

export function insertPipelineNodeAfter(definition: DataPipelineDefinition, node: DataPipelineNode,
  afterNodeId?: string): DataPipelineDefinition {
  const predecessor = definition.nodes.find(item => item.id === afterNodeId && item.type !== "output")
    ?? definition.nodes.find(item => definition.edges.some(edge => edge.sourceNodeId === item.id
      && definition.nodes.some(target => target.id === edge.targetNodeId && target.type === "output")));
  const index = predecessor ? definition.nodes.indexOf(predecessor) + 1 : definition.nodes.length;
  const positioned = { ...node, position: predecessor
    ? { x: predecessor.position.x + 280, y: predecessor.position.y + (node.type === "merge" ? 140 : 100) }
    : { x: 36, y: definition.nodes.length * 100 } };
  const nodes = [...definition.nodes]; nodes.splice(index, 0, positioned);
  if (!predecessor || node.type === "merge") return { ...definition, nodes };
  const outgoing = definition.edges.filter(edge => edge.sourceNodeId === predecessor.id);
  return { ...definition, nodes, edges: [
    ...definition.edges.filter(edge => edge.sourceNodeId !== predecessor.id),
    { id: crypto.randomUUID(), sourceNodeId: predecessor.id, targetNodeId: node.id },
    ...outgoing.map(edge => ({ ...edge, sourceNodeId: node.id })),
  ] };
}

/** Splice a single-input transform out; multi-input junctions require explicit rewiring. */
export function removePipelineNode(definition: DataPipelineDefinition, id: string): DataPipelineDefinition {
  const node = definition.nodes.find(item => item.id === id);
  if (!node || node.type === "source" || node.type === "output") return definition;
  const inputs = definition.edges.filter(edge => edge.targetNodeId === id);
  const outputs = definition.edges.filter(edge => edge.sourceNodeId === id);
  let next = { ...definition, nodes: definition.nodes.filter(item => item.id !== id),
    edges: definition.edges.filter(edge => edge.sourceNodeId !== id && edge.targetNodeId !== id) };
  if (inputs.length === 1) for (const edge of outputs) {
    const sourceNodeId = inputs[0]!.sourceNodeId;
    if (!pipelineConnectionIssue(next, sourceNodeId, edge.targetNodeId)) next = { ...next,
      edges: [...next.edges, { ...edge, sourceNodeId }] };
  }
  return next;
}
