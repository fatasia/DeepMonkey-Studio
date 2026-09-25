/**
 * 看板拉动（Kanban supermarket）。
 * 门控口径（刻意保持简单）：cardCount × cardQuantity 为最大在库；在库按每 cardQuantity
 * 件占一张卡，取走跨过边界即释放空卡，源只在全部相关看板有空卡时按节拍投放。
 * 在途件不计入占用，超出的件由缓冲容量反压兜底；withdrawn 仅作取走统计不参与门控。
 */

import type { PlantLiteKanbanCard, PlantLiteModel, PlantLiteNode } from "./modelTypes.js";
import type { Runtime } from "./runtimeTypes.js";

export type KanbanBufferNode = Extract<PlantLiteNode, { kind: "buffer" | "queue-buffer" }> & { kanban: PlantLiteKanbanCard };

export function isKanbanBuffer(node: PlantLiteNode): node is KanbanBufferNode {
  return (node.kind === "buffer" || node.kind === "queue-buffer") && node.kanban !== undefined;
}

/** 当前看板是否有空卡:在库按每 q 件占一张卡,取走跨过 q 边界即释放;投放重新占卡,长程不会耗尽。 */
export function kanbanAcceptsSourceArrival(runtime: Runtime, kanbanNodeIds: string[] | undefined): boolean {
  if (!kanbanNodeIds?.length) return true;
  for (const nodeId of kanbanNodeIds) {
    const node = runtime.nodeIndex.get(nodeId);
    if (!node || !isKanbanBuffer(node)) continue;
    const state = runtime.states.get(nodeId);
    if (!state) continue;
    const maxOnHand = node.kanban.cardCount * node.kanban.cardQuantity;
    const occupiedCards = Math.min(node.kanban.cardCount, Math.ceil(state.input.length / node.kanban.cardQuantity));
    if (node.kanban.cardCount - occupiedCards <= 0 || state.input.length >= maxOnHand) return false;
  }
  return true;
}

/**
 * 记一笔从在库流向下游的取走，并返回应当被拉动唤醒的 source id。
 * 只唤醒处于 armed（节拍链已被门控拦停）且此刻门控放行的源；调度由调用方执行。
 */
export function registerKanbanWithdrawal(runtime: Runtime, node: KanbanBufferNode): string[] {
  const state = runtime.states.get(node.id);
  if (state) state.withdrawn = (state.withdrawn ?? 0) + 1;
  const wake: string[] = [];
  for (const sourceId of runtime.kanbanGatedSourcesByNode.get(node.id) ?? []) {
    if (!runtime.kanbanPullArmed.has(sourceId)) continue;
    if (!kanbanAcceptsSourceArrival(runtime, runtime.kanbanGatesBySource.get(sourceId))) continue;
    runtime.kanbanPullArmed.delete(sourceId);
    wake.push(sourceId);
  }
  return wake;
}

/**
 * 推导看板门控双向索引：每个看板沿上游（出边入边 + split 路由）反查第一个 source。
 * 模型无环且非 source 节点必有入边，反查必终止于 source；防御性跳过找不到的情形。
 */
export function buildKanbanGateIndexes(
  model: PlantLiteModel,
  nodeIndex: Map<string, PlantLiteNode>,
): { gatesBySource: Map<string, string[]>; gatedSourcesByNode: Map<string, string[]> } {
  const incoming = new Map<string, string[]>();
  for (const edge of model.edges) {
    const froms = incoming.get(edge.to) ?? [];
    froms.push(edge.from);
    incoming.set(edge.to, froms);
  }
  for (const node of model.nodes) {
    if (!isSplitNode(node)) continue;
    for (const route of node.routes) {
      const froms = incoming.get(route.to) ?? [];
      froms.push(node.id);
      incoming.set(route.to, froms);
    }
  }
  const gatesBySource = new Map<string, string[]>();
  const gatedSourcesByNode = new Map<string, string[]>();
  for (const node of model.nodes) {
    if (!isKanbanBuffer(node)) continue;
    const sourceId = firstUpstreamSource(nodeIndex, incoming, node.id);
    if (!sourceId) continue;
    const gated = gatedSourcesByNode.get(node.id) ?? [];
    gated.push(sourceId);
    gatedSourcesByNode.set(node.id, gated);
    const gates = gatesBySource.get(sourceId) ?? [];
    gates.push(node.id);
    gatesBySource.set(sourceId, gates);
  }
  return { gatesBySource, gatedSourcesByNode };
}

function isSplitNode(node: PlantLiteNode): node is Extract<PlantLiteNode, { kind: "split" }> {
  return node.kind === "split";
}

function firstUpstreamSource(
  nodeIndex: Map<string, PlantLiteNode>,
  incoming: Map<string, string[]>,
  startId: string,
): string | undefined {
  const visited = new Set<string>([startId]);
  const pending = [startId];
  while (pending.length) {
    const current = pending.shift()!;
    for (const upstreamId of incoming.get(current) ?? []) {
      if (visited.has(upstreamId)) continue;
      visited.add(upstreamId);
      const upstream = nodeIndex.get(upstreamId);
      if (!upstream) continue;
      if (upstream.kind === "source") return upstream.id;
      pending.push(upstreamId);
    }
  }
  return undefined;
}
