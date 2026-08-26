import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Box, Cable, Check, CircleDot, CloudUpload, Cpu, Database, Gauge, LayoutDashboard, Link2, MousePointer2, Plus, Redo2, Save, Trash2, Undo2, Workflow, X } from "lucide-react";
import type { TopologyDocument, TopologyNode } from "@bim-studio/contracts";
import {
  applyTopologyEditorAction,
  canRedoTopologyEdit,
  canUndoTopologyEdit,
  createTopologyEdge,
  createTopologyEditorState,
  createTopologyNode,
  topologyNodeDataBinding,
  topologyNodeLabel,
  type TopologyDataBindingRef,
  type TopologyEditorAction,
  type TopologyEditorState
} from "@bim-studio/studio-core";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import "./TopologyEditorPanel.css";

export interface TopologyDataProductOption {
  readonly id: string;
  readonly type: "dataset" | "pipeline";
  readonly name: string;
  readonly fields?: readonly string[];
}

export interface TopologyEditorPanelProps {
  readonly locale: AppLocale;
  readonly document: TopologyDocument;
  readonly dataProducts?: readonly TopologyDataProductOption[];
  readonly onChange: (document: TopologyDocument) => void;
  readonly dirty?: boolean;
  readonly busy?: boolean;
  readonly autoSaveEnabled?: boolean;
  readonly onAutoSaveChange?: (enabled: boolean) => void;
  readonly onSave?: () => void;
  readonly onPublish?: () => void;
  readonly onInsertDashboard?: () => void;
  readonly onClose?: () => void;
  readonly onError?: (message: string) => void;
}

type Tool = "select" | "connect";
type NodePreset = { readonly kind: string; readonly labelZh: string; readonly labelEn: string; readonly icon: typeof Box };

const NODE_WIDTH = 164;
const NODE_HEIGHT = 68;
const CANVAS_WIDTH = 1600;
const CANVAS_HEIGHT = 1000;
const GRID_SIZE = 16;

const NODE_PRESETS: readonly NodePreset[] = [
  { kind: "device", labelZh: "通用设备", labelEn: "Device", icon: Box },
  { kind: "controller", labelZh: "控制器", labelEn: "Controller", icon: Cpu },
  { kind: "sensor", labelZh: "传感器", labelEn: "Sensor", icon: Gauge },
  { kind: "gateway", labelZh: "边缘网关", labelEn: "Gateway", icon: Cable }
];

