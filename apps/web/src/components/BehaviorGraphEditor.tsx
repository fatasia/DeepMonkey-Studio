/**
 * G2-S2a 行为图编辑器(最小可用编辑回路:调色板 + 表单 + 连线 + 删除 + 保存门禁)。
 *
 * 架构纪律(G2 设计稿 §2.2/§2.5,继承 G2-S1 投影纪律):
 * - 文档唯一真值仍是 `interaction.code`(restricted-graph/v1);画布状态不是真值。
 *   所有编辑 = 草案文档的纯函数变换(behaviorGraphDraft,文档进文档出)。
 * - 双通道:图页签与源码 JSON 页签编辑同一份草案文本,切换零丢失。
 * - 保存门禁:落库前过 parseRestrictedInteractionScript 全量权威校验,非法文档
 *   0 条落库;有错时保存按钮禁用并注明原因,错误一律内联呈现,不弹窗。
 * - 节点坐标是编辑器会话态(文档 schema 无坐标字段),不入真值。
 * - 本组件零新增执行语义:不新增动作/边/求值规则,白名单仲裁归 T31 校验器。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnConnectStartParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Save, Undo2 } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import {
  BEHAVIOR_GRAPH_NODE_SIZE,
  projectBehaviorGraphScript,
  type BehaviorGraphProjection,
  type ProjectedNodeKind,
} from "./behaviorGraphProjection";
import {
  BEHAVIOR_PALETTE,
  addDraftNode,
  connectIllegalReason,
  connectDraftEdge,
  defaultNodePosition,
  gateBehaviorGraphCode,
  parseDraftGraph,
  removeDraftEdge,
  removeDraftNodes,
  replaceDraftNode,
  serializeBehaviorGraph,
  snapToGrid,
  type DraftGraph,
  type DraftNode,
  type GridPoint,
} from "./behaviorGraphDraft";
import { BehaviorGraphNodeForm } from "./BehaviorGraphNodeForm";
import { ProfessionalCodeEditor } from "./ProfessionalCodeEditor";
import { BehaviorGraphView } from "./BehaviorGraphView";

const PALETTE_MIME = "application/x-bim-behavior-node";
const ISSUE_LIST_LIMIT = 12;
const EDGE_LABEL_MAX = 56;

/* ============================ 页签容器(草案 + 门禁) ============================ */

export interface BehaviorGraphEditorSectionProps {
  readonly locale: AppLocale;
  /** 已提交的脚本文本(真值)。 */
  readonly code: string;
  /** 锁定对象保持 G2-S1 只读体验(结构上无写回通道)。 */
  readonly disabled: boolean;
  /** 落库通道:仅当草案通过全量权威校验后被调用(0 条非法落库)。 */
  readonly onCommit: (code: string) => void;
}

