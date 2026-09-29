import type {
  OntologyGraphEdge,
  OntologyGraphQuery,
  OntologyGraphResult,
  OntologyGraphNode,
  OntologyGraphNodeKind,
  OntologyPackage,
} from "@bim-studio/contracts";
import { ontologyGraphNodeId } from "@bim-studio/contracts";

/**
 * H-C4-P1 图谱查询（有限 BFS）：把一个 OntologyPackage 投影为以 root 为中心的
 * 1—3 跳子图。纯函数，无 IO——路由层计时/包装，前端契约直接消费投影结果。
 *
 * BFS 语义：
 * - 一跳 = 一条边。关系边（对象↔对象）按 query.direction 过滤遍历方向；
 *   绑定边（行动/事件→对象、对象→数据来源）本身方向固定，但遍历始终双向可达
 *   （从行动出发能到它的绑定对象，从对象出发也能发现绑在它身上的行动）。
 * - dataset 节点是叶子（无出边），不继续展开。
 * - 同层节点按 id 排序后入队（确定性：同输入同输出，测试可断言顺序）。
 * - limit 按节点数截断：超出即 truncated=true 并停止扩张（不静默吞已入图节点）。
 * - relationTypes 过滤只作用于 relation 边。
 */

const BINDING_LABELS: Record<"action" | "event", string> = {
  action: "acts-on",
  event: "triggers-on",
};

const DATA_LABEL = "describes";

interface GraphAdjacency {
  edges: OntologyGraphEdge[];
  /** 节点 id → 关联边下标（无向邻接：BFS 两侧都能走）。 */
  incident: Map<string, number[]>;
}

/** 包 → 全量图投影（节点+边+邻接表）。节点按 kind/key 确定性排序。 */
export function buildOntologyGraphIndex(pkg: OntologyPackage): GraphAdjacency & { nodes: Map<string, OntologyGraphNode> } {
  const nodes = new Map<string, OntologyGraphNode>();
  const edges: OntologyGraphEdge[] = [];

  for (const object of pkg.objects) {
    nodes.set(ontologyGraphNodeId("object", object.key), {
      id: ontologyGraphNodeId("object", object.key),
      kind: "object",
      key: object.key,
      label: object.label || object.key,
      status: object.status,
      version: object.version,
      domain: object.domain,
      owner: object.owner,
      propertyCount: object.properties.length,
      sourceCount: object.sourceBindings.length,
      ...(object.aliases.length ? { aliases: [...object.aliases] } : {}),
    });
  }
  for (const action of pkg.actions) {
    nodes.set(ontologyGraphNodeId("action", action.key), {
      id: ontologyGraphNodeId("action", action.key),
      kind: "action",
      key: action.key,
      label: action.label || action.key,
      status: action.status,
      version: action.version,
      effect: action.effect,
      riskLevel: action.riskLevel,
      approvalRequired: action.approvalRequired,
    });
  }
  for (const event of pkg.events) {
    nodes.set(ontologyGraphNodeId("event", event.key), {
      id: ontologyGraphNodeId("event", event.key),
      kind: "event",
      key: event.key,
      label: event.label || event.key,
      status: event.status,
      version: event.version,
    });
  }

  // 数据来源节点：跨对象共享同一 sourceId 时合并为同一节点（去重）。
  const datasetObjects = new Map<string, string[]>();
  for (const object of pkg.objects) {
    for (const binding of object.sourceBindings) {
      if (binding.kind === "manual") continue; // 人工来源无外部实体，不成节点
      const list = datasetObjects.get(binding.sourceId) ?? [];
      list.push(object.key);
      datasetObjects.set(binding.sourceId, list);
    }
  }
  for (const [sourceId, objectKeys] of datasetObjects) {
    nodes.set(ontologyGraphNodeId("dataset", sourceId), {
      id: ontologyGraphNodeId("dataset", sourceId),
      kind: "dataset",
      key: sourceId,
      label: sourceId,
      status: pkg.status,
      version: pkg.version,
      sourceCount: objectKeys.length,
    });
  }

  for (const relation of pkg.relations) {
    const sourceId = ontologyGraphNodeId("object", relation.sourceObject);
    const targetId = ontologyGraphNodeId("object", relation.targetObject);
    if (!nodes.has(sourceId) || !nodes.has(targetId)) continue; // 形状校验已拦，防御式跳过
    edges.push({
      id: `rel:${relation.id}`,
      source: sourceId,
      target: targetId,
      kind: "relation",
      label: relation.key,
      direction: relation.direction,
      status: relation.status,
      cardinality: relation.cardinality,
      evidenceCount: relation.evidence.length,
      note: relation.source?.note,
      relationKey: relation.key,
    });
  }
  for (const action of pkg.actions) {
    const objectId = ontologyGraphNodeId("object", action.boundObject);
    if (!action.boundObject || !nodes.has(objectId)) continue;
    edges.push({
      id: `act:${action.id}`,
      source: ontologyGraphNodeId("action", action.key),
      target: objectId,
      kind: "action",
      label: BINDING_LABELS.action,
      direction: "directed",
      status: action.status,
      evidenceCount: 0,
    });
  }
  for (const event of pkg.events) {
    const objectId = ontologyGraphNodeId("object", event.boundObject);
    if (!event.boundObject || !nodes.has(objectId)) continue;
    edges.push({
      id: `evt:${event.id}`,
      source: ontologyGraphNodeId("event", event.key),
      target: objectId,
      kind: "event",
      label: BINDING_LABELS.event,
      direction: "directed",
      status: event.status,
      evidenceCount: 0,
    });
  }
  for (const [sourceId, objectKeys] of datasetObjects) {
    const datasetId = ontologyGraphNodeId("dataset", sourceId);
    for (const objectKey of [...new Set(objectKeys)]) {
      edges.push({
        id: `data:${datasetId}->${ontologyGraphNodeId("object", objectKey)}`,
        source: datasetId,
        target: ontologyGraphNodeId("object", objectKey),
        kind: "data",
        label: DATA_LABEL,
        direction: "directed",
        status: pkg.status,
        evidenceCount: 0,
      });
    }
  }

  const incident = new Map<string, number[]>();
  // 无向邻接表：方向语义由 traversals 裁剪，邻接发现始终双侧。
  edges.forEach((edge, index) => {
    for (const endpoint of [edge.source, edge.target]) {
      const list = incident.get(endpoint) ?? [];
      list.push(index);
      incident.set(endpoint, list);
    }
  });
  return { nodes, edges, incident };
}

