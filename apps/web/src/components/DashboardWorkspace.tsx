import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowLeft,
  Box,
  Copy,
  Database,
  Eye,
  EyeOff,
  GripVertical,
  Layers3,
  LayoutDashboard,
  Lock,
  Minus,
  Plus,
  Redo2,
  Rocket,
  Save,
  Scaling,
  Trash2,
  Undo2,
  Unlock,
  Workflow,
  X
} from "lucide-react";
import type { ApplicationDocument, ApplicationObjectRef, DashboardDataWidgetConfig, DashboardPageDocument, JsonValue, ProjectRecord, SceneDashboardWidgetType, SceneInteractionTarget, SceneInteractionTrigger, WidgetFrame, WidgetNode } from "@bim-studio/contracts";
import {
  createDeleteDashboardNodesCommand,
  createDeleteDashboardPageCommand,
  createInsertDashboardNodeCommand,
  createInsertDashboardNodesCommand,
  createInsertDashboardPageCommand,
  createRenameDashboardPageCommand,
  createUpdateDashboardDataWidgetCommand,
  createUpdateDashboardNodeFrameCommand,
  createUpdateDashboardNodeFramesCommand,
  createUpdateDashboardNodeStateCommand,
  createUpdateDashboardNodeStatesCommand,
  alignDashboardFrames,
  distributeDashboardFrames,
  type DashboardAlignment,
  type DashboardDistribution,
  type ApplicationInteractionResult,
  type StudioCommand
} from "@bim-studio/studio-core";
import { translate as tr, type AppLocale } from "../i18n";
import { normalizeDashboardViewState, type DashboardViewState } from "../studio/workspaceRoute";
import { SceneViewportPreview } from "./SceneViewportPreview";
import { InteractionFlowInspector } from "./InteractionFlowInspector";
import { DashboardWidgetView, useDashboardMetrics, widgetBackground, type DashboardMetric } from "./DashboardWidgetRuntime";
import type { RendererBackend } from "../viewer/ViewerEngine";

const DATA_WIDGET_TYPES: SceneDashboardWidgetType[] = ["value", "gauge", "status", "line", "area", "bar", "pie", "table", "image", "video", "monitor", "url"];
interface SelectionRect { x: number; y: number; width: number; height: number; }

export interface DashboardWorkspaceProps {
  locale: AppLocale;
  application: ApplicationDocument;
  project: ProjectRecord;
  page: DashboardPageDocument;
  rendererBackend: RendererBackend;
  initialView?: DashboardViewState;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  selection: readonly ApplicationObjectRef[];
  variables: Readonly<Record<string, JsonValue>>;
  onBack: () => void;
  onSelectPage: (pageId: string, view: DashboardViewState) => void;
  onEnterScene: (sceneId: string, view: DashboardViewState) => void;
  onOpenData: () => void;
  onSelectionChange: (selection: readonly ApplicationObjectRef[]) => void;
  onObjectInteraction: (sceneId: string, trigger: SceneInteractionTrigger, target: SceneInteractionTarget) => void;
  onNodeInteraction: (nodeId: string, trigger?: SceneInteractionTrigger) => ApplicationInteractionResult | undefined;
  onCommand: (command: StudioCommand) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onPublish: () => void;
  onViewStateChange: (view: DashboardViewState) => void;
}

