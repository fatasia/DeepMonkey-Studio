import type {
  OntologyActionRisk,
  OntologyGraphEdge,
  OntologyGraphNode,
  OntologyGraphNodeKind,
  OntologyGraphResult,
  OntologyStatus,
} from "@bim-studio/contracts";

/**
 * H-C4-P1 本体图谱纯逻辑层：分色元数据、确定性力导向布局、本地筛选、
 * 搜索定位、路径高亮、邻域折叠与 480px 紧凑卡片。
 *
 * 纪律：
 * - 全部纯函数（无 React / 无 IO），画布交互的决策逻辑在此可单测；
 * - 布局确定性：无随机数，同一输入产出同一坐标（节点位置只改视图，不写回契约）；
 * - 颜色只表达节点类型，状态必须由图标+文字（StatusBadge/文字徽标）承载。
 */

export const GRAPH_NODE_KIND_ORDER: readonly OntologyGraphNodeKind[] = ["object", "dataset", "action", "event"];

export const GRAPH_NODE_KIND_META: Record<OntologyGraphNodeKind, { css: string; zh: string; en: string }> = {
  object: { css: "is-object", zh: "对象", en: "Object" },
  dataset: { css: "is-dataset", zh: "数据", en: "Data" },
  action: { css: "is-action", zh: "行动", en: "Action" },
  event: { css: "is-event", zh: "事件", en: "Event" },
};

/** 风险级别 → 语义令牌（色 + 文字双编码；行动节点副行同时展示 effect）。 */
export function actionRiskPresentation(risk: OntologyActionRisk): { tone: "low" | "medium" | "high"; label: string } {
  switch (risk) {
    case "critical":
    case "high":
      return { tone: "high", label: risk };
    case "medium":
      return { tone: "medium", label: risk };
    default:
      return { tone: "low", label: "low" };
  }
}

export interface GraphLayoutPosition {
  x: number;
  y: number;
}

export interface GraphLayoutOptions {
  width: number;
  height: number;
  /** 迭代次数；缺省按节点数自适应（大图降迭代防卡顿）。 */
  iterations?: number;
}

function hashUnit(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0xffffffff;
}

/**
 * 确定性力导向布局：环形初始位（id 哈希定角）→ 斥力（库仑）+ 弹簧（边）+ 弱向心力，
 * 温度线性冷却。无随机源——同输入同输出，节点拖拽后位置只留在画布视口内。
 */