/**
 * 有限 BFS 查询。root 不在图内时抛 RangeError（路由层转 400/404）。
 * truncated=true 表示 limit 截断（扩容被拒），不是错误。
 */
export function queryOntologyGraph(pkg: OntologyPackage, query: OntologyGraphQuery): Omit<OntologyGraphResult, "elapsedMs"> {
  const index = buildOntologyGraphIndex(pkg);
  const rootId = query.root.type === "object" || query.root.type === "action" || query.root.type === "event"
    ? ontologyGraphNodeId(query.root.type, query.root.id)
    : ontologyGraphNodeId("dataset", query.root.id);
  if (!index.nodes.has(rootId)) {
    throw new RangeError(`图根节点不存在：${rootId}`);
  }

  const relationFilter = query.relationTypes?.length ? new Set(query.relationTypes) : undefined;
  const direction = query.direction ?? "both";
  const includeActions = query.includeActions !== false;
  const includeEvents = query.includeEvents !== false;
  const includeDatasets = query.includeDatasets !== false;

  const allowedEdge = (edge: OntologyGraphEdge): boolean => {
    if (edge.kind === "relation") {
      if (relationFilter && !relationFilter.has(edge.relationKey ?? edge.label)) return false;
      return true;
    }
    if (edge.kind === "action") return includeActions;
    if (edge.kind === "event") return includeEvents;
    return includeDatasets;
  };

  /**
   * 遍历方向：directed 关系边按 direction 裁剪（一跳邻域默认 both=出入边都算邻居）；
   * undirected 关系边天然双向，不受 direction 过滤约束；绑定边双向。
   */
  const traversals = (nodeId: string, edge: OntologyGraphEdge): Array<{ from: string; to: string }> => {
    if (edge.kind === "relation") {
      if (edge.direction === "undirected") {
        if (edge.source === nodeId) return [{ from: nodeId, to: edge.target }];
        if (edge.target === nodeId) return [{ from: nodeId, to: edge.source }];
        return [];
      }
      if (direction === "out" && edge.source === nodeId) return [{ from: nodeId, to: edge.target }];
      if (direction === "in" && edge.target === nodeId) return [{ from: nodeId, to: edge.source }];
      if (direction === "both") {
        if (edge.source === nodeId) return [{ from: nodeId, to: edge.target }];
        if (edge.target === nodeId) return [{ from: nodeId, to: edge.source }];
      }
      return [];
    }
    if (edge.source === nodeId) return [{ from: nodeId, to: edge.target }];
    if (edge.target === nodeId) return [{ from: nodeId, to: edge.source }];
    return [];
  };

  const keptNodes = new Set<string>([rootId]);
  const keptEdges = new Set<number>();
  let frontier = [rootId];
  let truncated = false;

  for (let depth = 0; depth < query.depth; depth += 1) {
    // 确定性：同层按节点 id 排序，边按下标升序。
    const nextFrontier: string[] = [];
    for (const nodeId of [...frontier].sort((a, b) => a.localeCompare(b))) {
      const incident = index.incident.get(nodeId) ?? [];
      for (const edgeIndex of incident) {
        if (keptEdges.has(edgeIndex)) continue;
        const edge = index.edges[edgeIndex]!;
        if (!allowedEdge(edge)) continue;
        for (const step of traversals(nodeId, edge)) {
          if (!index.nodes.has(step.to)) continue;
          if (!keptNodes.has(step.to)) {
            if (keptNodes.size >= query.limit) {
              truncated = true;
              continue;
            }
            keptNodes.add(step.to);
            nextFrontier.push(step.to);
          }
          keptEdges.add(edgeIndex);
        }
      }
    }
    if (truncated) break;
    if (!nextFrontier.length) break;
    frontier = nextFrontier;
  }

  // 收尾：只保留两端都在 keptNodes 的边（root 剪枝后部分边会悬空）。
  const edges = index.edges.filter((edge, edgeIndex) => keptEdges.has(edgeIndex) && keptNodes.has(edge.source) && keptNodes.has(edge.target));
  const nodes = [...keptNodes].map((id) => index.nodes.get(id)!).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));

  return {
    packageId: pkg.id,
    packageStatus: pkg.status,
    packageVersion: pkg.version,
    packageUpdatedAt: pkg.updatedAt,
    root: { ...query.root },
    depth: query.depth,
    nodes,
    edges,
    truncated,
  };
}

/** 汇总包内图谱资产规模（工具条"全包规模"展示口径）。 */
export function summarizeOntologyGraphScale(pkg: OntologyPackage): { objects: number; relations: number; actions: number; events: number; datasets: number } {
  const datasets = new Set<string>();
  for (const object of pkg.objects) for (const binding of object.sourceBindings) if (binding.kind !== "manual") datasets.add(binding.sourceId);
  return {
    objects: pkg.objects.length,
    relations: pkg.relations.length,
    actions: pkg.actions.length,
    events: pkg.events.length,
    datasets: datasets.size,
  };
}