export function TopologyEditorPanel({ locale, document, dataProducts = [], onChange, dirty = false, busy = false, autoSaveEnabled = false, onAutoSaveChange, onSave, onPublish, onInsertDashboard, onClose, onError }: TopologyEditorPanelProps) {
  const [editor, setEditor] = useState<TopologyEditorState>(() => createTopologyEditorState(document));
  const editorRef = useRef(editor);
  const [tool, setTool] = useState<Tool>("select");
  const [connectionSourceId, setConnectionSourceId] = useState<string>();
  const [drag, setDrag] = useState<{ pointerId: number; nodeId: string; offsetX: number; offsetY: number }>();
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number }>();
  const [operationError, setOperationError] = useState<string>();
  const canvasRef = useRef<HTMLDivElement>(null);
  const markerId = `topology-arrow-${useId().replaceAll(":", "")}`;

  useEffect(() => {
    const next = createTopologyEditorState(document);
    editorRef.current = next;
    setEditor(next);
    setConnectionSourceId(undefined);
  }, [document.id]);

  const selection = editor.selection[0];
  const selectedNode = selection?.kind === "node" ? editor.document.nodes.find((node) => node.id === selection.id) : undefined;
  const selectedEdge = selection?.kind === "edge" ? editor.document.edges.find((edge) => edge.id === selection.id) : undefined;
  const binding = selectedNode ? topologyNodeDataBinding(selectedNode) : undefined;
  const selectedProduct = binding ? dataProducts.find((product) => product.type === binding.productType && product.id === binding.productId) : undefined;
  const edgeGeometry = useMemo(() => editor.document.edges.map((edge) => {
    const source = editor.document.nodes.find((node) => node.id === edge.sourceNodeId);
    const target = editor.document.nodes.find((node) => node.id === edge.targetNodeId);
    return source && target ? { edge, source, target } : undefined;
  }).filter((item): item is NonNullable<typeof item> => Boolean(item)), [editor.document]);

  function dispatch(action: TopologyEditorAction) {
    try {
      const current = editorRef.current;
      const next = applyTopologyEditorAction(current, action);
      if (next === current) return;
      setOperationError(undefined);
      editorRef.current = next;
      setEditor(next);
      if (next.document !== current.document) onChange(next.document);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setOperationError(message);
      onError?.(message);
    }
  }

  function addNode(preset: NodePreset) {
    const index = editor.document.nodes.length;
    const x = 120 + (index % 4) * 220;
    const y = 120 + Math.floor(index / 4) * 150;
    const node = createTopologyNode(crypto.randomUUID(), preset.kind, x, y, locale === "zh-CN" ? preset.labelZh : preset.labelEn);
    dispatch({ type: "node.add", node });
    dispatch({ type: "selection.set", selection: [{ kind: "node", id: node.id }] });
  }

  function selectNode(nodeId: string) {
    if (tool !== "connect") {
      dispatch({ type: "selection.set", selection: [{ kind: "node", id: nodeId }] });
      return;
    }
    if (!connectionSourceId) {
      setConnectionSourceId(nodeId);
      dispatch({ type: "selection.set", selection: [{ kind: "node", id: nodeId }] });
      return;
    }
    if (connectionSourceId === nodeId) {
      setConnectionSourceId(undefined);
      return;
    }
    dispatch({ type: "edge.add", edge: createTopologyEdge(crypto.randomUUID(), connectionSourceId, nodeId) });
    setConnectionSourceId(undefined);
  }

  function selectTool(next: Tool) {
    setTool(next);
    if (next !== "connect") setConnectionSourceId(undefined);
  }

  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>, node: TopologyNode) {
    if (tool !== "select" || event.button !== 0) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      pointerId: event.pointerId,
      nodeId: node.id,
      offsetX: event.clientX - rect.left - node.x,
      offsetY: event.clientY - rect.top - node.y
    });
    setDragPosition({ x: node.x, y: node.y });
    dispatch({ type: "selection.set", selection: [{ kind: "node", id: node.id }] });
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = snap(Math.max(24, Math.min(CANVAS_WIDTH - NODE_WIDTH - 24, event.clientX - rect.left - drag.offsetX)));
    const y = snap(Math.max(24, Math.min(CANVAS_HEIGHT - NODE_HEIGHT - 24, event.clientY - rect.top - drag.offsetY)));
    setDragPosition({ x, y });
  }

  function endDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (dragPosition) dispatch({ type: "node.move", positions: [{ nodeId: drag.nodeId, ...dragPosition }] });
    setDrag(undefined);
    setDragPosition(undefined);
  }

  function removeSelection() {
    if (!selection) return;
    if (selection.kind === "node") dispatch({ type: "node.remove", nodeIds: [selection.id] });
    else dispatch({ type: "edge.remove", edgeIds: [selection.id] });
  }

  function handleKeyboard(event: ReactKeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === "z") {
      event.preventDefault();
      dispatch({ type: event.shiftKey ? "history.redo" : "history.undo" });
    } else if (command && event.key.toLowerCase() === "y") {
      event.preventDefault();
      dispatch({ type: "history.redo" });
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removeSelection();
    } else if (event.key === "Escape") {
      setConnectionSourceId(undefined);
      selectTool("select");
    }
  }

  function setBindingProduct(value: string) {
    if (!selectedNode) return;
    if (!value) {
      dispatch({ type: "binding.set", nodeId: selectedNode.id });
      return;
    }
    const [productType, ...idParts] = value.split(":");
    if (productType !== "dataset" && productType !== "pipeline") return;
    const productId = idParts.join(":");
    const product = dataProducts.find((candidate) => candidate.type === productType && candidate.id === productId);
    const next: TopologyDataBindingRef = { productType, productId, field: product?.fields?.[0] ?? "" };
    dispatch({ type: "binding.set", nodeId: selectedNode.id, binding: next });
  }

  return <section className="topology-editor" tabIndex={0} onKeyDown={handleKeyboard} aria-label={tr(locale, "拓扑编辑器", "Topology editor")}>
    <header className="topology-editor__header">
      <div className="topology-editor__title">
        <span className="topology-editor__mark"><Workflow size={18} /></span>
        <span><strong>{editor.document.name}</strong><small>{tr(locale, "独立拓扑 · 数据驱动", "Topology · Data driven")}</small></span>
      </div>
      <div className="topology-editor__tools" role="toolbar" aria-label={tr(locale, "编辑工具", "Editor tools")}>
        <button className={tool === "select" ? "is-active" : ""} onClick={() => selectTool("select")} title={tr(locale, "选择 (V)", "Select (V)")}><MousePointer2 size={15} /></button>
        <button className={tool === "connect" ? "is-active" : ""} onClick={() => selectTool("connect")} title={tr(locale, "创建连线", "Connect nodes")}><Link2 size={15} /></button>
        <span className="topology-editor__divider" />
        <button disabled={!canUndoTopologyEdit(editor)} onClick={() => dispatch({ type: "history.undo" })} title={tr(locale, "撤销 Ctrl+Z", "Undo Ctrl+Z")}><Undo2 size={15} /></button>
        <button disabled={!canRedoTopologyEdit(editor)} onClick={() => dispatch({ type: "history.redo" })} title={tr(locale, "重做 Ctrl+Y", "Redo Ctrl+Y")}><Redo2 size={15} /></button>
        <button disabled={!selection} onClick={removeSelection} title={tr(locale, "删除", "Delete")}><Trash2 size={15} /></button>
      </div>
      <div className="topology-editor__actions">
        {onAutoSaveChange && <label><input type="checkbox" checked={autoSaveEnabled} onChange={(event) => onAutoSaveChange(event.target.checked)} />{tr(locale, "自动保存", "Auto save")}</label>}
        {onInsertDashboard && <button onClick={onInsertDashboard}><LayoutDashboard size={14} />{tr(locale, "插入看板", "Insert into dashboard")}</button>}
        {onSave && <button disabled={!dirty || busy} onClick={onSave}><Save size={14} />{tr(locale, "保存", "Save")}</button>}
        {onPublish && <button className="primary" disabled={busy} onClick={onPublish}><CloudUpload size={14} />{tr(locale, "发布", "Publish")}</button>}
      </div>
      <div className={`topology-editor__sync ${dirty ? "dirty" : ""}`}><Check size={13} />{dirty ? tr(locale, "有未保存修改", "Unsaved changes") : tr(locale, "所有修改已保存", "All changes saved")}</div>
      {onClose && <button className="topology-editor__close" onClick={onClose} aria-label={tr(locale, "关闭", "Close")}><X size={17} /></button>}
    </header>

    <aside className="topology-editor__palette">
      <div className="topology-editor__section-title"><span>{tr(locale, "节点库", "Node library")}</span><small>{NODE_PRESETS.length}</small></div>
      <div className="topology-editor__presets">
        {NODE_PRESETS.map((preset) => <button key={preset.kind} onClick={() => addNode(preset)}>
          <span><preset.icon size={17} /></span>
          <span><strong>{locale === "zh-CN" ? preset.labelZh : preset.labelEn}</strong><small>{preset.kind}</small></span>
          <Plus size={14} />
        </button>)}
      </div>
      <div className="topology-editor__hint"><CircleDot size={14} /><span>{tr(locale, "节点描述关系与状态，不执行网络或物理仿真。", "Nodes describe relationships and state; no network or physics simulation runs here.")}</span></div>
    </aside>

    <main className={`topology-editor__viewport ${tool === "connect" ? "is-connecting" : ""}`}>
      <div className="topology-editor__canvas" ref={canvasRef} style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }} onClick={() => dispatch({ type: "selection.set", selection: [] })}>
        <svg className="topology-editor__edges" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} aria-hidden="true">
          <defs><marker id={markerId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
          {edgeGeometry.map(({ edge, source, target }) => {
            const selected = selection?.kind === "edge" && selection.id === edge.id;
            const x1 = source.x + NODE_WIDTH;
            const y1 = source.y + NODE_HEIGHT / 2;
            const x2 = target.x;
            const y2 = target.y + NODE_HEIGHT / 2;
            const curve = Math.max(70, Math.abs(x2 - x1) * 0.45);
            const path = `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`;
            return <g key={edge.id} className={selected ? "is-selected" : ""} onClick={(event) => { event.stopPropagation(); dispatch({ type: "selection.set", selection: [{ kind: "edge", id: edge.id }] }); }}>
              <path className="topology-editor__edge-hit" d={path} />
              <path className="topology-editor__edge-line" d={path} markerEnd={`url(#${markerId})`} />
            </g>;
          })}
        </svg>
        {editor.document.nodes.map((node) => {
          const selected = selection?.kind === "node" && selection.id === node.id;
          const connecting = connectionSourceId === node.id;
          const nodeBinding = topologyNodeDataBinding(node);
          const position = drag?.nodeId === node.id && dragPosition ? dragPosition : node;
          const Icon = NODE_PRESETS.find((preset) => preset.kind === node.kind)?.icon ?? Box;
          return <button key={node.id} className={`topology-editor__node ${selected ? "is-selected" : ""} ${connecting ? "is-source" : ""}`} style={{ left: position.x, top: position.y }}
            onClick={(event) => { event.stopPropagation(); selectNode(node.id); }}
            onPointerDown={(event) => beginDrag(event, node)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
            <span className="topology-editor__port topology-editor__port--in" />
            <span className="topology-editor__node-icon"><Icon size={18} /></span>
            <span className="topology-editor__node-copy"><strong>{topologyNodeLabel(node)}</strong><small>{node.kind}</small></span>
            {nodeBinding && <span className="topology-editor__binding-dot" title={tr(locale, "已绑定数据", "Data bound")}><Database size={11} /></span>}
            <span className="topology-editor__port topology-editor__port--out" />
          </button>;
        })}
        {editor.document.nodes.length === 0 && <div className="topology-editor__empty"><span><Workflow size={24} /></span><strong>{tr(locale, "从左侧添加第一个节点", "Add the first node from the library")}</strong><small>{tr(locale, "设备关系保持轻量，并可直接绑定数据中台产品。", "Keep relationships lightweight and bind data products directly.")}</small></div>}
      </div>
      {tool === "connect" && <div className="topology-editor__mode-tip">{connectionSourceId ? tr(locale, "选择目标节点，Esc 取消", "Choose a target node, Esc to cancel") : tr(locale, "选择连线起点", "Choose a source node")}</div>}
      {operationError && <button className="topology-editor__error" onClick={() => setOperationError(undefined)}><span>{operationError}</span><X size={13} /></button>}
    </main>

    <aside className="topology-editor__inspector">
      <div className="topology-editor__section-title"><span>{tr(locale, "属性", "Inspector")}</span>{selection && <small>{selection.kind === "node" ? tr(locale, "节点", "Node") : tr(locale, "连线", "Edge")}</small>}</div>
      {selectedNode && <div className="topology-editor__form">
        <InspectorTextField label={tr(locale, "名称", "Name")} value={topologyNodeLabel(selectedNode)} onCommit={(label) => dispatch({ type: "node.update", nodeId: selectedNode.id, patch: { properties: { ...selectedNode.properties, label } } })} />
        <InspectorTextField label={tr(locale, "类型", "Type")} value={selectedNode.kind} onCommit={(kind) => dispatch({ type: "node.update", nodeId: selectedNode.id, patch: { kind } })} />
        <div className="topology-editor__coordinates"><InspectorNumberField label="X" value={selectedNode.x} onCommit={(x) => dispatch({ type: "node.move", positions: [{ nodeId: selectedNode.id, x, y: selectedNode.y }] })} /><InspectorNumberField label="Y" value={selectedNode.y} onCommit={(y) => dispatch({ type: "node.move", positions: [{ nodeId: selectedNode.id, x: selectedNode.x, y }] })} /></div>
        <div className="topology-editor__form-divider" />
        <div className="topology-editor__form-heading"><Database size={14} /><span>{tr(locale, "数据绑定", "Data binding")}</span></div>
        <label><span>{tr(locale, "数据产品", "Data product")}</span><select value={binding ? `${binding.productType}:${binding.productId}` : ""} onChange={(event) => setBindingProduct(event.target.value)}>
          <option value="">{tr(locale, "未绑定", "Unbound")}</option>
          {dataProducts.filter((product) => product.type === "pipeline").length > 0 && <optgroup label={tr(locale, "数据管道", "Pipelines")}>{dataProducts.filter((product) => product.type === "pipeline").map((product) => <option key={`${product.type}:${product.id}`} value={`${product.type}:${product.id}`}>{product.name}</option>)}</optgroup>}
          {dataProducts.filter((product) => product.type === "dataset").length > 0 && <optgroup label={tr(locale, "数据集", "Datasets")}>{dataProducts.filter((product) => product.type === "dataset").map((product) => <option key={`${product.type}:${product.id}`} value={`${product.type}:${product.id}`}>{product.name}</option>)}</optgroup>}
        </select></label>
        {binding && (selectedProduct?.fields?.length ? <label><span>{tr(locale, "状态字段", "State field")}</span><select value={binding.field} onChange={(event) => dispatch({ type: "binding.set", nodeId: selectedNode.id, binding: { ...binding, field: event.target.value } })}>{selectedProduct.fields.map((field) => <option key={field} value={field}>{field}</option>)}</select></label> : <InspectorTextField label={tr(locale, "状态字段", "State field")} value={binding.field} placeholder="status" onCommit={(field) => dispatch({ type: "binding.set", nodeId: selectedNode.id, binding: { ...binding, field } })} />)}
        {dataProducts.length === 0 && <p className="topology-editor__form-note">{tr(locale, "创建数据集或数据管道后，可在这里绑定设备状态。", "Create a dataset or pipeline to bind device state here.")}</p>}
      </div>}
      {selectedEdge && <div className="topology-editor__edge-card"><span><Link2 size={16} /></span><div><strong>{tr(locale, "有向连接", "Directed connection")}</strong><small>{nodeName(editor.document, selectedEdge.sourceNodeId)} → {nodeName(editor.document, selectedEdge.targetNodeId)}</small></div></div>}
      {!selection && <div className="topology-editor__inspector-empty"><MousePointer2 size={20} /><strong>{tr(locale, "选择节点或连线", "Select a node or edge")}</strong><small>{tr(locale, "在这里配置名称、位置与数据绑定。", "Configure names, positions and data bindings here.")}</small></div>}
    </aside>

    <footer className="topology-editor__footer"><span>{editor.document.nodes.length} {tr(locale, "节点", "nodes")}</span><span>{editor.document.edges.length} {tr(locale, "连线", "edges")}</span><span className="topology-editor__footer-spacer" /><span>{tr(locale, "网格", "Grid")} {GRID_SIZE}px</span><span>{tr(locale, "轻量拓扑模式", "Lightweight topology")}</span></footer>
  </section>;
}

function InspectorTextField({ label, value, placeholder, onCommit }: { label: string; value: string; placeholder?: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <label><span>{label}</span><input value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onCommit(draft); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setDraft(value); event.currentTarget.blur(); } }} /></label>;
}

function InspectorNumberField({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const normalized = String(Math.round(value));
  const [draft, setDraft] = useState(normalized);
  useEffect(() => setDraft(normalized), [normalized]);
  function commit() {
    const next = Number(draft);
    if (Number.isFinite(next) && next !== value) onCommit(next);
    else setDraft(normalized);
  }
  return <label><span>{label}</span><input value={draft} inputMode="numeric" onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setDraft(normalized); event.currentTarget.blur(); } }} /></label>;
}

function nodeName(document: TopologyDocument, nodeId: string): string {
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  return node ? topologyNodeLabel(node) : nodeId;
}

function snap(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}