export function forceLayout(
  nodeIds: readonly string[],
  edges: ReadonlyArray<{ source: string; target: string }>,
  options: GraphLayoutOptions,
): Map<string, GraphLayoutPosition> {
  const { width, height } = options;
  const iterations = options.iterations ?? Math.round(Math.min(Math.max(220 - nodeIds.length * 0.9, 40), 220));
  const positions = new Map<string, GraphLayoutPosition>();
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.max(60, Math.min(width, height) * 0.36);
  for (const id of nodeIds) {
    const angle = hashUnit(id) * Math.PI * 2;
    positions.set(id, { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius });
  }
  if (nodeIds.length <= 1) return positions;

  const idList = [...nodeIds];
  const REPULSION = 26000;
  const REST_LENGTH = 150;
  const SPRING = 0.045;
  const GRAVITY = 0.015;
  const DAMPING = 0.86;
  const PAD = 46;
  const velocities = new Map<string, GraphLayoutPosition>(idList.map((id) => [id, { x: 0, y: 0 }]));
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!positions.has(edge.source) || !positions.has(edge.target)) continue;
    (adjacency.get(edge.source) ?? adjacency.set(edge.source, []).get(edge.source)!).push(edge.target);
    (adjacency.get(edge.target) ?? adjacency.set(edge.target, []).get(edge.target)!).push(edge.source);
  }

  for (let step = 0; step < iterations; step += 1) {
    const temperature = 1 - step / iterations;
    const forces = new Map<string, GraphLayoutPosition>(idList.map((id) => [id, { x: 0, y: 0 }]));
    // 斥力（全对）
    for (let i = 0; i < idList.length; i += 1) {
      for (let j = i + 1; j < idList.length; j += 1) {
        const a = positions.get(idList[i]!)!;
        const b = positions.get(idList[j]!)!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < 1) {
          dx = (hashUnit(`${idList[i]}#${step}`) - 0.5) * 2;
          dy = (hashUnit(`${idList[j]}#${step}`) - 0.5) * 2;
          distanceSquared = 1;
        }
        const force = REPULSION / distanceSquared;
        const distance = Math.sqrt(distanceSquared);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        const fa = forces.get(idList[i]!)!;
        fa.x += fx;
        fa.y += fy;
        const fb = forces.get(idList[j]!)!;
        fb.x -= fx;
        fb.y -= fy;
      }
    }
    // 弹簧（边）
    for (const [nodeId, neighbors] of adjacency) {
      for (const neighbor of neighbors) {
        if (nodeId >= neighbor) continue; // 每条边只算一次
        const a = positions.get(nodeId)!;
        const b = positions.get(neighbor)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = SPRING * (distance - REST_LENGTH);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        const fa = forces.get(nodeId)!;
        fa.x += fx;
        fa.y += fy;
        const fb = forces.get(neighbor)!;
        fb.x -= fx;
        fb.y -= fy;
      }
    }
    // 向心 + 积分（速度阻尼 + 温度）
    for (const id of idList) {
      const position = positions.get(id)!;
      const force = forces.get(id)!;
      const velocity = velocities.get(id)!;
      velocity.x = (velocity.x + force.x - (position.x - centerX) * GRAVITY) * DAMPING;
      velocity.y = (velocity.y + force.y - (position.y - centerY) * GRAVITY) * DAMPING;
      position.x = Math.min(Math.max(position.x + velocity.x * temperature, PAD), width - PAD);
      position.y = Math.min(Math.max(position.y + velocity.y * temperature, PAD), height - PAD);
    }
  }
  return positions;
}

export interface GraphFilters {
  kinds: ReadonlySet<OntologyGraphNodeKind>;
  statuses: ReadonlySet<OntologyStatus>;
}

export const ALL_GRAPH_FILTERS: GraphFilters = {
  kinds: new Set(GRAPH_NODE_KIND_ORDER),
  statuses: new Set<OntologyStatus>(["draft", "review", "published", "retired"]),
};

/** 本地筛选：隐藏未勾选类型/状态的节点与其关联边（深度/方向/关系类型走服务端重查）。 */
export function applyGraphFilters(result: OntologyGraphResult, filters: GraphFilters): { nodes: OntologyGraphNode[]; edges: OntologyGraphEdge[] } {
  const nodes = result.nodes.filter((node) => filters.kinds.has(node.kind) && filters.statuses.has(node.status));
  const visible = new Set(nodes.map((node) => node.id));
  const edges = result.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target));
  return { nodes, edges };
}

/** 搜索定位：label/key/alias 子串命中（不区分大小写），按类型序+标签序，上限 8 条。 */
export function findGraphTargets(result: OntologyGraphResult, term: string): OntologyGraphNode[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return [];
  return result.nodes
    .filter((node) => {
      if (node.label.toLowerCase().includes(needle) || node.key.toLowerCase().includes(needle)) return true;
      return (node.aliases ?? []).some((alias) => alias.toLowerCase().includes(needle));
    })
    .sort((a, b) => GRAPH_NODE_KIND_ORDER.indexOf(a.kind) - GRAPH_NODE_KIND_ORDER.indexOf(b.kind) || a.label.localeCompare(b.label))
    .slice(0, 8);
}

export interface GraphPathHighlight {
  nodes: Set<string>;
  edges: Set<string>;
}

/**
 * root → target 最短路径（BFS，同层按边序稳定）。target 不可达返回 undefined；
 * target=root 返回仅含 root。
 */