export function BehaviorGraphEditorSection({ locale, code, disabled, onCommit }: BehaviorGraphEditorSectionProps) {
  const [tab, setTab] = useState<"graph" | "code">("graph");
  const [draftText, setDraftText] = useState(code);
  // 外部提交(AI 草案/其他入口)同步策略:本地草案未分叉时跟随真值,分叉时保留本地草案。
  const syncRef = useRef({ committed: code, draft: code });
  useEffect(() => {
    const sync = syncRef.current;
    if (code === sync.committed) return;
    if (sync.draft === sync.committed) setDraftText(code);
    sync.committed = code;
  }, [code]);
  const applyDraft = useCallback((text: string) => {
    syncRef.current.draft = text;
    setDraftText(text);
  }, []);

  const dirty = draftText !== code;
  const projection = useMemo(() => projectBehaviorGraphScript(draftText), [draftText]);
  const gate = useMemo(() => (dirty ? gateBehaviorGraphCode(draftText) : ({ ok: true } as const)), [dirty, draftText]);
  const canSave = dirty && gate.ok;
  const commit = useCallback(() => {
    if (!dirty) return;
    // 保存门禁(权威,双保险):按钮禁用是第一道,这里再全量校验一次,非法 0 条落库。
    if (!gateBehaviorGraphCode(draftText).ok) return;
    syncRef.current.draft = draftText;
    onCommit(draftText);
  }, [dirty, draftText, onCommit]);
  const discard = useCallback(() => {
    syncRef.current.draft = code;
    setDraftText(code);
  }, [code]);

  if (disabled) {
    return (
      <div className="interaction-graph-section">
        <div className="interaction-graph-tabs" role="tablist" aria-label={tr(locale, "行为图视图", "Behavior graph views")}>
          <button type="button" role="tab" aria-selected={tab === "graph"} className={tab === "graph" ? "active" : ""} onClick={() => setTab("graph")}>
            {tr(locale, "只读行为图", "Read-only graph")}
          </button>
          <button type="button" role="tab" aria-selected={tab === "code"} className={tab === "code" ? "active" : ""} onClick={() => setTab("code")}>
            {tr(locale, "源码 JSON", "JSON source")}
          </button>
        </div>
        {tab === "graph"
          ? <BehaviorGraphView code={code} locale={locale} />
          : <pre tabIndex={0} aria-label={tr(locale, "只读事件脚本", "Read-only event script")} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{code}</pre>}
      </div>
    );
  }

  return (
    <div className="interaction-graph-section" data-editor="behavior-graph">
      <div className="interaction-graph-tabs" role="tablist" aria-label={tr(locale, "行为图视图", "Behavior graph views")}>
        <button type="button" role="tab" aria-selected={tab === "graph"} className={tab === "graph" ? "active" : ""} onClick={() => setTab("graph")}>
          {tr(locale, "行为图", "Graph")}
          {dirty && <i className="behavior-dirty-dot" title={tr(locale, "有未保存更改", "Unsaved changes")} aria-label={tr(locale, "有未保存更改", "Unsaved changes")} />}
        </button>
        <button type="button" role="tab" aria-selected={tab === "code"} className={tab === "code" ? "active" : ""} onClick={() => setTab("code")}>
          {tr(locale, "源码 JSON", "JSON source")}
        </button>
      </div>
      {tab === "graph" ? (
        <ReactFlowProvider>
          <BehaviorGraphEditorCanvas
            locale={locale}
            draftText={draftText}
            projection={projection}
            dirty={dirty}
            canSave={canSave}
            gateMessage={gate.ok ? undefined : gate.message}
            onDraftChange={applyDraft}
            onCommit={commit}
            onDiscard={discard}
            onOpenCode={() => setTab("code")}
          />
        </ReactFlowProvider>
      ) : (
        <ProfessionalCodeEditor
          compact
          locale={locale}
          path="bim-studio://behavior-graph/draft.json"
          height={260}
          value={draftText}
          onChange={applyDraft}
          onSave={commit}
        />
      )}
      <small>
        {tr(
          locale,
          "图与源码 JSON 是同一份文档的两个视图;更改先存草案,保存时过全量校验门禁后才写入脚本。Del 删除选中,Ctrl+S 保存。",
          "Graph and JSON are two views of one document; edits stay as a draft until saved through the validation gate. Del deletes selection, Ctrl+S saves.",
        )}
      </small>
    </div>
  );
}

/* ================================ 画布编辑器 ================================ */

type Selection = { readonly kind: "node"; readonly id: string } | { readonly kind: "edge"; readonly index: number } | null;

interface EditorNodeData extends Record<string, unknown> {
  readonly title: string;
  readonly detail: string;
  readonly kind: ProjectedNodeKind;
  readonly issueCount: number;
  readonly issueTitles: readonly string[];
  /** 拖线进行中:本节点作为目标的非法理由(undefined = 未在拖线或合法)。 */
  readonly connectReason?: string;
  readonly connectLegal: boolean;
}

type BehaviorFlowNode = Node<EditorNodeData, "behavior">;

function EditorNodeCard({ data, selected }: NodeProps<BehaviorFlowNode>) {
  const hasIssues = data.issueCount > 0;
  const connecting = connectingActive(data);
  return (
    <div
      className={[
        "behavior-graph-card",
        `is-${data.kind}`,
        hasIssues ? "has-issues" : "",
        selected ? "is-selected" : "",
        connecting ? (data.connectLegal ? "is-connect-legal" : "is-connect-illegal") : "",
      ].filter(Boolean).join(" ")}
      title={hasIssues ? data.issueTitles.join("\n") : undefined}
    >
      {(data.kind === "condition" || data.kind === "action") && (
        <Handle
          type="target"
          position={Position.Top}
          isConnectable
          className={connecting ? (data.connectLegal ? "is-port-legal" : "is-port-invalid") : ""}
          title={connecting ? data.connectReason : undefined}
        />
      )}
      <header>
        <i />
        <span>{data.title}</span>
        {hasIssues && <strong>{data.issueCount}</strong>}
      </header>
      <p>{data.detail}</p>
      {(data.kind === "event" || data.kind === "condition") && (
        <Handle type="source" position={Position.Bottom} isConnectable className="is-port-source" />
      )}
    </div>
  );
}