export function DashboardWorkspace({
  locale,
  application,
  project,
  page,
  rendererBackend,
  initialView,
  dirty,
  canUndo,
  canRedo,
  busy,
  selection,
  variables,
  onBack,
  onSelectPage,
  onEnterScene,
  onOpenData,
  onSelectionChange,
  onObjectInteraction,
  onNodeInteraction,
  onCommand,
  onUndo,
  onRedo,
  onSave,
  onPublish,
  onViewStateChange
}: DashboardWorkspaceProps) {
  const normalizedInitialView = useMemo(() => normalizeDashboardViewState(initialView), [page.id]);
  const [zoom, setZoom] = useState(normalizedInitialView.zoom);
  const [selectedNodeIds, setSelectedNodeIds] = useState(normalizedInitialView.selectedNodeIds);
  const [runtimePreview, setRuntimePreview] = useState(false);
  const [draftFrames, setDraftFrames] = useState<Record<string, WidgetFrame>>({});
  const [selectionRect, setSelectionRect] = useState<SelectionRect>();
  const [marqueeMode, setMarqueeMode] = useState(false);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageNameCommitRef = useRef(page.name);
  const clipboardRef = useRef<WidgetNode[]>([]);
  const selectedNode = page.nodes.find((node) => selectedNodeIds.includes(node.id));
  const layoutSelectionCount = page.nodes.filter((node) => selectedNodeIds.includes(node.id) && node.visible !== false && node.locked !== true).length;
  const dataWidgetConfigs = useMemo(() => page.nodes.flatMap((node) => node.kind === "data-widget" ? [node.widget] : []), [page.nodes]);
  const { metrics, connected } = useDashboardMetrics(project.id, dataWidgetConfigs);
  const runtimeMetrics = useMemo<Record<string, DashboardMetric>>(() => ({
    ...metrics,
    ...Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, {
      value,
      samples: typeof value === "number" && Number.isFinite(value) ? [{ time: Date.now(), value }] : []
    }]))
  }), [metrics, variables]);

  useEffect(() => {
    const widgetIds = selection.filter((item) => item.kind === "widget").map((item) => item.id);
    if (widgetIds.length > 0) setSelectedNodeIds(widgetIds.filter((id) => page.nodes.some((node) => node.id === id)));
  }, [selection, page.id]);

  useEffect(() => {
    setZoom(normalizedInitialView.zoom);
    setSelectedNodeIds(normalizedInitialView.selectedNodeIds.filter((id) => page.nodes.some((node) => node.id === id)));
    setDraftFrames({});
    setSelectionRect(undefined);
    setMarqueeMode(false);
    pageNameCommitRef.current = page.name;
    const frame = window.requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      scrollRef.current.scrollLeft = normalizedInitialView.scrollLeft;
      scrollRef.current.scrollTop = normalizedInitialView.scrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [page.id]);

  useEffect(() => {
    emitViewState();
  }, [zoom, selectedNodeIds]);

  useEffect(() => {
    if (!runtimePreview) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setRuntimePreview(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [runtimePreview]);

  function currentView(): DashboardViewState {
    return {
      zoom,
      scrollLeft: scrollRef.current?.scrollLeft ?? normalizedInitialView.scrollLeft,
      scrollTop: scrollRef.current?.scrollTop ?? normalizedInitialView.scrollTop,
      selectedNodeIds
    };
  }

  function emitViewState() {
    onViewStateChange(currentView());
  }

  function selectNode(node: WidgetNode, additive: boolean, force = false) {
    if (!force && node.selectable === false) return;
    const groupIds = !additive && node.groupId
      ? page.nodes.filter((candidate) => candidate.groupId === node.groupId && candidate.visible !== false).map((candidate) => candidate.id)
      : undefined;
    const next = groupIds ?? (additive
      ? selectedNodeIds.includes(node.id) ? selectedNodeIds.filter((id) => id !== node.id) : [...selectedNodeIds, node.id]
      : [node.id]);
    setSelectedNodeIds(next);
    onSelectionChange(next.map((id) => ({ kind: "widget", id })));
    onNodeInteraction(node.id);
  }

  function updateSelectedFrame(field: keyof WidgetFrame, value: number) {
    if (!selectedNode || selectedNode.locked || !Number.isFinite(value)) return;
    const next = {
      ...selectedNode.frame,
      [field]: field === "width" || field === "height" ? Math.max(1, Math.round(value)) : Math.round(value)
    };
    onCommand(createUpdateDashboardNodeFrameCommand(page.id, selectedNode.id, next));
  }

  function beginNodeTransform(event: ReactPointerEvent<HTMLButtonElement>, node: WidgetNode, mode: "move" | "resize") {
    if (event.button !== 0 || node.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const nodeIds = mode === "move" && selectedNodeIds.includes(node.id)
      ? page.nodes.filter((candidate) => selectedNodeIds.includes(candidate.id) && candidate.locked !== true).map((candidate) => candidate.id)
      : [node.id];
    const initial = new Map(page.nodes.filter((candidate) => nodeIds.includes(candidate.id)).map((candidate) => [candidate.id, structuredClone(candidate.frame)]));
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const framesAt = (clientX: number, clientY: number): Record<string, WidgetFrame> => {
      let dx = Math.round((clientX - startX) / zoom);
      let dy = Math.round((clientY - startY) / zoom);
      if (snapEnabled) {
        const anchor = initial.get(node.id)!;
        if (mode === "move") {
          dx = Math.round((anchor.x + dx) / 8) * 8 - anchor.x;
          dy = Math.round((anchor.y + dy) / 8) * 8 - anchor.y;
        } else {
          dx = Math.round((anchor.width + dx) / 8) * 8 - anchor.width;
          dy = Math.round((anchor.height + dy) / 8) * 8 - anchor.height;
        }
      }
      return Object.fromEntries([...initial].map(([nodeId, frame]) => {
        if (mode === "resize") return [nodeId, {
          ...frame,
          width: Math.max(40, Math.min(page.width - frame.x, frame.width + dx)),
          height: Math.max(40, Math.min(page.height - frame.y, frame.height + dy))
        }];
        return [nodeId, {
          ...frame,
          x: Math.max(0, Math.min(page.width - frame.width, frame.x + dx)),
          y: Math.max(0, Math.min(page.height - frame.height, frame.y + dy))
        }];
      }));
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      setDraftFrames(framesAt(pointer.clientX, pointer.clientY));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      cleanup();
      const finalFrames = framesAt(pointer.clientX, pointer.clientY);
      setDraftFrames({});
      const changes = Object.entries(finalFrames)
        .filter(([nodeId, frame]) => JSON.stringify(frame) !== JSON.stringify(initial.get(nodeId)))
        .map(([nodeId, frame]) => ({ nodeId, frame }));
      if (changes.length > 0) onCommand(createUpdateDashboardNodeFramesCommand(page.id, changes));
    };
    const cancel = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      cleanup();
      setDraftFrames({});
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  }

  function copySelectedNodes() {
    clipboardRef.current = page.nodes.filter((node) => selectedNodeIds.includes(node.id)).map((node) => structuredClone(node));
  }

  function pasteCopiedNodes() {
    if (clipboardRef.current.length === 0 || busy) return;
    const topZIndex = Math.max(0, ...page.nodes.map((node) => node.zIndex));
    const groupIds = new Map([...new Set(clipboardRef.current.flatMap((node) => node.groupId ? [node.groupId] : []))].map((groupId) => [groupId, `group:${crypto.randomUUID()}`]));
    const nodes = clipboardRef.current.map((source, index): WidgetNode => ({
      ...structuredClone(source),
      id: `${source.kind}:${crypto.randomUUID()}`,
      frame: {
        ...source.frame,
        x: Math.min(page.width - source.frame.width, Math.max(0, source.frame.x + 24)),
        y: Math.min(page.height - source.frame.height, Math.max(0, source.frame.y + 24))
      },
      zIndex: topZIndex + index + 1,
      visible: true,
      locked: false,
      ...(source.groupId ? { groupId: groupIds.get(source.groupId)! } : {})
    }));
    clipboardRef.current = nodes.map((node) => structuredClone(node));
    onCommand(createInsertDashboardNodesCommand(page.id, nodes));
    const ids = nodes.map((node) => node.id);
    setSelectedNodeIds(ids);
    onSelectionChange(ids.map((id) => ({ kind: "widget", id })));
  }

  function deleteSelectedNodes() {
    if (busy) return;
    const nodeIds = page.nodes.filter((node) => selectedNodeIds.includes(node.id) && node.locked !== true).map((node) => node.id);
    if (nodeIds.length === 0) return;
    onCommand(createDeleteDashboardNodesCommand(page.id, nodeIds));
    const remaining = selectedNodeIds.filter((id) => !nodeIds.includes(id));
    setSelectedNodeIds(remaining);
    onSelectionChange(remaining.map((id) => ({ kind: "widget", id })));
  }

  function nudgeSelectedNodes(dx: number, dy: number) {
    if (busy) return;
    const frames = page.nodes
      .filter((node) => selectedNodeIds.includes(node.id) && node.locked !== true)
      .map((node) => ({
        nodeId: node.id,
        frame: {
          ...node.frame,
          x: Math.max(0, Math.min(page.width - node.frame.width, node.frame.x + dx)),
          y: Math.max(0, Math.min(page.height - node.frame.height, node.frame.y + dy))
        }
      }))
      .filter(({ nodeId, frame }) => {
        const original = page.nodes.find((node) => node.id === nodeId)!.frame;
        return frame.x !== original.x || frame.y !== original.y;
      });
    if (frames.length > 0) onCommand(createUpdateDashboardNodeFramesCommand(page.id, frames));
  }

  function layoutSelectedNodes(mode: DashboardAlignment | DashboardDistribution) {
    const entries = page.nodes
      .filter((node) => selectedNodeIds.includes(node.id) && node.visible !== false && node.locked !== true)
      .map((node) => ({ nodeId: node.id, frame: node.frame }));
    const next = mode === "horizontal" || mode === "vertical"
      ? distributeDashboardFrames(entries, mode)
      : alignDashboardFrames(entries, mode);
    const changed = next.filter(({ nodeId, frame }) => {
      const original = page.nodes.find((node) => node.id === nodeId)!.frame;
      return frame.x !== original.x || frame.y !== original.y;
    });
    if (changed.length > 0) onCommand(createUpdateDashboardNodeFramesCommand(page.id, changed));
  }

  function groupSelectedNodes() {
    const nodes = page.nodes.filter((node) => selectedNodeIds.includes(node.id) && node.locked !== true);
    if (nodes.length < 2) return;
    const groupId = `group:${crypto.randomUUID()}`;
    onCommand(createUpdateDashboardNodeStatesCommand(page.id, nodes.map((node) => ({ nodeId: node.id, state: { groupId } })), `编组 ${nodes.length} 个二维组件`));
  }

  function ungroupSelectedNodes() {
    const nodes = page.nodes.filter((node) => selectedNodeIds.includes(node.id) && node.groupId && node.locked !== true);
    if (nodes.length === 0) return;
    onCommand(createUpdateDashboardNodeStatesCommand(page.id, nodes.map((node) => ({ nodeId: node.id, state: { groupId: null } })), `解组 ${nodes.length} 个二维组件`));
  }

  function beginMarqueeSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (!marqueeMode && !event.shiftKey && event.target !== event.currentTarget)) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const bounds = event.currentTarget.getBoundingClientRect();
    const additive = event.ctrlKey || event.metaKey;
    const pointAt = (clientX: number, clientY: number) => ({
      x: Math.max(0, Math.min(page.width, (clientX - bounds.left) / zoom)),
      y: Math.max(0, Math.min(page.height, (clientY - bounds.top) / zoom))
    });
    const start = pointAt(event.clientX, event.clientY);
    const rectangleAt = (clientX: number, clientY: number): SelectionRect => {
      const end = pointAt(clientX, clientY);
      return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId === pointerId) setSelectionRect(rectangleAt(pointer.clientX, pointer.clientY));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      cleanup();
      const rectangle = rectangleAt(pointer.clientX, pointer.clientY);
      setSelectionRect(undefined);
      const hits = rectangle.width < 3 && rectangle.height < 3 ? [] : page.nodes
        .filter((node) => node.visible !== false && node.selectable !== false
          && node.frame.x >= rectangle.x
          && node.frame.y >= rectangle.y
          && node.frame.x + node.frame.width <= rectangle.x + rectangle.width
          && node.frame.y + node.frame.height <= rectangle.y + rectangle.height)
        .map((node) => node.id);
      const ids = additive ? [...new Set([...selectedNodeIds, ...hits])] : hits;
      setSelectedNodeIds(ids);
      onSelectionChange(ids.map((id) => ({ kind: "widget", id })));
      setMarqueeMode(false);
    };
    const cancel = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      cleanup();
      setSelectionRect(undefined);
    };
    setSelectionRect({ x: start.x, y: start.y, width: 0, height: 0 });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  }

  useEffect(() => {
    if (runtimePreview) return;
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const key = event.key.toLowerCase();
      const commandKey = event.ctrlKey || event.metaKey;
      if (commandKey && key === "a") {
        event.preventDefault();
        const ids = page.nodes.filter((node) => node.visible !== false && node.selectable !== false).map((node) => node.id);
        setSelectedNodeIds(ids);
        onSelectionChange(ids.map((id) => ({ kind: "widget", id })));
        return;
      }
      if (commandKey && key === "c") { event.preventDefault(); copySelectedNodes(); return; }
      if (commandKey && key === "v") { event.preventDefault(); pasteCopiedNodes(); return; }
      if (commandKey && key === "d") { event.preventDefault(); copySelectedNodes(); pasteCopiedNodes(); return; }
      if (commandKey && key === "s") { event.preventDefault(); if (!busy) onSave(); return; }
      if (commandKey && key === "z") {
        event.preventDefault();
        if (event.shiftKey ? canRedo : canUndo) (event.shiftKey ? onRedo : onUndo)();
        return;
      }
      if (commandKey && key === "y") { event.preventDefault(); if (canRedo) onRedo(); return; }
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deleteSelectedNodes(); return; }
      if (event.key === "Escape") {
        setSelectedNodeIds([]);
        setMarqueeMode(false);
        onSelectionChange([]);
        return;
      }
      const step = event.shiftKey ? 10 : 1;
      if (event.key === "ArrowLeft") { event.preventDefault(); nudgeSelectedNodes(-step, 0); }
      if (event.key === "ArrowRight") { event.preventDefault(); nudgeSelectedNodes(step, 0); }
      if (event.key === "ArrowUp") { event.preventDefault(); nudgeSelectedNodes(0, -step); }
      if (event.key === "ArrowDown") { event.preventDefault(); nudgeSelectedNodes(0, step); }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [page, selectedNodeIds, runtimePreview, busy, canUndo, canRedo, onSelectionChange, onCommand, onSave, onUndo, onRedo]);

  function openInsertedPage(nextPage: DashboardPageDocument) {
    onCommand(createInsertDashboardPageCommand(nextPage));
    onSelectPage(nextPage.id, { zoom, scrollLeft: 0, scrollTop: 0, selectedNodeIds: [] });
  }

  function addDashboardPage() {
    const nextPage: DashboardPageDocument = {
      id: `page:${crypto.randomUUID()}`,
      name: tr(locale, `页面 ${application.pages.length + 1}`, `Page ${application.pages.length + 1}`),
      width: 1920,
      height: 1080,
      appearance: structuredClone(page.appearance ?? {}),
      nodes: []
    };
    openInsertedPage(nextPage);
  }

  function duplicateDashboardPage() {
    const pageId = `page:${crypto.randomUUID()}`;
    const nodeIds = new Map(page.nodes.map((node) => [node.id, `${node.kind}:${crypto.randomUUID()}`]));
    const groupIds = new Map([...new Set(page.nodes.flatMap((node) => node.groupId ? [node.groupId] : []))].map((groupId) => [groupId, `group:${crypto.randomUUID()}`]));
    const nextPage: DashboardPageDocument = {
      ...structuredClone(page),
      id: pageId,
      name: tr(locale, `${page.name} 副本`, `${page.name} copy`),
      nodes: page.nodes.map((node) => ({ ...structuredClone(node), id: nodeIds.get(node.id)!, ...(node.groupId ? { groupId: groupIds.get(node.groupId)! } : {}) }))
    };
    const interactions = application.interactions.flatMap((flow) => {
      const source = flow.source.kind === "page" && flow.source.id === page.id
        ? { kind: "page" as const, id: pageId }
        : flow.source.kind === "widget" && nodeIds.has(flow.source.id)
          ? { kind: "widget" as const, id: nodeIds.get(flow.source.id)! }
          : undefined;
      return source ? [{ ...structuredClone(flow), id: `flow:${crypto.randomUUID()}`, name: tr(locale, `${flow.name} 副本`, `${flow.name} copy`), source }] : [];
    });
    onCommand(createInsertDashboardPageCommand(nextPage, interactions));
    onSelectPage(nextPage.id, { zoom, scrollLeft: 0, scrollTop: 0, selectedNodeIds: [] });
  }

  function deleteDashboardPage(pageId: string) {
    if (application.pages.length <= 1 || busy) return;
    const fallback = application.pages.find((candidate) => candidate.id !== pageId)!;
    onCommand(createDeleteDashboardPageCommand(pageId));
    if (page.id === pageId) onSelectPage(fallback.id, { zoom, scrollLeft: 0, scrollTop: 0, selectedNodeIds: [] });
  }

  function commitPageName(value: string) {
    const name = value.trim();
    if (!name || name === pageNameCommitRef.current) return;
    pageNameCommitRef.current = name;
    onCommand(createRenameDashboardPageCommand(page.id, name));
  }

  function addDataWidget(type: SceneDashboardWidgetType) {
    const id = `widget:${crypto.randomUUID()}`;
    const index = page.nodes.filter((node) => node.kind === "data-widget").length;
    const wide = ["line", "area", "bar", "pie", "table", "image", "video", "monitor", "url"].includes(type);
    const node: WidgetNode = {
      id,
      kind: "data-widget",
      frame: { x: 48 + index % 4 * 28, y: 48 + index % 4 * 28, width: wide ? 420 : 260, height: wide || type === "gauge" ? 240 : 140 },
      zIndex: Math.max(0, ...page.nodes.map((item) => item.zIndex)) + 1,
      widget: defaultDataWidget(locale, type)
    };
    onCommand(createInsertDashboardNodeCommand(page.id, node));
    setSelectedNodeIds([id]);
    onSelectionChange([{ kind: "widget", id }]);
  }

  function updateDataWidget(patch: Partial<DashboardDataWidgetConfig>) {
    if (!selectedNode || selectedNode.kind !== "data-widget") return;
    onCommand(createUpdateDashboardDataWidgetCommand(page.id, selectedNode.id, { ...selectedNode.widget, ...patch }));
  }

  if (runtimePreview) return <DashboardRuntimePreview locale={locale} application={application} project={project} page={page} rendererBackend={rendererBackend} metrics={runtimeMetrics} connected={connected} onClose={() => setRuntimePreview(false)} onSelectionChange={onSelectionChange} onObjectInteraction={onObjectInteraction} onNodeInteraction={onNodeInteraction} />;

  return <main className="dashboard-workspace">
    <header className="dashboard-workspace-topbar">
      <button className="dashboard-back" onClick={onBack}><ArrowLeft size={16} />{tr(locale, "项目", "Project")}</button>
      <div className="dashboard-workspace-title"><LayoutDashboard size={17} /><div><strong>{application.metadata.name}</strong><span>{dirty ? tr(locale, "有未保存修改", "Unsaved changes") : tr(locale, "所有修改已保存", "All changes saved")}</span></div></div>
      <nav className="workspace-mode-switch" aria-label={tr(locale, "编辑模式", "Editor mode")}>
        <button className="active"><LayoutDashboard size={14} />{tr(locale, "二维设计", "2D design")}</button>
        <button disabled title={tr(locale, "M5 提供独立拓扑编辑器", "The topology editor arrives in M5")}><Workflow size={14} />{tr(locale, "拓扑", "Topology")}</button>
        <button onClick={() => application.scenes[0] && onEnterScene(application.scenes[0].id, currentView())}><Box size={14} />{tr(locale, "三维场景", "3D scenes")}</button>
        <button onClick={onOpenData}><Database size={14} />{tr(locale, "数据", "Data")}</button>
        <button onClick={() => setRuntimePreview(true)}><Eye size={14} />{tr(locale, "预览", "Preview")}</button>
      </nav>
      <div className="dashboard-workspace-actions">
        <button disabled={!canUndo || busy} title={tr(locale, "撤销", "Undo")} onClick={onUndo}><Undo2 size={15} /></button>
        <button disabled={!canRedo || busy} title={tr(locale, "重做", "Redo")} onClick={onRedo}><Redo2 size={15} /></button>
        <button disabled={!dirty || busy} onClick={onSave}><Save size={15} />{tr(locale, "保存", "Save")}</button>
        <button className="primary" disabled={busy} onClick={onPublish}><Rocket size={15} />{tr(locale, "发布", "Publish")}</button>
      </div>
    </header>

    <aside className="dashboard-pages-panel">
      <header><span className="eyebrow">APPLICATION</span><strong>{tr(locale, "页面与图层", "Pages & layers")}</strong></header>
      <section>
        <div className="dashboard-panel-label"><span>{tr(locale, "页面", "Pages")}<small>{application.pages.length}</small></span><span className="dashboard-page-actions"><button title={tr(locale, "复制当前页面", "Duplicate current page")} onClick={duplicateDashboardPage}><Copy size={12} /></button><button title={tr(locale, "新增空白页面", "Add blank page")} onClick={addDashboardPage}><Plus size={12} /></button></span></div>
        {application.pages.map((candidate) => <div className={`dashboard-page-row ${candidate.id === page.id ? "active" : ""}`} key={candidate.id}>
          <button className="dashboard-page-select" onClick={() => onSelectPage(candidate.id, currentView())}><LayoutDashboard size={14} /><span>{candidate.name}</span><small>{candidate.nodes.length}</small></button>
          <button className="dashboard-page-delete" disabled={application.pages.length <= 1} title={tr(locale, "删除页面", "Delete page")} onClick={() => deleteDashboardPage(candidate.id)}><Trash2 size={12} /></button>
        </div>)}
      </section>
      <section className="dashboard-component-library">
        <div className="dashboard-panel-label"><span>{tr(locale, "组件", "Components")}</span><small>{connected ? tr(locale, "实时", "Live") : tr(locale, "离线", "Offline")}</small></div>
        <div>{DATA_WIDGET_TYPES.map((type) => <button key={type} onClick={() => addDataWidget(type)}><Plus size={11} /><span>{dataWidgetTypeLabel(locale, type)}</span></button>)}</div>
      </section>
      <section>
        <div className="dashboard-panel-label"><span>{tr(locale, "图层", "Layers")}</span><small>{page.nodes.length}</small></div>
        {[...page.nodes].sort((left, right) => right.zIndex - left.zIndex).map((node) => <div className={`dashboard-layer-row ${selectedNodeIds.includes(node.id) ? "active" : ""} ${node.visible === false ? "hidden" : ""}`} key={node.id}>
          <button className="dashboard-layer-select" onClick={(event) => selectNode(node, event.ctrlKey || event.metaKey, true)}>{node.kind === "scene-viewport" ? <Box size={14} /> : <Layers3 size={14} />}<span>{nodeLabel(node)}</span><small>{node.zIndex}</small></button>
          <button className="dashboard-layer-action" title={node.visible === false ? tr(locale, "显示图层", "Show layer") : tr(locale, "隐藏图层", "Hide layer")} onClick={() => onCommand(createUpdateDashboardNodeStateCommand(page.id, node.id, { visible: node.visible === false }))}>{node.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}</button>
          <button className={`dashboard-layer-action dashboard-layer-selectable ${node.selectable === false ? "off" : ""}`} title={node.selectable === false ? tr(locale, "允许画布选取", "Allow canvas selection") : tr(locale, "禁止画布选取", "Prevent canvas selection")} onClick={() => onCommand(createUpdateDashboardNodeStateCommand(page.id, node.id, { selectable: node.selectable === false }))}>{node.selectable === false ? "禁" : "选"}</button>
          <button className={`dashboard-layer-action ${node.locked ? "active" : ""}`} title={node.locked ? tr(locale, "解锁图层", "Unlock layer") : tr(locale, "锁定图层", "Lock layer")} onClick={() => onCommand(createUpdateDashboardNodeStateCommand(page.id, node.id, { locked: !node.locked }))}>{node.locked ? <Lock size={13} /> : <Unlock size={13} />}</button>
        </div>)}
      </section>
    </aside>

    <section className="dashboard-design-surface">
      <div className="dashboard-canvas-toolbar">
        <span>{page.width} × {page.height}<small>{tr(locale, "Shift 拖动框选 · 方向键微调 · Shift 10px · Ctrl/Cmd+C/V/D", "Shift-drag selects · Arrows nudge · Shift 10px · Ctrl/Cmd+C/V/D")}</small></span>
        <div className="dashboard-layout-tools">
          <button className={marqueeMode ? "active" : ""} title={tr(locale, "框选组件（也可按住 Shift 拖动）", "Box select (or hold Shift while dragging)")} onClick={() => setMarqueeMode((active) => !active)}>框</button>
          <button className={snapEnabled ? "active" : ""} title={tr(locale, "8px 网格吸附", "Snap to 8px grid")} onClick={() => setSnapEnabled((enabled) => !enabled)}>吸</button>
          <button disabled={selectedNodeIds.filter((id) => page.nodes.some((node) => node.id === id && node.locked !== true)).length < 2} title={tr(locale, "编组", "Group")} onClick={groupSelectedNodes}>组</button>
          <button disabled={!page.nodes.some((node) => selectedNodeIds.includes(node.id) && node.groupId && node.locked !== true)} title={tr(locale, "解组", "Ungroup")} onClick={ungroupSelectedNodes}>解</button>
          <button disabled={layoutSelectionCount < 2} title={tr(locale, "左对齐", "Align left")} onClick={() => layoutSelectedNodes("left")}>左</button>
          <button disabled={layoutSelectionCount < 2} title={tr(locale, "水平居中", "Center horizontally")} onClick={() => layoutSelectedNodes("horizontal-center")}>中</button>
          <button disabled={layoutSelectionCount < 2} title={tr(locale, "右对齐", "Align right")} onClick={() => layoutSelectedNodes("right")}>右</button>
          <button disabled={layoutSelectionCount < 2} title={tr(locale, "顶对齐", "Align top")} onClick={() => layoutSelectedNodes("top")}>上</button>
          <button disabled={layoutSelectionCount < 2} title={tr(locale, "垂直居中", "Center vertically")} onClick={() => layoutSelectedNodes("vertical-center")}>中</button>
          <button disabled={layoutSelectionCount < 2} title={tr(locale, "底对齐", "Align bottom")} onClick={() => layoutSelectedNodes("bottom")}>下</button>
          <button disabled={layoutSelectionCount < 3} title={tr(locale, "水平等距", "Distribute horizontally")} onClick={() => layoutSelectedNodes("horizontal")}>横均</button>
          <button disabled={layoutSelectionCount < 3} title={tr(locale, "垂直等距", "Distribute vertically")} onClick={() => layoutSelectedNodes("vertical")}>纵均</button>
        </div>
        <div><button onClick={() => setZoom((value) => Math.max(0.1, Number((value - 0.1).toFixed(2))))}><Minus size={13} /></button><output>{Math.round(zoom * 100)}%</output><button onClick={() => setZoom((value) => Math.min(2, Number((value + 0.1).toFixed(2))))}><Plus size={13} /></button></div>
      </div>
      <div className="dashboard-canvas-scroll" ref={scrollRef} onScroll={emitViewState} onClick={(event) => { if (event.target === event.currentTarget) { setSelectedNodeIds([]); onSelectionChange([]); } }}>
        <div className="dashboard-artboard-stage" style={{ width: page.width * zoom, height: page.height * zoom }}>
          <div className={`dashboard-artboard ${marqueeMode ? "marquee-mode" : ""}`} style={{ width: page.width, height: page.height, transform: `scale(${zoom})` }} onPointerDownCapture={beginMarqueeSelection}>
            {page.nodes.filter((node) => node.visible !== false).map((node) => <DashboardNode key={node.id} application={application} project={project} node={node} frame={draftFrames[node.id] ?? node.frame} metric={node.kind === "data-widget" ? runtimeMetrics[node.widget.key] : undefined} selected={selectedNodeIds.includes(node.id)} locale={locale} rendererBackend={rendererBackend} onSelectionChange={onSelectionChange} onObjectInteraction={onObjectInteraction} onInteraction={(trigger) => onNodeInteraction(node.id, trigger)} onSelect={(additive) => selectNode(node, additive)} onEnterScene={(sceneId) => onEnterScene(sceneId, currentView())} onTransformStart={(event, mode) => beginNodeTransform(event, node, mode)} />)}
            {selectionRect && <div className="dashboard-selection-rect" style={{ left: selectionRect.x, top: selectionRect.y, width: selectionRect.width, height: selectionRect.height }} />}
          </div>
        </div>
      </div>
    </section>

    <aside className="dashboard-inspector-panel">
      <header><span className="eyebrow">INSPECTOR</span><strong>{tr(locale, "属性", "Properties")}</strong></header>
      <section className="dashboard-inspector-section">
        <label><span>{tr(locale, "页面名称", "Page name")}</span><input defaultValue={page.name} key={page.id} onBlur={(event) => commitPageName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
      </section>
      {selectedNode ? <>
        <section className="dashboard-inspector-section">
          <div className="dashboard-selection-heading"><span>{selectedNode.kind === "scene-viewport" ? <Box size={15} /> : <Layers3 size={15} />}</span><div><strong>{nodeLabel(selectedNode)}</strong><small>{selectedNode.id}</small></div></div>
          <div className="dashboard-frame-grid">{(["x", "y", "width", "height"] as const).map((field) => <label key={field}><span>{field.toUpperCase()}</span><input type="number" disabled={selectedNode.locked === true} value={selectedNode.frame[field]} onChange={(event) => updateSelectedFrame(field, Number(event.target.value))} /></label>)}</div>
        </section>
        {selectedNode.kind === "scene-viewport" && <section className="dashboard-inspector-section"><div className="dashboard-readonly-property"><span>{tr(locale, "三维场景", "3D scene")}</span><strong>{sceneName(application, selectedNode.sceneId)}</strong></div><div className="dashboard-readonly-property"><span>{tr(locale, "渲染方式", "Render mode")}</span><strong>{selectedNode.renderMode}</strong></div><button className="dashboard-enter-scene" onClick={() => onEnterScene(selectedNode.sceneId, currentView())}><Box size={15} />{tr(locale, "进入三维编辑", "Open 3D editor")}</button></section>}
        {selectedNode.kind === "data-widget" && <section className="dashboard-inspector-section dashboard-data-widget-properties">
          <label><span>{tr(locale, "类型", "Type")}</span><select value={selectedNode.widget.type} onChange={(event) => updateDataWidget({ type: event.target.value as SceneDashboardWidgetType })}>{DATA_WIDGET_TYPES.map((type) => <option key={type} value={type}>{dataWidgetTypeLabel(locale, type)}</option>)}</select></label>
          <label><span>{tr(locale, "标题", "Title")}</span><input defaultValue={selectedNode.widget.title} key={`${selectedNode.id}:title:${selectedNode.widget.title}`} onBlur={(event) => { if (event.currentTarget.value !== selectedNode.widget.title) updateDataWidget({ title: event.currentTarget.value }); }} /></label>
          <label><span>{tr(locale, "数据键", "Data key")}</span><input defaultValue={selectedNode.widget.key} key={`${selectedNode.id}:key:${selectedNode.widget.key}`} onBlur={(event) => { if (event.currentTarget.value !== selectedNode.widget.key) updateDataWidget({ key: event.currentTarget.value }); }} /></label>
          <label><span>{tr(locale, "单位", "Unit")}</span><input defaultValue={selectedNode.widget.unit} key={`${selectedNode.id}:unit:${selectedNode.widget.unit}`} onBlur={(event) => { if (event.currentTarget.value !== selectedNode.widget.unit) updateDataWidget({ unit: event.currentTarget.value }); }} /></label>
          <label><span>{tr(locale, "强调色", "Accent")}</span><input type="color" value={selectedNode.widget.color ?? "#d4a84f"} onChange={(event) => updateDataWidget({ color: event.target.value })} /></label>
        </section>}
        <section className="dashboard-inspector-section"><button className="dashboard-delete-node" disabled={!page.nodes.some((node) => selectedNodeIds.includes(node.id) && node.locked !== true)} onClick={deleteSelectedNodes}><Minus size={13} />{selectedNodeIds.length > 1 ? tr(locale, "删除未锁定的所选组件", "Delete unlocked selection") : selectedNode.locked ? tr(locale, "图层已锁定", "Layer locked") : tr(locale, "删除组件", "Delete component")}</button></section>
        <InteractionFlowInspector locale={locale} application={application} source={{ kind: "widget", id: selectedNode.id }} onCommand={onCommand} onTest={(trigger) => onNodeInteraction(selectedNode.id, trigger)} />
      </> : <div className="dashboard-no-selection"><Layers3 size={24} /><span>{tr(locale, "选择页面中的组件以编辑属性", "Select a component on the page to edit its properties")}</span></div>}
    </aside>
  </main>;
}