export function computePathBetween(result: OntologyGraphResult, fromId: string, toId: string): GraphPathHighlight | undefined {
  if (!result.nodes.some((node) => node.id === fromId) || !result.nodes.some((node) => node.id === toId)) return undefined;
  if (fromId === toId) return { nodes: new Set([fromId]), edges: new Set() };
  const incident = new Map<string, number[]>();
  result.edges.forEach((edge, index) => {
    for (const endpoint of [edge.source, edge.target]) (incident.get(endpoint) ?? incident.set(endpoint, []).get(endpoint)!).push(index);
  });
  const previous = new Map<string, number>();
  const visited = new Set<string>([fromId]);
  let frontier = [fromId];
  while (frontier.length && !previous.has(toId)) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      for (const edgeIndex of incident.get(nodeId) ?? []) {
        const edge = result.edges[edgeIndex]!;
        const other = edge.source === nodeId ? edge.target : edge.target === nodeId ? edge.source : nodeId;
        if (other === nodeId || visited.has(other)) continue;
        visited.add(other);
        previous.set(other, edgeIndex);
        if (other === toId) {
          frontier = [];
          break;
        }
        next.push(other);
      }
      if (!frontier.length) break;
    }
    frontier = next;
  }
  if (!previous.has(toId)) return undefined;
  const nodes = new Set<string>([toId]);
  const edges = new Set<string>();
  let cursor = toId;
  while (cursor !== fromId) {
    const edgeIndex = previous.get(cursor);
    if (edgeIndex === undefined) return undefined;
    const edge = result.edges[edgeIndex]!;
    edges.add(edge.id);
    nodes.add(edge.source);
    nodes.add(edge.target);
    cursor = edge.source === cursor ? edge.target : edge.source;
    if (cursor === toId) break; // 防御：环不死循环
  }
  nodes.add(fromId);
  return { nodes, edges };
}

/** 节点的直接关联边 id（点击节点高亮相邻边）。 */
export function computeIncidentEdges(edges: ReadonlyArray<OntologyGraphEdge>, nodeId: string): Set<string> {
  return new Set(edges.filter((edge) => edge.source === nodeId || edge.target === nodeId).map((edge) => edge.id));
}

/** 邻域折叠：隐藏 nodeId 的直接邻居（root/keep 保留），返回新的可见集。 */
export function collapseNeighborhood(visible: ReadonlySet<string>, edges: ReadonlyArray<OntologyGraphEdge>, nodeId: string, keep: ReadonlySet<string>): Set<string> {
  const next = new Set(visible);
  for (const edge of edges) {
    const other = edge.source === nodeId ? edge.target : edge.target === nodeId ? edge.source : undefined;
    if (other && other !== nodeId && !keep.has(other)) next.delete(other);
  }
  return next;
}

/** 480px 窄屏判定（方案 §4.3：窄屏切列表/路径卡片，不压缩画布）。 */
export const GRAPH_COMPACT_BREAKPOINT = 480;

export function shouldUseCompactGraph(width: number | undefined): boolean {
  return width !== undefined && width <= GRAPH_COMPACT_BREAKPOINT;
}

export interface GraphListCardNeighbor {
  node: OntologyGraphNode;
  edge: OntologyGraphEdge;
}

export interface GraphListCard {
  node: OntologyGraphNode;
  neighbors: GraphListCardNeighbor[];
}

/** 紧凑模式卡片：每个可见节点的邻居路径卡（类型序→标签序），供 480px 列表渲染。 */
export function buildGraphListCards(nodes: ReadonlyArray<OntologyGraphNode>, edges: ReadonlyArray<OntologyGraphEdge>): GraphListCard[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const neighbors = new Map<string, GraphListCardNeighbor[]>();
  for (const edge of edges) {
    for (const [self, other] of [[edge.source, edge.target], [edge.target, edge.source]] as const) {
      const otherNode = byId.get(other);
      if (!otherNode) continue;
      (neighbors.get(self) ?? neighbors.set(self, []).get(self)!).push({ node: otherNode, edge });
    }
  }
  return [...byId.values()]
    .sort((a, b) => GRAPH_NODE_KIND_ORDER.indexOf(a.kind) - GRAPH_NODE_KIND_ORDER.indexOf(b.kind) || a.label.localeCompare(b.label))
    .map((node) => ({
      node,
      neighbors: (neighbors.get(node.id) ?? []).sort((a, b) => a.node.label.localeCompare(b.node.label)),
    }));
}

/** 状态徽标文字（图谱内嵌小型徽标；完整三重编码复用 OntologyWorkspace 的 StatusBadge）。 */
export function graphStatusText(status: OntologyStatus): string {
  return { draft: "草稿", review: "待评审", published: "已发布", retired: "已退役" }[status];
}