function connectingActive(data: EditorNodeData): boolean {
  return data.connectReason !== undefined || data.connectLegal;
}

const EDITOR_NODE_TYPES = { behavior: EditorNodeCard } as const;

function nodeStrokeColor(kind: ProjectedNodeKind): string {
  if (kind === "event") return "#d6aa4d";
  if (kind === "condition") return "#6fa7c7";
  if (kind === "action") return "#62d493";
  return "#e27478";
}

const EMPTY_POSITIONS: ReadonlyMap<string, GridPoint> = new Map();

export interface BehaviorGraphEditorCanvasProps {
  readonly locale: AppLocale;
  readonly draftText: string;
  readonly projection: BehaviorGraphProjection;
  readonly dirty: boolean;
  readonly canSave: boolean;
  readonly gateMessage: string | undefined;
  readonly onDraftChange: (text: string) => void;
  readonly onCommit: () => void;
  readonly onDiscard: () => void;
  readonly onOpenCode: () => void;
}

function BehaviorGraphEditorCanvas({ locale, draftText, projection, dirty, canSave, gateMessage, onDraftChange, onCommit, onDiscard, onOpenCode }: BehaviorGraphEditorCanvasProps) {
  const draft = useMemo(() => parseDraftGraph(draftText), [draftText]);
  const doc = draft.graph;
  const duplicateIds = useMemo(() => {
    if (!doc) return false;
    return new Set(doc.nodes.map((node) => node.id)).size !== doc.nodes.length;
  }, [doc]);
  const broken = !doc || duplicateIds;

  const [positions, setPositions] = useState<ReadonlyMap<string, GridPoint>>(EMPTY_POSITIONS);
  const [selection, setSelection] = useState<Selection>(null);
  const [connectingFrom, setConnectingFrom] = useState<string | undefined>(undefined);
  const [hoverTargetId, setHoverTargetId] = useState<string | undefined>(undefined);
  const [ghost, setGhost] = useState<{ readonly entryId: string; readonly x: number; readonly y: number } | undefined>(undefined);
  const ghostEntryRef = useRef("");
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  const metaById = useMemo(() => new Map(projection.nodes.map((node) => [node.rfId, node])), [projection]);

  const mutate = useCallback((transform: (graph: DraftGraph) => DraftGraph) => {
    if (!doc) return;
    onDraftChange(serializeBehaviorGraph(transform(doc)));
  }, [doc, onDraftChange]);

  const addNodeAt = useCallback((entryId: string, position: GridPoint | undefined) => {
    if (!doc) return;
    const result = addDraftNode(doc, entryId);
    if (!result.nodeId || result.graph === doc) return; // 上限拒绝:理由由校验器 issue 呈现
    onDraftChange(serializeBehaviorGraph(result.graph));
    if (position) setPositions((prev) => new Map(prev).set(result.nodeId!, position));
    setSelection({ kind: "node", id: result.nodeId });
  }, [doc, onDraftChange]);

  const deleteSelection = useCallback(() => {
    if (!selection || !doc) return;
    if (selection.kind === "node") {
      const id = selection.id;
      mutate((graph) => removeDraftNodes(graph, [id]));
      setPositions((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    } else {
      const index = selection.index;
      mutate((graph) => removeDraftEdge(graph, index));
    }
    setSelection(null);
  }, [selection, doc, mutate]);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
    if ((event.key === "Delete" || event.key === "Backspace") && selection) {
      event.preventDefault();
      deleteSelection();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (canSave) onCommit();
    }
  }, [selection, deleteSelection, canSave, onCommit]);

  /* ------------------------------ 拖线(连线反馈) ------------------------------ */

  const onConnectStart = useCallback((_event: unknown, params: OnConnectStartParams) => {
    setConnectingFrom(typeof params.nodeId === "string" ? params.nodeId : undefined);
    setHoverTargetId(undefined);
  }, []);
  const onConnectEnd = useCallback(() => {
    setConnectingFrom(undefined);
    setHoverTargetId(undefined);
  }, []);
  const isValidConnection = useCallback((connection: Connection | Edge) => {
    return Boolean(doc && connection.source && connection.target && !connectIllegalReason(doc, connection.source, connection.target));
  }, [doc]);
  const onConnect = useCallback((connection: Connection) => {
    if (!doc || !connection.source || !connection.target) return;
    const result = connectDraftEdge(doc, connection.source, connection.target);
    if (result.ok) onDraftChange(serializeBehaviorGraph(result.graph));
  }, [doc, onDraftChange]);

  /* ------------------------------ 拖入(调色板) ------------------------------ */

  const onPaletteDragStart = useCallback((entryId: string) => (event: React.DragEvent) => {
    ghostEntryRef.current = entryId;
    event.dataTransfer.setData(PALETTE_MIME, entryId);
    event.dataTransfer.effectAllowed = "copy";
  }, []);
  const onCanvasDragOver = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(PALETTE_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const rect = bodyRef.current?.getBoundingClientRect();
    setGhost({ entryId: ghostEntryRef.current, x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) });
  }, []);
  const onCanvasDrop = useCallback((event: React.DragEvent) => {
    const entryId = event.dataTransfer.getData(PALETTE_MIME) || ghostEntryRef.current;
    setGhost(undefined);
    if (!entryId || !doc) return;
    event.preventDefault();
    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addNodeAt(entryId, snapToGrid(point));
  }, [doc, addNodeAt, screenToFlowPosition]);

  /* ------------------------------ 派生视图数据 ------------------------------ */

  const onNodesChange = useCallback((changes: NodeChange<BehaviorFlowNode>[]) => {
    const moved = changes.filter((change) => change.type === "position" && change.position);
    if (moved.length === 0) return;
    setPositions((prev) => {
      const next = new Map(prev);
      for (const change of moved) {
        if (change.type === "position" && change.position) next.set(change.id, change.position);
      }
      return next;
    });
  }, []);

  const flowNodes = useMemo<BehaviorFlowNode[]>(() => {
    if (!doc) return [];
    return doc.nodes.map((node) => {
      const meta = metaById.get(node.id);
      const kind: ProjectedNodeKind = meta?.kind
        ?? (node.kind === "event" || node.kind === "condition" || node.kind === "action" ? node.kind : "invalid");
      const issues = projection.nodeIssues.get(node.id) ?? [];
      const connectReason = connectingFrom ? connectIllegalReason(doc, connectingFrom, node.id) : undefined;
      return {
        id: node.id,
        type: "behavior" as const,
        position: positions.get(node.id) ?? projection.positions.get(node.id) ?? { x: 0, y: 0 },
        selected: selection?.kind === "node" && selection.id === node.id,
        data: {
          title: meta?.title ?? node.id,
          detail: meta?.detail ?? "",
          kind,
          issueCount: issues.length,
          issueTitles: issues.map((issue) => issue.message),
          ...(connectReason !== undefined ? { connectReason } : {}),
          connectLegal: connectingFrom !== undefined && connectReason === undefined && node.id !== connectingFrom,
        },
        style: { width: BEHAVIOR_GRAPH_NODE_SIZE.width, height: BEHAVIOR_GRAPH_NODE_SIZE.height },
      };
    });
  }, [doc, metaById, projection, positions, selection, connectingFrom]);

  const flowEdges = useMemo<Edge[]>(() => {
    return projection.edges.map((edge): Edge => {
      const selectedEdge = selection?.kind === "edge" && selection.index === edge.index;
      if (edge.kind === "reentry") {
        return {
          id: edge.rfId,
          source: edge.from,
          target: edge.to,
          className: "is-reentry",
          animated: true,
          selectable: false,
          label: tr(locale, "emit-event 回线", "emit-event re-entry"),
          data: { index: -1 },
        };
      }
      const flowIssues = projection.edgeIssues.get(edge.index) ?? [];
      const first = flowIssues[0];
      return {
        id: edge.rfId,
        source: edge.from,
        target: edge.to,
        className: ["is-edge", first ? "is-issue" : "", selectedEdge ? "is-selected-edge" : ""].filter(Boolean).join(" "),
        ...(first ? { label: `✕ ${first.message.slice(0, EDGE_LABEL_MAX)}` } : {}),
        selected: selectedEdge,
        data: { index: edge.index },
      };
    });
  }, [projection, selection, locale]);

  const selectedNode: DraftNode | undefined = selection?.kind === "node" ? doc?.nodes.find((node) => node.id === selection.id) : undefined;
  const hoverReason = connectingFrom && hoverTargetId && doc && hoverTargetId !== connectingFrom
    ? connectIllegalReason(doc, connectingFrom, hoverTargetId)
    : undefined;

  const issueCount = projection.issues.length;
  const listedIssues = [
    ...projection.graphIssues,
    ...[...projection.edgeIssues.values()].flat(),
    ...[...projection.nodeIssues.values()].flat(),
  ].slice(0, ISSUE_LIST_LIMIT);
  const hiddenIssues = Math.max(0, issueCount - listedIssues.length);

  const saveTitle = !dirty
    ? tr(locale, "无未保存更改", "No unsaved changes")
    : canSave
      ? tr(locale, "保存并通过全量校验门禁", "Save through the validation gate")
      : (gateMessage ?? "").slice(0, 160);

  return (
    <section
      className="behavior-graph-editor"
      aria-label={tr(locale, "行为图编辑器", "Behavior graph editor")}
      data-dirty={dirty ? "true" : "false"} data-debug-nodes={String(flowNodes.length)} data-debug-doc={doc ? doc.nodes.length : -1}
      onKeyDown={onKeyDown}
    >
      <div className="behavior-editor-status" role="status">
        {projection.parseError ? (
          // 权威校验失败的原始 message(含表达式错误等真实原因)——不得用无关兜底文案冒充。
          <span className="behavior-graph-status-item is-error">{projection.parseError}</span>
        ) : broken ? (
          <span className="behavior-graph-status-item is-error">{draft.parseError ?? tr(locale, "节点 id 重复,请在源码 JSON 中修复", "Duplicate node ids — fix in the JSON source")}</span>
        ) : issueCount > 0 ? (
          <span className="behavior-graph-status-item is-error">
            {tr(locale, "校验未通过", "Invalid")} · {tr(locale, `${issueCount} 个问题已标注在节点/边上`, `${issueCount} issues located on nodes/edges`)}
            {/* 权威 issue 明细（屏幕阅读器可达；节点卡 title 在无障碍树上不展开） */}
            <ul className="behavior-graph-issue-list">
              {projection.issues.slice(0, 8).map((issue, index) => (
                <li key={index}><code>{issue.code}</code> {issue.message} <small>({issue.path})</small></li>
              ))}
              {projection.issues.length > 8 && <li>{tr(locale, `其余 ${projection.issues.length - 8} 条同源问题…`, `${projection.issues.length - 8} more…`)}</li>}
            </ul>
          </span>
        ) : (
          <span className="behavior-graph-status-item is-valid">
            {tr(locale, "校验通过", "Valid")} · {tr(locale, "节点", "Nodes")} {projection.stats.nodeCount}/{projection.budgets.maxNodes} ·{" "}
            {tr(locale, "边", "Edges")} {projection.stats.edgeCount}/{projection.budgets.maxEdges} ·{" "}
            {tr(locale, "最长路径", "Max depth")} {projection.stats.maxDepth}/{projection.budgets.maxDepth}
          </span>
        )}
        {connectingFrom && hoverTargetId && (
          hoverReason
            ? <span className="behavior-graph-status-item is-error">✕ {hoverReason}</span>
            : <span className="behavior-graph-status-item is-valid">✓ {tr(locale, "可以连接", "Connectable")}</span>
        )}
        <span className="behavior-editor-status-actions">
          {dirty && <i className="behavior-dirty-dot" title={tr(locale, "有未保存更改", "Unsaved changes")} />}
          <button
            type="button"
            className="behavior-editor-discard"
            disabled={!dirty}
            title={!dirty ? tr(locale, "无未保存更改", "No unsaved changes") : tr(locale, "放弃未保存更改,恢复到已保存版本", "Discard unsaved changes and restore the saved version")}
            onClick={onDiscard}
          >
            <Undo2 size={11} />
            {tr(locale, "放弃更改", "Discard")}
          </button>
          <button
            type="button"
            className="behavior-editor-save"
            data-state={canSave ? "ready" : dirty ? "invalid" : "clean"}
            disabled={!canSave}
            title={saveTitle}
            onClick={onCommit}
          >
            <Save size={11} />
            {dirty ? tr(locale, "保存", "Save") : tr(locale, "已保存", "Saved")}
            <kbd>Ctrl+S</kbd>
          </button>
        </span>
      </div>

      <details className="behavior-palette" open>
        <summary>
          {tr(locale, "添加节点", "Add nodes")}
          <small>{tr(locale, "拖入画布,或点击放到默认位置", "drag into the canvas, or click to place")}</small>
        </summary>
        <div className="behavior-palette-groups">
          {(["event", "condition", "action"] as const).map((group) => (
            <div className="behavior-palette-group" key={group}>
              <span className={`is-${group}`}>
                {group === "event" ? tr(locale, "事件", "Events") : group === "condition" ? tr(locale, "条件", "Condition") : tr(locale, "动作", "Actions")}
              </span>
              <div className="behavior-palette-chips">
                {BEHAVIOR_PALETTE.filter((entry) => entry.group === group).map((entry) => (
                  <div
                    key={entry.id}
                    role="button"
                    tabIndex={0}
                    draggable
                    onDragStart={onPaletteDragStart(entry.id)}
                    onClick={() => addNodeAt(entry.id, undefined)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        addNodeAt(entry.id, undefined);
                      }
                    }}
                    title={entry.group === "event"
                      ? tr(locale, `${entry.labelZh} · 图的入口`, `${entry.labelEn} · graph entry`)
                      : entry.group === "condition"
                        ? tr(locale, `${entry.labelZh} · 真则放行下游`, `${entry.labelEn} · passes when true`)
                        : tr(locale, `${entry.labelZh} · 叶节点`, `${entry.labelEn} · leaf node`)}
                  >
                    <i className={`is-${entry.group}`} />
                    {tr(locale, entry.labelZh, entry.labelEn)}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </details>

      {listedIssues.length > 0 && !projection.parseError && !broken && (
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

      <div
        className={`behavior-editor-body${ghost ? " is-drop-target" : ""}`}
        ref={bodyRef}
        onDragOver={onCanvasDragOver}
        onDragLeave={() => setGhost(undefined)}
        onDrop={onCanvasDrop}
        onMouseOver={(event) => {
          if (!connectingFrom) return;
          const element = (event.target as HTMLElement).closest?.(".react-flow__node");
          setHoverTargetId(element?.getAttribute("data-id") ?? undefined);
        }}
      >
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={EDITOR_NODE_TYPES}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => setSelection({ kind: "node", id: node.id })}
          onPaneClick={() => setSelection(null)}
          onEdgeClick={(_, edge) => {
            const index = (edge.data as { index?: number } | undefined)?.index;
            if (typeof index === "number" && index >= 0) setSelection({ kind: "edge", index });
          }}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          fitView
          fitViewOptions={{ padding: 0.14, maxZoom: 1 }}
          minZoom={0.04}
          maxZoom={1.75}
          snapToGrid
          snapGrid={[20, 20]}
          deleteKeyCode={null}
          multiSelectionKeyCode={null}
          selectionKeyCode={null}
          nodesConnectable
          edgesReconnectable={false}
          onlyRenderVisibleElements
          defaultEdgeOptions={{ type: "smoothstep" }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#233036" />
          <MiniMap pannable zoomable className="behavior-graph-minimap" nodeColor={(node) => nodeStrokeColor((node.data as EditorNodeData).kind)} nodeStrokeWidth={2} />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
        {ghost && (
          <div className="behavior-editor-ghost" style={{ transform: `translate(${ghost.x + 10}px, ${ghost.y + 10}px)` }} aria-hidden="true">
            {paletteLabel(ghost.entryId, locale)}
          </div>
        )}
        {broken && (
          <div className="behavior-editor-broken" role="alert">
            <span>{draft.parseError ?? tr(locale, "节点 id 重复,请在源码 JSON 中修复后继续图形编辑", "Duplicate node ids — fix them in the JSON source to resume graph editing")}</span>
            <button type="button" onClick={onOpenCode}>{tr(locale, "打开源码 JSON", "Open JSON source")}</button>
          </div>
        )}
        {!broken && selectedNode && (
          <BehaviorGraphNodeForm
            locale={locale}
            node={selectedNode}
            issues={projection.nodeIssues.get(selectedNode.id) ?? []}
            onPatch={(node) => mutate((graph) => replaceDraftNode(graph, node.id, node))}
            onDelete={deleteSelection}
            onClose={() => setSelection(null)}
          />
        )}
      </div>
    </section>
  );
}

function paletteLabel(entryId: string, locale: AppLocale): string {
  const entry = BEHAVIOR_PALETTE.find((item) => item.id === entryId);
  return entry ? tr(locale, entry.labelZh, entry.labelEn) : entryId;
}
