import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import type { OntologyGraphNode, OntologyGraphNodeKind, OntologyStatus } from "@bim-studio/contracts";
import { ontologyGraphNodeId } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import OntologyGraphInspector, { type GraphSelection } from "./OntologyGraphInspector";
import {
  applyGraphFilters,
  buildGraphListCards,
  collapseNeighborhood,
  computeIncidentEdges,
  computePathBetween,
  findGraphTargets,
  forceLayout,
  GRAPH_COMPACT_BREAKPOINT,
  GRAPH_NODE_KIND_META,
  GRAPH_NODE_KIND_ORDER,
  shouldUseCompactGraph,
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

/** MiniMap 缩略配色（展示口径常量，与 CSS 侧节点分色保持同值，参照 BehaviorGraphView 先例）。 */
const MINIMAP_KIND_COLORS: Record<OntologyGraphNodeKind, string> = {
  object: "#d6aa4d",
  dataset: "#65aee8",
  action: "#62d493",
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
  dimmed: boolean;
}

type OntologyFlowNode = Node<OntologyNodeData, "ontology">;

function OntologyNodeCard({ data }: NodeProps<OntologyFlowNode>) {
  const Icon = KIND_ICONS[data.kind];
  return (
    <div className={["ontology-graph-node", GRAPH_NODE_KIND_META[data.kind].css, data.highlighted ? "is-highlighted" : "", data.dimmed ? "is-dimmed" : ""].filter(Boolean).join(" ")}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <header>
        <Icon size={13} />
        <span>{data.label}</span>
      </header>
      <small>{data.sub}</small>
      <footer>
        {/* 状态三重编码：色点 + 文字（不靠颜色单独表达） */}
        <span className={`ontology-graph-node-status is-${data.status}`}>{data.statusText}</span>
      </footer>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
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

  const positions = useMemo(
    () => (filtered ? forceLayout(filtered.nodes.map((node) => node.id), filtered.edges, { width: CANVAS_WIDTH, height: CANVAS_HEIGHT }) : undefined),
    [filtered],
  );

  const rootId = state.graph ? ontologyGraphNodeId(state.graph.root.type, state.graph.root.id) : undefined;
  const incidentHighlight = useMemo(
    () => (selection?.kind === "node" && filtered ? computeIncidentEdges(filtered.edges, selection.id) : undefined),
    [filtered, selection],
  );

  const flowNodes = useMemo<OntologyFlowNode[]>(() => {
    if (!filtered || !positions) return [];
    return filtered.nodes.map((node) => {
      const inPath = (highlight?.nodes.has(node.id) ?? false) || (incidentHighlight !== undefined && incidentHighlight.size > 0 && node.id === selection?.id);
      const dimmed = Boolean(highlight) && !(highlight?.nodes.has(node.id) ?? false);
      return {
        id: node.id,
        type: "ontology" as const,
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        data: {
          label: node.label,
          sub: nodeSubline(locale, node),
          kind: node.kind,
          status: node.status,
          statusText: statusWord(locale, node.status),
          highlighted: inPath,
          dimmed,
        },
      };
    });
  }, [filtered, highlight, incidentHighlight, locale, positions, selection]);

  const flowEdges = useMemo<Edge[]>(() => {
    if (!filtered) return [];
    return filtered.edges.map((edge) => {
      const inPath = highlight?.edges.has(edge.id) ?? (incidentHighlight?.has(edge.id) ?? false);
      const dimmed = Boolean(highlight) && !inPath;
      const className = [inPath ? "is-highlight" : "", dimmed ? "is-dim" : ""].filter(Boolean).join(" ");
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        animated: inPath,
        ...(className ? { className } : {}),
        ...(edge.direction === "directed" ? { markerEnd: { type: MarkerType.ArrowClosed } } : {}),
      };
    });
  }, [filtered, highlight, incidentHighlight]);

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
            <select value={state.selectedPackageId ?? ""} onChange={(event) => state.selectPackage(event.target.value || undefined)}>
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
          {state.graph.truncated && <strong className="is-truncated">{tr(locale, "结果已按上限截断：请缩小展开深度或增加筛选。", "Truncated at limit: reduce depth or add filters.")}</strong>}
          {(visibleIds !== undefined || highlight) && (
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
            <div className="ontology-graph-canvas">
              <ReactFlow
                key={`${state.graph?.packageId ?? "none"}-${state.graph?.depth ?? 0}-${rootId ?? ""}`}
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
                onNodeClick={(_, node) => setSelection({ kind: "node", id: node.id })}
                onEdgeClick={(_, edge) => setSelection({ kind: "edge", id: edge.id })}
                onPaneClick={() => setSelection(undefined)}
              >
                <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#233036" />
                <MiniMap pannable zoomable className="ontology-graph-minimap" nodeColor={(node) => MINIMAP_KIND_COLORS[(node.data as OntologyNodeData).kind]} nodeStrokeWidth={2} />
                <Controls showInteractive={false} position="bottom-right" />
              </ReactFlow>
            </div>
            <OntologyGraphInspector
              pkg={state.selectedPackage}
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