// ---------------------------------------------------------------------------
// Semantica UI 刀1①：治理态 形+色 双编码（色=语义令牌类，形=CSS ::before 几何形）。
// 三重编码纪律：形 + 色 + 文字，色弱用户仍可辨；映射与 OntologyWorkspace/状态徽标一致。
// ---------------------------------------------------------------------------

export type GraphStatusShape = "circle" | "square" | "diamond" | "ghost";

export const GRAPH_STATUS_META: Record<OntologyStatus, { shape: GraphStatusShape; css: string; zh: string; en: string }> = {
  published: { shape: "circle", css: "is-published", zh: "已发布", en: "Published" },
  review: { shape: "diamond", css: "is-review", zh: "待评审", en: "In review" },
  draft: { shape: "square", css: "is-draft", zh: "草稿", en: "Draft" },
  retired: { shape: "ghost", css: "is-retired", zh: "已退役", en: "Retired" },
};

// ---------------------------------------------------------------------------
// Semantica UI 刀1②：关联链路高亮——选中节点亮起 1 跳强链 + 2 跳弱链，其余压暗。
// ---------------------------------------------------------------------------

export interface GraphNeighborhoodHighlight {
  /** 1 跳邻居（强高亮，含关联边）。 */
  nodes: Set<string>;
  /** 1 跳关联边 id。 */
  edges: Set<string>;
  /** 2 跳次级节点（弱高亮，只提亮不描边）。 */
  secondary: Set<string>;
}

/** 从 nodeId 出发按当前子图边做 1—2 跳 BFS（同层按边序稳定，确定性）。 */
export function computeNeighborhoodHighlight(edges: ReadonlyArray<OntologyGraphEdge>, nodeId: string, maxHops: 1 | 2 = 2): GraphNeighborhoodHighlight {
  const incident = new Map<string, Array<{ edge: OntologyGraphEdge; other: string }>>();
  for (const edge of edges) {
    for (const [self, other] of [[edge.source, edge.target], [edge.target, edge.source]] as const) {
      (incident.get(self) ?? incident.set(self, []).get(self)!).push({ edge, other });
    }
  }
  const nodes = new Set<string>([nodeId]);
  const nodeEdges = new Set<string>();
  for (const { edge, other } of incident.get(nodeId) ?? []) {
    nodes.add(other);
    nodeEdges.add(edge.id);
  }
  const secondary = new Set<string>();
  if (maxHops >= 2) {
    for (const first of nodes) {
      if (first === nodeId) continue;
      for (const { edge, other } of incident.get(first) ?? []) {
        if (!nodes.has(other)) secondary.add(other);
        nodeEdges.add(edge.id);
      }
    }
    for (const id of secondary) nodes.add(id);
  }
  return { nodes, edges: nodeEdges, secondary };
}

// ---------------------------------------------------------------------------
// Semantica UI 刀1③：大图 LOD——>阈值自动聚簇（对象按业务域、其余按类型聚合），
// 簇可展开/收起；纯投影，不改契约数据。
// ---------------------------------------------------------------------------

export const GRAPH_CLUSTER_THRESHOLD = 500;

export interface GraphCluster {
  /** 簇伪节点 id（与真实节点 id 空间隔离：`cluster:` 前缀）。 */
  id: string;
  kind: OntologyGraphNodeKind;
  key: string;
  label: string;
  memberIds: string[];
  /** 成员治理态分布（簇卡透出，聚合不掩盖状态事实）。 */
  statusCounts: Array<{ status: OntologyStatus; count: number }>;
}

/** 簇键：对象按 domain（缺省归"未分域"），数据/行动/事件按类型。确定性排序。 */
export function graphClusterKeyOf(node: OntologyGraphNode): { kind: OntologyGraphNodeKind; key: string } {
  if (node.kind === "object") return { kind: "object", key: node.domain?.trim() || "unfiled" };
  return { kind: node.kind, key: node.kind };
}

