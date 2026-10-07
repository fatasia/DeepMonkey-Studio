import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { AlertTriangle, Bell, Boxes, Database, LoaderCircle, RefreshCw, Search, Zap } from "lucide-react";
import type { OntologyGraphEdge, OntologyGraphNode, OntologyGraphNodeKind, OntologyStatus } from "@bim-studio/contracts";
import { ontologyGraphNodeId } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import OntologyGraphInspector, { type GraphSelection } from "./OntologyGraphInspector";
import {
  applyGraphFilters,
  buildGraphListCards,
  collapseNeighborhood,
  computeGraphClusters,
  computeNeighborhoodHighlight,
  computePathBetween,
  findGraphTargets,
  forceLayout,
  GRAPH_CLUSTER_THRESHOLD,
  GRAPH_COMPACT_BREAKPOINT,
  GRAPH_NODE_KIND_META,
  GRAPH_NODE_KIND_ORDER,
  GRAPH_STATUS_META,
  projectClusteredGraph,
  shouldUseCompactGraph,
  type ClusteredGraphProjection,
  type GraphFilters,
  type GraphPathHighlight,
} from "./ontologyGraphLogic";
import { api } from "../api";
import { useOntologyGraph } from "./useOntologyGraph";
import "./OntologyGraphView.css";

/**
 * H-C4-P1 本体数据图谱（数据中心"语义与本体"内的可交互业务本体图，KWeaver 风格）。
 *
 * 交互清单（方案 §4.3）：
 * - 缩放/平移/框选/节点拖拽（React Flow 视口内状态；拖拽与折叠只改视图，不写回本体契约）；
 * - 搜索定位（label/key/alias 命中 → 高亮 root→目标最短路径）+ 类型/状态筛选 + 关系类型筛选；
 * - 1—3 跳按需展开（服务端有限 BFS，禁止大图一次性加载）+ 邻域折叠 + 重置视图；
 * - 点击节点/边打开右侧检查器（属性/来源/版本/权限/证据，可追溯到契约原文）；
 * - 480px 窄屏自动切列表/路径卡片模式（不压缩成不可操作的画布）。
 * 图谱库选型：复用仓内既有 @xyflow/react（BehaviorGraphView 已在生产使用），零新增依赖；
 * 力导向为本地确定性模拟（ontologyGraphLogic.forceLayout），不引第二套布局库。
 */

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 560;
const ALL_STATUSES: readonly OntologyStatus[] = ["draft", "review", "published", "retired"];

/** 展示边 = 契约边 + LOD 聚合计数（contracts 不可扩展，本地视图型）。 */
type DisplayGraphEdge = OntologyGraphEdge & { aggregatedCount?: number };

/** MiniMap 缩略配色（展示口径常量，与 CSS 侧节点分色保持同值，参照 BehaviorGraphView 先例）。
 *  同族对齐：取值 = base.css 的 --accent/--info/--success/--danger（一处漂移即修）。 */
const MINIMAP_KIND_COLORS: Record<OntologyGraphNodeKind, string> = {
  object: "#d6aa4d",
  dataset: "#65aee8",
  action: "#59c58d",
  event: "#e27478",
};

const KIND_ICONS: Record<OntologyGraphNodeKind, typeof Boxes> = {
  object: Boxes,
  dataset: Database,
  action: Zap,
  event: Bell,
};

interface OntologyNodeData extends Record<string, unknown> {
  label: string;
  sub: string;
  kind: OntologyGraphNodeKind;
  statusText: string;
  status: OntologyStatus;
  highlighted: boolean;
  /** 2 跳次级关联（弱高亮，不描边）。 */
  secondary: boolean;
  dimmed: boolean;
  /** 簇伪节点：显示成员数徽标（LOD 聚合态）。 */
  clusterCount?: number;
  statusCounts?: Array<{ status: OntologyStatus; count: number }>;
}

type OntologyFlowNode = Node<OntologyNodeData, "ontology">;