function DashboardRuntimePreview({ locale, application, project, page, rendererBackend, metrics, connected, onClose, onSelectionChange, onObjectInteraction, onNodeInteraction }: {
  locale: AppLocale;
  application: ApplicationDocument;
  project: ProjectRecord;
  page: DashboardPageDocument;
  rendererBackend: RendererBackend;
  metrics: Record<string, DashboardMetric>;
  connected: boolean;
  onClose: () => void;
  onSelectionChange: (selection: readonly ApplicationObjectRef[]) => void;
  onObjectInteraction: (sceneId: string, trigger: SceneInteractionTrigger, target: SceneInteractionTarget) => void;
  onNodeInteraction: (nodeId: string, trigger?: SceneInteractionTrigger) => ApplicationInteractionResult | undefined;
}) {
  const [scale, setScale] = useState(0.5);
  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const resize = () => setScale(Math.max(0.1, Math.min((surface.clientWidth - 32) / page.width, (surface.clientHeight - 32) / page.height)));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [page.width, page.height]);
  return <main className="dashboard-runtime-preview">
    <header><div><Eye size={16} /><span><strong>{application.metadata.name}</strong><small>{page.name} · {connected ? tr(locale, "实时数据", "Live data") : tr(locale, "离线预览", "Offline preview")}</small></span></div><div><span>{Math.round(scale * 100)}%</span><button onClick={onClose}><X size={15} />{tr(locale, "退出预览", "Exit preview")}</button></div></header>
    <section ref={surfaceRef}><div className="dashboard-runtime-stage" style={{ width: page.width * scale, height: page.height * scale }}><div className="dashboard-artboard dashboard-runtime-artboard" style={{ width: page.width, height: page.height, transform: `scale(${scale})` }}>{page.nodes.filter((node) => node.visible !== false).map((node) => <DashboardNode key={node.id} runtime application={application} project={project} node={node} frame={node.frame} metric={node.kind === "data-widget" ? metrics[node.widget.key] : undefined} selected={false} locale={locale} rendererBackend={rendererBackend} onSelectionChange={onSelectionChange} onObjectInteraction={onObjectInteraction} onInteraction={(trigger) => onNodeInteraction(node.id, trigger)} onSelect={() => undefined} onEnterScene={() => undefined} onTransformStart={() => undefined} />)}</div></div></section>
  </main>;
}