export function computeGraphClusters(
  nodes: ReadonlyArray<OntologyGraphNode>,
  threshold: number = GRAPH_CLUSTER_THRESHOLD,
): GraphCluster[] | undefined {
  if (nodes.length <= threshold) return undefined;
  const buckets = new Map<string, GraphCluster>();
  for (const node of nodes) {
    const { kind, key } = graphClusterKeyOf(node);
    const id = `cluster:${kind}:${key}`;
    const cluster = buckets.get(id) ?? {
      id, kind, key,
      label: kind === "object" ? (key === "unfiled" ? "未分域对象" : key) : GRAPH_NODE_KIND_META[kind].zh,
      memberIds: [],
      statusCounts: [],
    };
    cluster.memberIds.push(node.id);
    const slot = cluster.statusCounts.find((item) => item.status === node.status);
    if (slot) slot.count += 1;
    else cluster.statusCounts.push({ status: node.status, count: 1 });
    buckets.set(id, cluster);
  }
  return [...buckets.values()]
    .map((cluster) => ({ ...cluster, statusCounts: cluster.statusCounts.sort((a, b) => b.count - a.count || a.status.localeCompare(b.status)) }))
    .sort((a, b) => b.memberIds.length - a.memberIds.length || a.id.localeCompare(b.id));
}

export interface ClusteredGraphProjection {
  /** 展示节点：收起簇 → 簇伪节点；展开簇 → 成员原节点。 */
  nodes: OntologyGraphNode[];
  /** 展示边：端点重映射到簇伪节点，重映射后去重聚合计数（contracts 不可扩展，本地视图型）。 */
  edges: Array<OntologyGraphEdge & { aggregatedCount?: number }>;
  /** 成员节点 id → 簇 id（收起成员不可见时用）。 */
  clusterOf: Map<string, string>;
  clusters: GraphCluster[];
}

/** 簇伪节点：label 带成员数，version 取 0（展示口径），status 取成员主态。 */
function clusterNodeOf(cluster: GraphCluster): OntologyGraphNode {
  const dominant = cluster.statusCounts[0]?.status ?? "draft";
  return {
    id: cluster.id,
    kind: cluster.kind,
    key: cluster.id,
    label: `${cluster.label} · ${cluster.memberIds.length}`,
    status: dominant,
    version: 0,
    propertyCount: cluster.memberIds.length,
  };
}

export function projectClusteredGraph(
  nodes: ReadonlyArray<OntologyGraphNode>,
  edges: ReadonlyArray<OntologyGraphEdge>,
  clusters: ReadonlyArray<GraphCluster>,
  expandedClusterIds: ReadonlySet<string>,
): ClusteredGraphProjection {
  const clusterOf = new Map<string, string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const displayNodes: OntologyGraphNode[] = [];
  for (const cluster of clusters) {
    const expanded = expandedClusterIds.has(cluster.id);
    for (const memberId of cluster.memberIds) clusterOf.set(memberId, cluster.id);
    if (expanded) {
      for (const memberId of cluster.memberIds) {
        const member = byId.get(memberId);
        if (member) displayNodes.push(member);
      }
    } else {
      displayNodes.push(clusterNodeOf(cluster));
    }
  }
  // 边端点重映射：可见成员保持原 id，收起成员指向其簇；再去重聚合计数。
  const visible = new Set(displayNodes.map((node) => node.id));
  const remap = (endpoint: string): string => (visible.has(endpoint) ? endpoint : clusterOf.get(endpoint) ?? endpoint);
  const merged = new Map<string, OntologyGraphEdge & { aggregatedCount?: number }>();
  for (const edge of edges) {
    const source = remap(edge.source);
    const target = remap(edge.target);
    if (source === target) continue; // 簇内边在收起态不占画布
    const key = `${source}->${target}|${edge.kind}|${edge.label}`;
    const existing = merged.get(key);
    if (existing) {
      merged.set(key, { ...existing, evidenceCount: (existing.evidenceCount ?? 0) + (edge.evidenceCount ?? 0), aggregatedCount: (existing.aggregatedCount ?? 1) + 1 });
    } else {
      merged.set(key, { ...edge, source, target, aggregatedCount: 1 });
    }
  }
  return { nodes: displayNodes, edges: [...merged.values()], clusterOf, clusters: [...clusters] };
}