function OntologyNodeCard({ data }: NodeProps<OntologyFlowNode>) {
  const Icon = KIND_ICONS[data.kind];
  return (
    <div className={["ontology-graph-node", GRAPH_NODE_KIND_META[data.kind].css, data.highlighted ? "is-highlighted" : "", data.secondary ? "is-secondary" : "", data.dimmed ? "is-dimmed" : ""].filter(Boolean).join(" ")}>
      {/* 四向锚点(带 id):边按两节点相对方位选左右/上下锚,消除横向节点间的大 S 弯(用户实测"布线奇怪")。 */}
      <Handle id="top" type="target" position={Position.Top} isConnectable={false} />
      <Handle id="left" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="right" type="source" position={Position.Right} isConnectable={false} />
      <header>
        <Icon size={13} />
        <span>{data.label}</span>
        {data.clusterCount !== undefined && <b className="ontology-graph-node-cluster">{data.clusterCount}</b>}
      </header>
      <small>{data.sub}</small>
      <footer>
        {/* 状态三重编码：形（CSS 几何形）+ 色（语义令牌）+ 文字，不只靠颜色 */}
        <span className={`ontology-graph-node-status ${GRAPH_STATUS_META[data.status].css}`}>
          <i className="ontology-graph-node-shape" aria-hidden="true" />
          {data.statusText}
          {data.statusCounts && data.statusCounts.length > 1 && (
            <small className="ontology-graph-node-statusmix" title={data.statusCounts.map((item) => `${item.status}×${item.count}`).join(" / ")}>
              {` +${data.statusCounts.length - 1}`}
            </small>
          )}
        </span>
      </footer>
      <Handle id="bottom" type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

const NODE_TYPES = { ontology: OntologyNodeCard } as const;

function useCompactViewport(): boolean {
  const [compact, setCompact] = useState(() => shouldUseCompactGraph(typeof window === "undefined" ? undefined : window.innerWidth));
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${GRAPH_COMPACT_BREAKPOINT}px)`);
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}

function statusWord(locale: AppLocale, status: OntologyStatus): string {
  return tr(locale,
    { draft: "草稿", review: "待评审", published: "已发布", retired: "已退役" }[status],
    { draft: "Draft", review: "In review", published: "Published", retired: "Retired" }[status],
  );
}

function nodeSubline(locale: AppLocale, node: OntologyGraphNode): string {
  if (node.kind === "action") {
    return [node.effect, node.riskLevel, node.approvalRequired ? tr(locale, "需审批", "approval") : ""].filter(Boolean).join(" · ");
  }
  if (node.kind === "object") {
    return [node.key, node.propertyCount !== undefined ? tr(locale, `${node.propertyCount} 属性`, `${node.propertyCount} props`) : ""].filter(Boolean).join(" · ");
  }
  if (node.kind === "dataset") return tr(locale, `${node.sourceCount ?? 0} 个对象消费`, `${node.sourceCount ?? 0} consumers`);
  return node.key;
}

const EDGE_KIND_WORDS: Record<OntologyGraphEdge["kind"], { zh: string; en: string }> = {
  relation: { zh: "关系", en: "Relation" },
  action: { zh: "行动绑定", en: "Action binding" },
  event: { zh: "事件触发", en: "Event trigger" },
  data: { zh: "数据来源", en: "Data source" },
};

function edgeTipLabel(edge: DisplayGraphEdge, locale: AppLocale): string {
  return `${edge.label} · ${tr(locale, EDGE_KIND_WORDS[edge.kind].zh, EDGE_KIND_WORDS[edge.kind].en)}`;
}

/** 悬停 tooltip 摘要：基数/方向/证据数/治理态（一处看全边语义，不点开检查器）。 */
function edgeTipSummary(edge: DisplayGraphEdge, locale: AppLocale): string {
  const parts: string[] = [
    edge.cardinality ?? "",
    edge.direction === "directed" ? tr(locale, "有向", "directed") : tr(locale, "无向", "undirected"),
    tr(locale, `${edge.evidenceCount} 证据`, `${edge.evidenceCount} evidence`),
    statusWord(locale, edge.status),
  ];
  if (edge.note) parts.push(edge.note);
  return parts.filter(Boolean).join(" · ");
}

function ErrorBox({ errors, locale, onRetry }: { errors: string[]; locale: AppLocale; onRetry: () => void }) {
  return (
    <div className="ontology-graph-error" role="alert">
      <AlertTriangle size={14} />
      <ul>{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>
      <button type="button" onClick={onRetry}>{tr(locale, "重试", "Retry")}</button>
    </div>
  );
}

/**
 * 480px 紧凑模式：列表/路径卡片（方案 §4.3——窄屏切列表，不压缩画布）。
 * 独立导出以便在 node 测试环境静态渲染（React Flow 画布不参与 SSR）。
 */
export function GraphListMode({ cards, locale, highlightIds, selectedId, onSelectNode, onFollow, children }: {
  cards: ReturnType<typeof buildGraphListCards>;
  locale: AppLocale;
  highlightIds: ReadonlySet<string>;
  selectedId: string | undefined;
  onSelectNode: (node: OntologyGraphNode) => void;
  onFollow: (node: OntologyGraphNode) => void;
  /** 检查器（选中后显示在列表尾部）。 */
  children?: ReactNode;
}) {
  return (
    <div className="ontology-graph-listmode">
      {cards.map((card) => (
        <article key={card.node.id} className={[GRAPH_NODE_KIND_META[card.node.kind].css, highlightIds.has(card.node.id) ? "is-highlighted" : "", selectedId === card.node.id ? "is-selected" : ""].filter(Boolean).join(" ")}>
          <button type="button" className="ontology-graph-card-head" onClick={() => onSelectNode(card.node)}>
            <strong>{card.node.label}</strong>
            <small>{tr(locale, GRAPH_NODE_KIND_META[card.node.kind].zh, GRAPH_NODE_KIND_META[card.node.kind].en)} · {statusWord(locale, card.node.status)}</small>
          </button>
          {card.neighbors.length > 0 ? (
            <ul>
              {card.neighbors.map(({ node: neighbor, edge }) => (
                <li key={`${edge.id}-${neighbor.id}`}>
                  <button type="button" onClick={() => onFollow(neighbor)}>
                    <code>{edge.label}</code>
                    <span>{neighbor.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>{tr(locale, "无邻接关系", "No adjacent relations")}</p>
          )}
        </article>
      ))}
      {children}
    </div>
  );
}

export default function OntologyGraphView({ projectId, locale, onOpenWorkspace }: {
  projectId: string;
  locale: AppLocale;
  /** 空态引导跳回"语义与本体"配置子页（不新增顶级入口）。 */
  onOpenWorkspace?: () => void;
}) {
  const state = useOntologyGraph(projectId);
  const compact = useCompactViewport();
  const [selection, setSelection] = useState<GraphSelection>(undefined);
  const [searchTerm, setSearchTerm] = useState("");
  const [highlight, setHighlight] = useState<GraphPathHighlight>();
  const [visibleIds, setVisibleIds] = useState<Set<string>>();
  const [statusFilter, setStatusFilter] = useState<ReadonlySet<string>>(new Set<string>(ALL_STATUSES));
  /** 边悬停 tooltip（关系名/基数/证据/状态），fixed 定位跟随鼠标。 */
  const [edgeTip, setEdgeTip] = useState<{ edgeId: string; x: number; y: number }>();

  // 查询结果变化（包/深度/方向/重查）后清派生视图状态，避免旧高亮/旧折叠串图。
  useEffect(() => {
    setSelection(undefined);
    setHighlight(undefined);
    setVisibleIds(undefined);
  }, [state.graph]);

  // 类型筛选：对象恒显示；数据/行动/事件由服务端 include 开关承载（类型开关即重查）。
  const filters: GraphFilters = useMemo(() => ({
    kinds: new Set<OntologyGraphNodeKind>([
      "object",
      ...(state.includeDatasets ? ["dataset" as const] : []),
      ...(state.includeActions ? ["action" as const] : []),
      ...(state.includeEvents ? ["event" as const] : []),
    ]),
    statuses: new Set<OntologyStatus>([...statusFilter].filter((item): item is OntologyStatus => (ALL_STATUSES as readonly string[]).includes(item))),
  }), [state.includeActions, state.includeDatasets, state.includeEvents, statusFilter]);

  const filtered = useMemo(() => {
    if (!state.graph) return undefined;
    const base = applyGraphFilters(state.graph, filters);
    if (!visibleIds) return base;
    const visible = new Set([...visibleIds].filter((id) => base.nodes.some((node) => node.id === id)));
    return {
      nodes: base.nodes.filter((node) => visible.has(node.id)),
      edges: base.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target)),
    };
  }, [filters, state.graph, visibleIds]);

  const rootId = state.graph ? ontologyGraphNodeId(state.graph.root.type, state.graph.root.id) : undefined;
  // 关联链路高亮：选中 → 1 跳强高亮 + 2 跳弱高亮（其余压暗），而非只亮直接邻边。
  const neighborhood = useMemo(
    () => (selection?.kind === "node" && filtered ? computeNeighborhoodHighlight(filtered.edges, selection.id) : undefined),
    [filtered, selection],
  );

  // 大图 LOD：> 阈值自动聚簇（对象按业务域，其余按类型）；簇可展开/收起。
  const clusters = useMemo(
    () => (filtered ? computeGraphClusters(filtered.nodes) : undefined),
    [filtered],
  );
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());
  useEffect(() => { setExpandedClusters(new Set()); }, [state.graph]);
  const projection = useMemo<ClusteredGraphProjection | undefined>(() => {
    if (!filtered || !clusters) return undefined;
    return projectClusteredGraph(filtered.nodes, filtered.edges, clusters, expandedClusters);
  }, [clusters, expandedClusters, filtered]);
  const displayGraph = projection ?? filtered;
  const clustered = Boolean(projection);
  /** 展示边（含聚合计数）；tooltip 数据面：id → 展示边。 */
  const displayEdges = useMemo<DisplayGraphEdge[]>(
    () => (projection ? projection.edges : filtered?.edges ?? []),
    [filtered, projection],
  );
  const edgeMetaById = useMemo(() => new Map(displayEdges.map((edge) => [edge.id, edge])), [displayEdges]);

  // 画布实测尺寸进布局:写死的 960×560 逻辑画布在宽视口里只占左侧,收敛后即使铺满
  // 逻辑画布也留右侧大片空白(用户实测"挤到一起");ResizeObserver 跟随真实容器。
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
  useEffect(() => {
    const element = canvasRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width < 100 || rect.height < 100) return;
      setCanvasSize((previous) => (Math.abs(previous.width - rect.width) < 2 && Math.abs(previous.height - rect.height) < 2
        ? previous
        : { width: Math.round(rect.width), height: Math.round(rect.height) }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const positions = useMemo(
    () => (displayGraph ? forceLayout(displayGraph.nodes.map((node) => node.id), displayGraph.edges, { width: canvasSize.width, height: canvasSize.height }) : undefined),
    [canvasSize.height, canvasSize.width, displayGraph],
  );

  const flowNodes = useMemo<OntologyFlowNode[]>(() => {
    if (!displayGraph || !positions) return [];
    return displayGraph.nodes.map((node) => {
      const isCluster = node.id.startsWith("cluster:");
      const secondary = neighborhood?.secondary.has(node.id) ?? false;
      const strong = neighborhood !== undefined && !secondary && neighborhood.nodes.has(node.id);
      const inPath = (highlight?.nodes.has(node.id) ?? false) || strong;
      const dimmed = (Boolean(highlight) && !(highlight?.nodes.has(node.id) ?? false))
        || (neighborhood !== undefined && !inPath && !secondary);
      const cluster = clusters?.find((item) => item.id === node.id);
      return {
        id: node.id,
        type: "ontology" as const,
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        // MiniMap 依赖节点声明尺寸(measure 完成前),不声明则缩略图恒空(RF12 nodeHasDimensions)
        initialWidth: 158,
        initialHeight: 64,
        data: {
          label: node.label,
          ...(isCluster
            ? {
                sub: tr(locale, `${cluster?.memberIds.length ?? 0} 成员 · 点击${expandedClusters.has(node.id) ? "收起" : "展开"}`, `${cluster?.memberIds.length ?? 0} members · click to ${expandedClusters.has(node.id) ? "collapse" : "expand"}`),
                statusText: tr(locale, "聚簇", "Cluster"),
                clusterCount: cluster?.memberIds.length ?? 0,
                ...(cluster && cluster.statusCounts.length > 0 ? { statusCounts: cluster.statusCounts } : {}),
              }
            : { sub: nodeSubline(locale, node), statusText: statusWord(locale, node.status) }),
          kind: node.kind,
          status: node.status,
          highlighted: inPath,
          secondary,
          dimmed,
        },
      };
    });
  }, [clusters, displayGraph, expandedClusters, highlight, locale, neighborhood, positions]);

  const flowEdges = useMemo<Edge[]>(() => {
    if (!displayEdges.length) return [];
    return displayEdges.map((edge) => {
      const inPath = highlight?.edges.has(edge.id) ?? (neighborhood?.edges.has(edge.id) ?? false);
      const secondary = !inPath && (neighborhood?.secondary.size ?? 0) > 0;
      const dimmed = Boolean(highlight) && !inPath;
      const className = [
        `is-kind-${edge.kind}`,
        inPath ? "is-highlight" : "",
        secondary ? "is-secondary" : "",
        dimmed ? "is-dim" : "",
      ].filter(Boolean).join(" ");
      const label = edge.aggregatedCount && edge.aggregatedCount > 1 ? `${edge.label} ×${edge.aggregatedCount}` : edge.label;
      // 方向感知锚点:横向邻接走左右锚,纵向邻接走上下锚;浅弧 bezier(低曲率)——
      // 业界关系图惯例(Neo4j Bloom/G6):小弧实线贴节点方位,不绕大弯。
      const sourcePosition = positions?.get(edge.source);
      const targetPosition = positions?.get(edge.target);
      let sourceHandle: string | undefined;
      let targetHandle: string | undefined;
      if (sourcePosition && targetPosition) {
        const dx = targetPosition.x - sourcePosition.x;
        const dy = targetPosition.y - sourcePosition.y;
        if (Math.abs(dx) >= Math.abs(dy)) {
          sourceHandle = dx >= 0 ? "right" : "left";
          targetHandle = dx >= 0 ? "left" : "right";
        } else {
          sourceHandle = dy >= 0 ? "bottom" : "top";
          targetHandle = dy >= 0 ? "top" : "bottom";
        }
      }
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(sourceHandle ? { sourceHandle } : {}),
        ...(targetHandle ? { targetHandle } : {}),
        label,
        /* 高亮用加粗实线(业界惯例),不用 animated 虚线——虚线语义是"进行中",不是"选中"。 */
        ...(className ? { className } : {}),
        ...(edge.direction === "directed" ? { markerEnd: { type: MarkerType.ArrowClosed } } : {}),
      };
    });
  }, [displayEdges, highlight, neighborhood, positions]);

  const searchTargets = useMemo(() => (state.graph ? findGraphTargets(state.graph, searchTerm) : []), [searchTerm, state.graph]);

  const focusSearchTarget = (node: OntologyGraphNode) => {
    if (!state.graph || !rootId) return;
    setHighlight(computePathBetween(state.graph, rootId, node.id));
    setSelection({ kind: "node", id: node.id });
  };

  const collapseNeighbors = (node: OntologyGraphNode) => {
    if (!filtered || !rootId) return;
    const base = visibleIds ?? new Set(filtered.nodes.map((item) => item.id));
    setVisibleIds(collapseNeighborhood(base, filtered.edges, node.id, new Set([rootId])));
  };

  const resetView = () => {
    setVisibleIds(undefined);
    setHighlight(undefined);
    setSelection(undefined);
    setSearchTerm("");
    setExpandedClusters(new Set());
    setEdgeTip(undefined);
  };

  const toggleCluster = (clusterId: string) => {
    setExpandedClusters((current) => {
      const next = new Set(current);
      if (next.has(clusterId)) next.delete(clusterId);
      else next.add(clusterId);
      return next;
    });
  };

  const toggleStatus = (status: OntologyStatus) => {
    setStatusFilter((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const selectedNode = selection?.kind === "node" ? filtered?.nodes.find((node) => node.id === selection.id) : undefined;
  const selectedEdge = selection?.kind === "edge" ? state.graph?.edges.find((edge) => edge.id === selection.id) : undefined;
  const listCards = useMemo(() => (filtered ? buildGraphListCards(filtered.nodes, filtered.edges) : []), [filtered]);

  const packageEmpty = state.selectedPackage && state.selectedPackage.objects.length === 0 && state.selectedPackage.actions.length === 0 && state.selectedPackage.events.length === 0;

  return (
    <section className="ontology-graph" aria-label={tr(locale, "本体图谱", "Ontology graph")}>
      <header className="ontology-graph-toolbar">
        <div className="ontology-graph-toolbar-row">
          <label>
            <span>{tr(locale, "本体包", "Package")}</span>
            <select value={state.selectedPackageId ?? ""} onChange={(event) => {
              // 同值守卫：重复选择当前包不得清空图谱(selectPackage 会清图,重查依赖身份不变时不会自动补跑)
              const next = event.target.value || undefined;
              if (next !== state.selectedPackageId) state.selectPackage(next);
            }}>
              <option value="">{tr(locale, "(选择本体包)", "(select a package)")}</option>
              {state.packages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <div className="ontology-graph-segmented" role="group" aria-label={tr(locale, "展开深度", "Expansion depth")}>
            {[1, 2, 3].map((value) => (
              <button key={value} type="button" className={state.depth === value ? "active" : ""} onClick={() => state.setDepth(value as 1 | 2 | 3)}>
                {value} {tr(locale, "跳", "hop")}
              </button>
            ))}
          </div>
          <label>
            <span>{tr(locale, "方向", "Direction")}</span>
            <select value={state.direction} onChange={(event) => state.setDirection(event.target.value as "out" | "in" | "both")}>
              <option value="both">{tr(locale, "双向", "Both")}</option>
              <option value="out">{tr(locale, "出边", "Out")}</option>
              <option value="in">{tr(locale, "入边", "In")}</option>
            </select>
          </label>
          <div className="ontology-graph-search">
            <Search size={13} />
            <input
              value={searchTerm}
              placeholder={tr(locale, "搜索对象/数据/行动/事件", "Search objects / data / actions / events")}
              onChange={(event) => setSearchTerm(event.target.value)}
              aria-label={tr(locale, "图谱搜索", "Graph search")}
            />
            {searchTargets.length > 0 && (
              <ul className="ontology-graph-search-results" role="listbox">
                {searchTargets.map((node) => (
                  <li key={node.id}>
                    <button type="button" onClick={() => focusSearchTarget(node)}>
                      <strong>{node.label}</strong>
                      <small>{tr(locale, GRAPH_NODE_KIND_META[node.kind].zh, GRAPH_NODE_KIND_META[node.kind].en)} · {node.key}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="button" aria-label={tr(locale, "重新查询", "Re-run query")} disabled={state.graphStatus === "loading"} onClick={() => void state.retry()}>
            <RefreshCw size={14} className={state.graphStatus === "loading" ? "spin" : ""} />
          </button>
        </div>
        <div className="ontology-graph-toolbar-row">
          <div className="ontology-graph-chips" aria-label={tr(locale, "节点类型筛选", "Node kind filters")}>
            {GRAPH_NODE_KIND_ORDER.map((kind) => {
              const Icon = KIND_ICONS[kind];
              const fixed = kind === "object";
              const on = fixed || filters.kinds.has(kind);
              const toggle = () => {
                if (fixed) return;
                if (kind === "dataset") state.setIncludeDatasets(!state.includeDatasets);
                else if (kind === "action") state.setIncludeActions(!state.includeActions);
                else state.setIncludeEvents(!state.includeEvents);
              };
              return (
                <button key={kind} type="button" className={on ? "active" : ""} disabled={fixed} onClick={toggle}>
                  <Icon size={12} />
                  {tr(locale, GRAPH_NODE_KIND_META[kind].zh, GRAPH_NODE_KIND_META[kind].en)}
                </button>
              );
            })}
          </div>
          <div className="ontology-graph-chips" aria-label={tr(locale, "状态筛选", "Status filters")}>
            {ALL_STATUSES.map((status) => (
              <button key={status} type="button" className={statusFilter.has(status) ? "active" : ""} onClick={() => toggleStatus(status)}>
                {statusWord(locale, status)}
              </button>
            ))}
          </div>
          {state.relationKeys.length > 0 && (
            <details className="ontology-graph-relations">
              <summary>
                {state.relationTypes.size === 0
                  ? tr(locale, "全部关系", "All relations")
                  : tr(locale, `已选 ${state.relationTypes.size} 类关系`, `${state.relationTypes.size} relations`)}
              </summary>
              <div className="ontology-graph-chips">
                {state.relationKeys.map((key) => (
                  <button key={key} type="button" className={state.relationTypes.has(key) ? "active" : ""} onClick={() => state.toggleRelationType(key)}>
                    {key}
                  </button>
                ))}
              </div>
            </details>
          )}
        </div>
      </header>

      {state.packagesStatus === "error" && <ErrorBox errors={state.packagesErrors} locale={locale} onRetry={() => void state.reloadPackages()} />}
      {state.graphStatus === "error" && <ErrorBox errors={state.graphErrors} locale={locale} onRetry={() => void state.retry()} />}

      {state.graph && (
        <p className="ontology-graph-statusbar" role="status">
          {tr(locale, `节点 ${filtered?.nodes.length ?? 0}/${state.graph.nodes.length} · 关系边 ${filtered?.edges.length ?? 0}/${state.graph.edges.length} · 查询耗时 ${state.graph.elapsedMs.toFixed(1)} ms · 数据时间 ${new Date(state.graph.packageUpdatedAt).toLocaleString()}`, `Nodes ${filtered?.nodes.length ?? 0}/${state.graph.nodes.length} · Edges ${filtered?.edges.length ?? 0}/${state.graph.edges.length} · Query ${state.graph.elapsedMs.toFixed(1)} ms · Data time ${new Date(state.graph.packageUpdatedAt).toLocaleString()}`)}
          {clusters && (
            <strong className="is-cluster">
              {tr(locale, `大图已聚合 ${clusters.length} 簇（阈值 ${GRAPH_CLUSTER_THRESHOLD} 节点）；点击簇卡展开成员。`, `Aggregated into ${clusters.length} clusters (threshold ${GRAPH_CLUSTER_THRESHOLD}); click a cluster card to expand.`)}
            </strong>
          )}
          {state.graph.truncated && <strong className="is-truncated">{tr(locale, "结果已按上限截断：请缩小展开深度或增加筛选。", "Truncated at limit: reduce depth or add filters.")}</strong>}
          {(visibleIds !== undefined || highlight || expandedClusters.size > 0) && (
            <button type="button" onClick={resetView}>{tr(locale, "重置视图", "Reset view")}</button>
          )}
        </p>
      )}

      {state.packagesStatus === "loading" && (
        <p role="status" className="ontology-graph-loading"><LoaderCircle size={14} className="spin" /> {tr(locale, "正在加载本体包…", "Loading ontology packages…")}</p>
      )}

      {state.packagesStatus === "ready" && state.packages.length === 0 && (
        <div className="ontology-graph-empty" role="note">
          <Boxes size={28} />
          <h3>{tr(locale, "还没有本体包", "No ontology packages yet")}</h3>
          <p>{tr(locale, "先在「语义与本体」页创建并定义对象，图谱按已定义的真实对象/关系/行动渲染——不是静态示意图。", "Create objects in the Semantics & ontology tab first; the graph renders real objects, relations and actions — never a static sketch.")}</p>
          {onOpenWorkspace && <button type="button" className="primary" onClick={onOpenWorkspace}>{tr(locale, "去定义本体", "Define ontology")}</button>}
        </div>
      )}

      {state.packagesStatus === "ready" && state.selectedPackage && packageEmpty && (
        <div className="ontology-graph-empty" role="note">
          <Boxes size={28} />
          <h3>{tr(locale, "先选择一个对象或导入对象定义", "Pick an object or import object definitions first")}</h3>
          <p>{tr(locale, "当前包内没有可入图的对象/行动/事件。", "This package has no objects, actions or events to draw.")}</p>
          {onOpenWorkspace && <button type="button" className="primary" onClick={onOpenWorkspace}>{tr(locale, "去配置对象", "Configure objects")}</button>}
        </div>
      )}

      {filtered && filtered.nodes.length === 0 && state.graphStatus === "ready" && !packageEmpty && (
        <p className="ontology-graph-empty-note" role="status">{tr(locale, "当前筛选下没有可见节点：请放宽类型/状态筛选。", "No visible nodes under current filters: relax kind/status filters.")}</p>
      )}

      {filtered && filtered.nodes.length > 0 && (
        compact ? (
          <GraphListMode
            cards={listCards}
            locale={locale}
            highlightIds={highlight?.nodes ?? new Set()}
            selectedId={selection?.kind === "node" ? selection.id : undefined}
            onSelectNode={(node) => setSelection({ kind: "node", id: node.id })}
            onFollow={focusSearchTarget}
          >
            {selection && (
              <OntologyGraphInspector
                pkg={state.selectedPackage}
                projectId={projectId}
                selection={selection}
                node={selectedNode}
                edge={selectedEdge}
                locale={locale}
                onFocusRoot={(node) => state.selectRoot(node.kind, node.key)}
                onCollapse={collapseNeighbors}
                onReset={resetView}
                previewAction={(input) => api.previewOntologyAction(projectId, input)}
              />
            )}
          </GraphListMode>
        ) : (
          <div className="ontology-graph-main">
            <div className="ontology-graph-canvas" ref={canvasRef}>
              <ReactFlow
                key={`${state.graph?.packageId ?? "none"}-${state.graph?.depth ?? 0}-${rootId ?? ""}-${canvasSize.width}x${canvasSize.height}`}
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={NODE_TYPES}
                fitView
                fitViewOptions={{ padding: 0.14, maxZoom: 1.2 }}
                minZoom={0.08}
                maxZoom={2}
                nodesConnectable={false}
                deleteKeyCode={null}
                multiSelectionKeyCode={null}
                panOnDrag={[1, 2]}
                selectionOnDrag={true}
                onlyRenderVisibleElements
                defaultEdgeOptions={{ type: "bezier" }}
                onNodeClick={(_, node) => {
                  // LOD 簇卡：点击 = 展开/收起成员，不进入检查器
                  if (node.id.startsWith("cluster:")) toggleCluster(node.id);
                  else setSelection({ kind: "node", id: node.id });
                }}
                onEdgeClick={(_, edge) => setSelection({ kind: "edge", id: edge.id })}
                onPaneClick={() => { setSelection(undefined); setEdgeTip(undefined); }}
                onEdgeMouseEnter={(event, edge) => setEdgeTip({ edgeId: edge.id, x: event.clientX, y: event.clientY })}
                onEdgeMouseMove={(event, edge) => setEdgeTip({ edgeId: edge.id, x: event.clientX, y: event.clientY })}
                onEdgeMouseLeave={() => setEdgeTip(undefined)}
              >
                <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#233036" />
                <MiniMap pannable zoomable className="ontology-graph-minimap" nodeColor={(node) => MINIMAP_KIND_COLORS[(node.data as OntologyNodeData).kind]} nodeStrokeWidth={2} />
                <Controls showInteractive={false} position="bottom-right" />
              </ReactFlow>
              {edgeTip && edgeMetaById.get(edgeTip.edgeId) && (
                <div className="ontology-graph-edge-tip" role="tooltip" style={{ left: edgeTip.x + 14, top: edgeTip.y + 12 }}>
                  <strong>{edgeTipLabel(edgeMetaById.get(edgeTip.edgeId)!, locale)}</strong>
                  <small>{edgeTipSummary(edgeMetaById.get(edgeTip.edgeId)!, locale)}</small>
                </div>
              )}
            </div>
            <OntologyGraphInspector
              pkg={state.selectedPackage}
              projectId={projectId}
              selection={selection}
              node={selectedNode}
              edge={selectedEdge}
              locale={locale}
              onFocusRoot={(node) => state.selectRoot(node.kind, node.key)}
              onCollapse={collapseNeighbors}
              onReset={resetView}
            />
          </div>
        )
      )}
    </section>
  );
}

export { statusWord };