function DashboardNode({ application, project, node, frame, metric, selected, locale, rendererBackend, runtime = false, onSelectionChange, onObjectInteraction, onInteraction, onSelect, onEnterScene, onTransformStart }: {
  application: ApplicationDocument;
  project: ProjectRecord;
  node: WidgetNode;
  frame: WidgetFrame;
  metric: DashboardMetric | undefined;
  selected: boolean;
  locale: AppLocale;
  rendererBackend: RendererBackend;
  runtime?: boolean;
  onSelectionChange: (selection: readonly ApplicationObjectRef[]) => void;
  onObjectInteraction: (sceneId: string, trigger: SceneInteractionTrigger, target: SceneInteractionTarget) => void;
  onInteraction: (trigger: SceneInteractionTrigger) => void;
  onSelect: (additive: boolean) => void;
  onEnterScene: (sceneId: string) => void;
  onTransformStart: (event: ReactPointerEvent<HTMLButtonElement>, mode: "move" | "resize") => void;
}) {
  const style = { left: frame.x, top: frame.y, width: frame.width, height: frame.height, zIndex: node.zIndex, ...(!runtime && node.selectable === false ? { pointerEvents: "none" as const } : {}) };
  useEffect(() => {
    if (node.kind !== "data-widget") return;
    const task = window.setTimeout(() => onInteraction("load"), 0);
    return () => window.clearTimeout(task);
  }, [node.id]);
  if (node.kind === "scene-viewport") {
    const scene = application.scenes.find((candidate) => candidate.id === node.sceneId);
    return <article className={`dashboard-node dashboard-scene-viewport ${selected ? "selected" : ""} ${runtime ? "runtime" : ""}`} style={style} onClick={(event) => { event.stopPropagation(); if (!runtime) onSelect(event.ctrlKey || event.metaKey); }} onDoubleClick={() => { if (!runtime) onEnterScene(node.sceneId); }}>
      {scene && node.renderMode !== "static-placeholder"
        ? <SceneViewportPreview locale={locale} node={node} scene={scene} project={project} rendererBackend={rendererBackend} onSelectionChange={onSelectionChange} onObjectInteraction={(trigger, target) => onObjectInteraction(scene.id, trigger, target)} />
        : <div className="dashboard-scene-grid" />}
      {!runtime && <><div className="dashboard-scene-summary"><span><Box size={36} /></span><strong>{scene?.name ?? node.sceneId}</strong><small>{scene ? `${scene.models.length + scene.primitives.length} ${tr(locale, "个场景对象", "scene objects")}` : tr(locale, "场景引用缺失", "Missing scene reference")}</small><button onClick={(event) => { event.stopPropagation(); onEnterScene(node.sceneId); }}>{tr(locale, "进入三维编辑", "Open 3D editor")}</button></div><div className="dashboard-node-badge">3D · {node.renderMode}</div><NodeTransformHandles selected={selected && node.locked !== true} onTransformStart={onTransformStart} /></>}
    </article>;
  }
  if (node.kind === "data-widget") return <article className={`dashboard-node dashboard-native-widget ${selected ? "selected" : ""} ${runtime ? "runtime" : ""}`} style={{ ...style, background: widgetBackground(node.widget), color: node.widget.textColor ?? "#eef2f4" }} onClick={(event) => { event.stopPropagation(); runtime ? onInteraction("click") : onSelect(event.ctrlKey || event.metaKey); }} onPointerEnter={() => onInteraction("pointerEnter")} onPointerLeave={() => onInteraction("pointerLeave")}>
    <DashboardWidgetView locale={locale} widget={node.widget} metric={metric} compact onAnimationStart={() => onInteraction("animationStart")} onAnimationEnd={() => onInteraction("animationEnd")} />
    {!runtime && <><div className="dashboard-node-badge">{dataWidgetTypeLabel(locale, node.widget.type)}</div><NodeTransformHandles selected={selected && node.locked !== true} onTransformStart={onTransformStart} /></>}
  </article>;
  return null;
}

