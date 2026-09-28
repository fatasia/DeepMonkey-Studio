/**
 * G2-S1 只读行为图视图(InteractionEditor 受限图脚本页签)。
 *
 * 纪律(G级巧架构设计-20260929.md §2.5):
 * - 本组件是行为 JSON 的只读投影:props 只有 code/locale,**刻意不提供任何写回通道**
 *   (无 onChange / 无受控变更回调 / nodesDraggable=false / nodesConnectable=false /
 *   elementsSelectable=false);拖拽、连线、删除在 UI 层被禁,画布平移缩放只改
 *   React Flow 视口内部状态,不可能触碰 interaction.code。
 * - 校验结论全部来自 validateBehaviorGraph(behaviorGraphProjection 透传),
 *   本组件只做展示与定位标注,不是仲裁者。
 */
import { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import {
  BEHAVIOR_GRAPH_NODE_SIZE,
  projectBehaviorGraphScript,
  type BehaviorGraphProjection,
  type ProjectedGraphEdge,
  type ProjectedNodeKind,
} from "./behaviorGraphProjection";

export interface BehaviorGraphViewProps {
  /** 当前行为脚本的完整文本(restricted-graph/v1);只读消费,永不写回。 */
  readonly code: string;
  readonly locale: AppLocale;
}

interface BehaviorNodeData extends Record<string, unknown> {
  readonly title: string;
  readonly detail: string;
  readonly kind: ProjectedNodeKind;
  readonly flagged: boolean;
  readonly issues: readonly string[];
}

type BehaviorFlowNode = Node<BehaviorNodeData, "behavior">;

const ISSUE_LIST_LIMIT = 12;
const EDGE_LABEL_MAX = 56;

function BehaviorNodeCard({ data }: NodeProps<BehaviorFlowNode>) {
  const hasIssues = data.issues.length > 0;
  return (
    <div
      className={[
        "behavior-graph-card",
        `is-${data.kind}`,
        hasIssues ? "has-issues" : "",
        data.flagged ? "is-flagged" : "",
      ].filter(Boolean).join(" ")}
      title={hasIssues ? data.issues.join("\n") : undefined}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <header>
        <i />
        <span>{data.title}</span>
        {hasIssues && <strong>{data.issues.length}</strong>}
      </header>
      <p>{data.detail}</p>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

const NODE_TYPES = { behavior: BehaviorNodeCard } as const;

function nodeStrokeColor(kind: ProjectedNodeKind): string {
  // MiniMap 缩略配色与节点卡语义一致(展示口径,常量与 CSS 侧保持同值)。
  if (kind === "event") return "#d6aa4d";
  if (kind === "condition") return "#6fa7c7";
  if (kind === "action") return "#62d493";
  return "#e27478";
}

function buildFlowNodes(projection: BehaviorGraphProjection): BehaviorFlowNode[] {
  const cycle = new Set(projection.cycleNodeIds);
  return projection.nodes.map((node) => {
    const issues = projection.nodeIssues.get(node.id) ?? [];
    return {
      id: node.rfId,
      type: "behavior" as const,
      position: projection.positions.get(node.rfId) ?? { x: 0, y: 0 },
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      data: {
        title: node.title,
        detail: node.detail,
        kind: node.kind,
        flagged: cycle.has(node.id),
        issues: issues.map((issue) => issue.message),
      },
      style: { width: BEHAVIOR_GRAPH_NODE_SIZE.width, height: BEHAVIOR_GRAPH_NODE_SIZE.height },
    };
  });
}

function buildFlowEdges(projection: BehaviorGraphProjection, locale: AppLocale): Edge[] {
  return projection.edges.map((edge: ProjectedGraphEdge): Edge => {
    const flowIssues = edge.kind === "flow" ? projection.edgeIssues.get(edge.index) ?? [] : [];
    const first = flowIssues[0];
    if (edge.kind === "reentry") {
      return {
        id: edge.rfId,
        source: edge.from,
        target: edge.to,
        className: "is-reentry",
        animated: true,
        label: tr(locale, "emit-event 回线", "emit-event re-entry"),
      };
    }
    return {
      id: edge.rfId,
      source: edge.from,
      target: edge.to,
      ...(first ? { className: "is-issue", label: `✕ ${first.message.slice(0, EDGE_LABEL_MAX)}` } : {}),
    };
  });
}

export function BehaviorGraphView({ code, locale }: BehaviorGraphViewProps) {
  const projection = useMemo(() => projectBehaviorGraphScript(code), [code]);
  const flowNodes = useMemo(() => buildFlowNodes(projection), [projection]);
  const flowEdges = useMemo(() => buildFlowEdges(projection, locale), [projection, locale]);
  const issueCount = projection.issues.length;
  // 清单 = 全部权威 issue(图级→边级→节点级),上限内全量可读;节点/边画布标注负责空间定位。
  const listedIssues = [
    ...projection.graphIssues,
    ...[...projection.edgeIssues.values()].flat(),
    ...[...projection.nodeIssues.values()].flat(),
  ].slice(0, ISSUE_LIST_LIMIT);
  const hiddenIssues = Math.max(0, issueCount - listedIssues.length);

  return (
    <section className="behavior-graph-view" aria-label={tr(locale, "只读行为图", "Read-only behavior graph")} data-readonly="true">
      <div className="behavior-graph-status" role="status">
        {projection.issues.length > 0 ? (
          // 校验器给出了机器可读 issue:以它为准(细粒度超集),文档级 message 不再重复渲染。
          <span className="behavior-graph-status-item is-error">
            {tr(locale, "校验未通过", "Invalid")} · {tr(locale, `${projection.issues.length} 个问题已标注在节点/边上`, `${projection.issues.length} issues located on nodes/edges`)}
          </span>
        ) : projection.parseError ? (
          // 文档级不可读(标记/JSON/schema/规模):透传权威解析器原始 message。
          <span className="behavior-graph-status-item is-error">{projection.parseError}</span>
        ) : (
          <span className="behavior-graph-status-item is-valid">
            {tr(locale, "校验通过", "Valid")} · {tr(locale, "节点", "Nodes")} {projection.stats.nodeCount}/{projection.budgets.maxNodes} ·{" "}
            {tr(locale, "边", "Edges")} {projection.stats.edgeCount}/{projection.budgets.maxEdges} ·{" "}
            {tr(locale, "最长路径", "Max depth")} {projection.stats.maxDepth}/{projection.budgets.maxDepth}
          </span>
        )}
        <span className="behavior-graph-status-item is-budget">
          {tr(
            locale,
            `预算:≤${projection.budgets.maxStepsPerDispatch.toLocaleString("en-US")} 步/派发 · ≤${projection.budgets.maxActionsPerDispatch} 动作/派发 · 重入 ≤${projection.budgets.maxEventReentryDepth} · tick 追赶 ≤${projection.budgets.maxTickCatchUp}`,
            `Budget: ≤${projection.budgets.maxStepsPerDispatch.toLocaleString("en-US")} steps/dispatch · ≤${projection.budgets.maxActionsPerDispatch} actions/dispatch · re-entry ≤${projection.budgets.maxEventReentryDepth} · tick catch-up ≤${projection.budgets.maxTickCatchUp}`,
          )}
        </span>
      </div>
      {listedIssues.length > 0 && (
        <ul className="behavior-graph-issue-list">
          {listedIssues.map((issue, index) => (
            <li key={`${issue.path}-${index}`}>
              <code>{issue.code}</code>
              <span>{issue.message}</span>
            </li>
          ))}
          {hiddenIssues > 0 && <li className="is-more">{tr(locale, `另有 ${hiddenIssues} 个问题(见节点/边标注)`, `${hiddenIssues} more (see node/edge badges)`)}</li>}
        </ul>
      )}
      <div className="behavior-graph-canvas">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
          minZoom={0.04}
          maxZoom={1.75}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          deleteKeyCode={null}
          multiSelectionKeyCode={null}
          selectionKeyCode={null}
          onlyRenderVisibleElements
          defaultEdgeOptions={{ type: "smoothstep" }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#233036" />
          <MiniMap pannable zoomable className="behavior-graph-minimap" nodeColor={(node) => nodeStrokeColor((node.data as BehaviorNodeData).kind)} nodeStrokeWidth={2} />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
      </div>
    </section>
  );
}