function NodeTransformHandles({ selected, onTransformStart }: { selected: boolean; onTransformStart: (event: ReactPointerEvent<HTMLButtonElement>, mode: "move" | "resize") => void }) {
  if (!selected) return null;
  return <><button className="dashboard-node-move-handle" aria-label="移动组件" onPointerDown={(event) => onTransformStart(event, "move")}><GripVertical size={13} /></button><button className="dashboard-node-resize-handle" aria-label="缩放组件" onPointerDown={(event) => onTransformStart(event, "resize")}><Scaling size={12} /></button></>;
}

function nodeLabel(node: WidgetNode): string {
  if (node.kind === "scene-viewport") return `3D · ${node.sceneId}`;
  return node.widget.title;
}

function sceneName(application: ApplicationDocument, sceneId: string): string {
  return application.scenes.find((scene) => scene.id === sceneId)?.name ?? sceneId;
}

function defaultDataWidget(locale: AppLocale, type: SceneDashboardWidgetType): DashboardDataWidgetConfig {
  const media = type === "image" || type === "video" || type === "monitor" || type === "url";
  return {
    title: dataWidgetTypeLabel(locale, type),
    key: media ? "" : "value",
    type,
    unit: "",
    color: "#d4a84f",
    backgroundColor: "#172126",
    backgroundOpacity: 0.86,
    ...(type === "gauge" ? { min: 0, max: 100 } : {}),
    ...(type === "image" ? { imageFit: "cover" as const } : {}),
    ...(type === "video" ? { videoFit: "contain" as const, videoAutoplay: true, videoMuted: true } : {}),
    ...(type === "monitor" ? { monitorProtocol: "hls" as const, videoFit: "cover" as const, videoAutoplay: true, videoMuted: true } : {}),
    ...(type === "url" ? { url: "https://example.com" } : {})
  };
}

function dataWidgetTypeLabel(locale: AppLocale, type: SceneDashboardWidgetType): string {
  const labels: Record<SceneDashboardWidgetType, [string, string]> = {
    value: ["数值", "Value"], gauge: ["仪表", "Gauge"], status: ["状态", "Status"], line: ["折线", "Line"], area: ["面积", "Area"], bar: ["柱图", "Bar"], pie: ["饼图", "Pie"], table: ["表格", "Table"], image: ["图片", "Image"], video: ["视频", "Video"], monitor: ["监控", "Monitor"], url: ["网页", "Web page"]
  };
  return tr(locale, ...labels[type]);
}
