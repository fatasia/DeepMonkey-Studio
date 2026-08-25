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
import { DASHBOARD_PAGE_MAX_SIZE, DASHBOARD_PAGE_MIN_SIZE, type ApplicationDocument, type ApplicationObjectRef, type DashboardDataWidgetConfig, type DashboardPageDocument, type DashboardViewportFit, type DirectBindingSpec, type JsonValue, type ProjectRecord, type SceneDashboardWidgetType, type SceneInteractionTarget, type SceneInteractionTrigger, type WidgetFrame, type WidgetNode } from "@bim-studio/contracts";
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
  createUpdateDashboardNodeOrderCommand,
  createUpdateDashboardNodeStateCommand,
  createUpdateDashboardNodeStatesCommand,
  createUpdateDashboardPageViewportCommand,
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
import { DashboardMediaInspector } from "./DashboardMediaInspector";
import { createDefaultDirectBinding, DirectBindingEditor } from "./DirectBindingEditor";
import type { RendererBackend } from "../viewer/ViewerEngine";

const DATA_WIDGET_TYPES: SceneDashboardWidgetType[] = ["text", "shape", "value", "gauge", "status", "line", "area", "bar", "pie", "table", "image", "video", "monitor", "url"];
const DASHBOARD_RESOLUTION_PRESETS = [
  { id: "fhd", width: 1920, height: 1080, label: "Full HD · 1920 × 1080" },
  { id: "ultrawide", width: 3840, height: 1080, label: "双联大屏 · 3840 × 1080" },
  { id: "4k", width: 3840, height: 2160, label: "4K · 3840 × 2160" }
] as const;
interface SelectionRect { x: number; y: number; width: number; height: number; }
type InspectorTab = "content" | "data" | "style" | "animation" | "interaction";

export interface DashboardRuntimeViewport {
  scaleX: number;
  scaleY: number;
  stageWidth: number;
  stageHeight: number;
  offsetX: number;
  offsetY: number;
}

export function calculateDashboardRuntimeViewport(page: Pick<DashboardPageDocument, "width" | "height" | "viewportFit">, surfaceWidth: number, surfaceHeight: number): DashboardRuntimeViewport {
  const availableWidth = Math.max(1, surfaceWidth - (page.viewportFit === "fixed" ? 0 : 32));
  const availableHeight = Math.max(1, surfaceHeight - (page.viewportFit === "fixed" ? 0 : 32));
  const widthScale = availableWidth / page.width;
  const heightScale = availableHeight / page.height;
  if (page.viewportFit === "stretch") {
    return { scaleX: widthScale, scaleY: heightScale, stageWidth: availableWidth, stageHeight: availableHeight, offsetX: 0, offsetY: 0 };
  }
  if (page.viewportFit === "fixed") {
    return { scaleX: 1, scaleY: 1, stageWidth: page.width, stageHeight: page.height, offsetX: 0, offsetY: 0 };
  }
  const scale = Math.max(0.01, page.viewportFit === "cover" ? Math.max(widthScale, heightScale) : Math.min(widthScale, heightScale));
  const scaledWidth = page.width * scale;
  const scaledHeight = page.height * scale;
  return page.viewportFit === "cover"
    ? { scaleX: scale, scaleY: scale, stageWidth: availableWidth, stageHeight: availableHeight, offsetX: (availableWidth - scaledWidth) / 2, offsetY: (availableHeight - scaledHeight) / 2 }
    : { scaleX: scale, scaleY: scale, stageWidth: scaledWidth, stageHeight: scaledHeight, offsetX: 0, offsetY: 0 };
}

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
  onOpenTopology: () => void;
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
  onOpenTopology,
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
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("content");
  const [componentSearch, setComponentSearch] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageNameCommitRef = useRef(page.name);
  const clipboardRef = useRef<WidgetNode[]>([]);
  const componentSearchRef = useRef<HTMLInputElement>(null);
  const selectedNode = page.nodes.find((node) => selectedNodeIds.includes(node.id));
  const overflowNodeIds = useMemo(() => page.nodes.filter((node) => node.frame.x < 0 || node.frame.y < 0 || node.frame.x + node.frame.width > page.width || node.frame.y + node.frame.height > page.height).map((node) => node.id), [page.nodes, page.width, page.height]);
  const layoutSelectionCount = page.nodes.filter((node) => selectedNodeIds.includes(node.id) && node.visible !== false && node.locked !== true).length;
  const dataWidgetConfigs = useMemo(() => page.nodes.flatMap((node) => node.kind === "data-widget" ? [node.widget] : []), [page.nodes]);
  const { metrics, datasets, pipelines, fieldsByProduct, statusByProduct, catalogError, connected } = useDashboardMetrics(project.id, dataWidgetConfigs);
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
    setInspectorTab("content");
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

  function reorderSelectedNodes(direction: "front" | "forward" | "backward" | "back") {
    const selected = new Set(page.nodes.filter((node) => selectedNodeIds.includes(node.id) && node.locked !== true).map((node) => node.id));
    if (selected.size === 0) return;
    const ordered = [...page.nodes].sort((left, right) => left.zIndex - right.zIndex);
    if (direction === "front" || direction === "back") {
      const picked = ordered.filter((node) => selected.has(node.id));
      const rest = ordered.filter((node) => !selected.has(node.id));
      ordered.splice(0, ordered.length, ...(direction === "front" ? [...rest, ...picked] : [...picked, ...rest]));
    } else if (direction === "forward") {
      for (let index = ordered.length - 2; index >= 0; index -= 1) {
        if (selected.has(ordered[index]!.id) && !selected.has(ordered[index + 1]!.id)) [ordered[index], ordered[index + 1]] = [ordered[index + 1]!, ordered[index]!];
      }
    } else {
      for (let index = 1; index < ordered.length; index += 1) {
        if (selected.has(ordered[index]!.id) && !selected.has(ordered[index - 1]!.id)) [ordered[index - 1], ordered[index]] = [ordered[index]!, ordered[index - 1]!];
      }
    }
    const order = ordered.map((node, zIndex) => ({ nodeId: node.id, zIndex })).filter(({ nodeId, zIndex }) => page.nodes.find((node) => node.id === nodeId)!.zIndex !== zIndex);
    if (order.length > 0) onCommand(createUpdateDashboardNodeOrderCommand(page.id, order));
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
      if (commandKey && key === "f") { event.preventDefault(); componentSearchRef.current?.focus(); return; }
      if (commandKey && (key === "]" || key === "[")) {
        event.preventDefault();
        reorderSelectedNodes(key === "]" ? event.shiftKey ? "front" : "forward" : event.shiftKey ? "back" : "backward");
        return;
      }
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
      width: page.width,
      height: page.height,
      viewportFit: page.viewportFit,
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

  function commitPageViewport(viewport: { width?: number; height?: number; viewportFit?: DashboardViewportFit }) {
    const width = normalizeDashboardSize(viewport.width ?? page.width, page.width);
    const height = normalizeDashboardSize(viewport.height ?? page.height, page.height);
    const viewportFit = viewport.viewportFit ?? page.viewportFit;
    if (width === page.width && height === page.height && viewportFit === page.viewportFit) return;
    onCommand(createUpdateDashboardPageViewportCommand(page.id, { width, height, viewportFit }));
  }

  function selectOverflowNodes() {
    setSelectedNodeIds(overflowNodeIds);
    onSelectionChange(overflowNodeIds.map((id) => ({ kind: "widget", id })));
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

  function selectDataProduct(value: string) {
    if (!selectedNode || selectedNode.kind !== "data-widget") return;
    const next = { ...selectedNode.widget };
    delete next.datasetId;
    delete next.pipelineId;
    delete next.directBinding;
    delete next.field;
    if (value) {
      const separator = value.indexOf(":");
      const kind = value.slice(0, separator);
      const id = value.slice(separator + 1);
      if (kind === "dataset") next.datasetId = id;
      if (kind === "pipeline") next.pipelineId = id;
      const firstField = fieldsByProduct[value]?.[0];
      if (firstField) {
        next.field = firstField.key;
        next.key = `${id}.${firstField.key}`;
        if (!next.unit && firstField.unit) next.unit = firstField.unit;
      }
    }
    onCommand(createUpdateDashboardDataWidgetCommand(page.id, selectedNode.id, next));
  }

  function selectDataField(fieldKey: string) {
    if (!selectedNode || selectedNode.kind !== "data-widget") return;
    const productId = selectedNode.widget.pipelineId ?? selectedNode.widget.datasetId;
    const productKey = selectedNode.widget.pipelineId ? `pipeline:${selectedNode.widget.pipelineId}` : selectedNode.widget.datasetId ? `dataset:${selectedNode.widget.datasetId}` : undefined;
    if (!productId || !productKey) return;
    const field = fieldsByProduct[productKey]?.find((candidate) => candidate.key === fieldKey);
    updateDataWidget({ field: fieldKey, key: `${productId}.${fieldKey}`, ...(!selectedNode.widget.unit && field?.unit ? { unit: field.unit } : {}) });
  }

  if (runtimePreview) return <DashboardRuntimePreview locale={locale} application={application} project={project} page={page} rendererBackend={rendererBackend} metrics={runtimeMetrics} connected={connected} onClose={() => setRuntimePreview(false)} onSelectionChange={onSelectionChange} onObjectInteraction={onObjectInteraction} onNodeInteraction={onNodeInteraction} />;

  return <main className="dashboard-workspace">
    <header className="dashboard-workspace-topbar">
      <button className="dashboard-back" onClick={onBack}><ArrowLeft size={16} />{tr(locale, "项目", "Project")}</button>
      <div className="dashboard-workspace-title"><LayoutDashboard size={17} /><div><strong>{application.metadata.name}</strong><span>{dirty ? tr(locale, "有未保存修改", "Unsaved changes") : tr(locale, "所有修改已保存", "All changes saved")}</span></div></div>
      <nav className="workspace-mode-switch" aria-label={tr(locale, "编辑模式", "Editor mode")}>
        <button className="active"><LayoutDashboard size={14} />{tr(locale, "二维设计", "2D design")}</button>
        <button onClick={onOpenTopology}><Workflow size={14} />{tr(locale, "拓扑", "Topology")}</button>
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
        <details className="dashboard-compact-page-settings"><summary>{tr(locale, "画布尺寸与适配", "Canvas size & fit")}<small>{page.width} × {page.height}</small></summary><DashboardPageViewportEditor locale={locale} page={page} onChange={commitPageViewport} compact /></details>
      </section>
      <section className="dashboard-component-library">
        <div className="dashboard-panel-label"><span>{tr(locale, "组件", "Components")}</span><small>{connected ? tr(locale, "实时", "Live") : tr(locale, "离线", "Offline")}</small></div>
        <input ref={componentSearchRef} className="dashboard-component-search" aria-label={tr(locale, "搜索组件", "Search components")} value={componentSearch} onChange={(event) => setComponentSearch(event.target.value)} placeholder={tr(locale, "搜索组件 · Ctrl+F", "Search · Ctrl+F")} />
        <div>{DATA_WIDGET_TYPES.filter((type) => dataWidgetTypeLabel(locale, type).toLocaleLowerCase().includes(componentSearch.trim().toLocaleLowerCase())).map((type) => <button key={type} onClick={() => addDataWidget(type)}><Plus size={11} /><span>{dataWidgetTypeLabel(locale, type)}</span></button>)}</div>
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
        <span>{page.width} × {page.height}<small>{tr(locale, "Shift 拖动框选 · 方向键微调 · Shift 10px · Ctrl/Cmd+C/V/D", "Shift-drag selects · Arrows nudge · Shift 10px · Ctrl/Cmd+C/V/D")}</small>{overflowNodeIds.length > 0 && <button className="dashboard-overflow-warning" title={tr(locale, "选择所有超出页面边界的组件", "Select all components outside the page bounds")} onClick={selectOverflowNodes}>{tr(locale, `${overflowNodeIds.length} 个组件越界`, `${overflowNodeIds.length} out of bounds`)}</button>}</span>
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
        <DashboardPageViewportEditor locale={locale} page={page} onChange={commitPageViewport} />
      </section>
      {selectedNode ? <>
        <div className="dashboard-selection-heading dashboard-selection-summary"><span>{selectedNode.kind === "scene-viewport" ? <Box size={15} /> : <Layers3 size={15} />}</span><div><strong>{nodeLabel(selectedNode)}</strong><small>{selectedNode.id}</small></div></div>
        <nav className="dashboard-inspector-tabs" aria-label={tr(locale, "属性分类", "Property categories")}>{([
          ["content", tr(locale, "内容", "Content")], ["data", tr(locale, "数据", "Data")], ["style", tr(locale, "样式", "Style")], ["animation", tr(locale, "动画", "Animation")], ["interaction", tr(locale, "交互", "Interaction")]
        ] as Array<[InspectorTab, string]>).map(([tab, label]) => <button key={tab} className={inspectorTab === tab ? "active" : ""} onClick={() => setInspectorTab(tab)}>{label}</button>)}</nav>

        {inspectorTab === "content" && <>
          <section className="dashboard-inspector-section">
            <div className="dashboard-frame-grid">{(["x", "y", "width", "height"] as const).map((field) => <label key={field}><span>{field.toUpperCase()}</span><input type="number" disabled={selectedNode.locked === true} value={selectedNode.frame[field]} onChange={(event) => updateSelectedFrame(field, Number(event.target.value))} /></label>)}</div>
            <div className="dashboard-layer-order-actions"><button disabled={selectedNode.locked === true} onClick={() => reorderSelectedNodes("back")}>{tr(locale, "置底", "To back")}</button><button disabled={selectedNode.locked === true} onClick={() => reorderSelectedNodes("backward")}>{tr(locale, "下移", "Backward")}</button><button disabled={selectedNode.locked === true} onClick={() => reorderSelectedNodes("forward")}>{tr(locale, "上移", "Forward")}</button><button disabled={selectedNode.locked === true} onClick={() => reorderSelectedNodes("front")}>{tr(locale, "置顶", "To front")}</button></div>
          </section>
          {selectedNode.kind === "scene-viewport" && <section className="dashboard-inspector-section"><div className="dashboard-readonly-property"><span>{tr(locale, "三维场景", "3D scene")}</span><strong>{sceneName(application, selectedNode.sceneId)}</strong></div><div className="dashboard-readonly-property"><span>{tr(locale, "渲染方式", "Render mode")}</span><strong>{selectedNode.renderMode}</strong></div><button className="dashboard-enter-scene" onClick={() => onEnterScene(selectedNode.sceneId, currentView())}><Box size={15} />{tr(locale, "进入三维编辑", "Open 3D editor")}</button></section>}
          {selectedNode.kind === "data-widget" && <section className="dashboard-inspector-section dashboard-data-widget-properties">
            <label><span>{tr(locale, "类型", "Type")}</span><select value={selectedNode.widget.type} onChange={(event) => updateDataWidget({ type: event.target.value as SceneDashboardWidgetType })}>{DATA_WIDGET_TYPES.map((type) => <option key={type} value={type}>{dataWidgetTypeLabel(locale, type)}</option>)}</select></label>
            <label><span>{tr(locale, "标题", "Title")}</span><input defaultValue={selectedNode.widget.title} key={`${selectedNode.id}:title:${selectedNode.widget.title}`} onBlur={(event) => { if (event.currentTarget.value !== selectedNode.widget.title) updateDataWidget({ title: event.currentTarget.value }); }} /></label>
            {(selectedNode.widget.type === "text" || selectedNode.widget.type === "shape") && <label><span>{tr(locale, "内容", "Content")}</span><input defaultValue={selectedNode.widget.content ?? ""} onBlur={(event) => updateDataWidget({ content: event.currentTarget.value })} /></label>}
            {selectedNode.widget.type === "shape" && <label><span>{tr(locale, "形状", "Shape")}</span><select value={selectedNode.widget.shape ?? "rounded"} onChange={(event) => updateDataWidget({ shape: event.target.value as NonNullable<DashboardDataWidgetConfig["shape"]> })}><option value="rectangle">{tr(locale, "矩形", "Rectangle")}</option><option value="rounded">{tr(locale, "圆角矩形", "Rounded")}</option><option value="ellipse">{tr(locale, "椭圆", "Ellipse")}</option><option value="line">{tr(locale, "线", "Line")}</option></select></label>}
            {(selectedNode.widget.type === "image" || selectedNode.widget.type === "video" || selectedNode.widget.type === "monitor") && <DashboardMediaInspector locale={locale} projectId={project.id} widget={selectedNode.widget} onChange={updateDataWidget} />}
            {selectedNode.widget.type === "url" && <label><span>{tr(locale, "网页地址", "Web page URL")}</span><input defaultValue={selectedNode.widget.url ?? ""} onBlur={(event) => updateDataWidget({ url: event.currentTarget.value })} /></label>}
          </section>}
        </>}

        {inspectorTab === "data" && selectedNode.kind === "data-widget" && !["text", "shape"].includes(selectedNode.widget.type) && <section className="dashboard-inspector-section dashboard-data-widget-properties">
          <label><span>{tr(locale, "数据来源", "Data source")}</span><select value={selectedNode.widget.directBinding ? "direct" : selectedNode.widget.pipelineId || selectedNode.widget.datasetId ? "platform" : "unbound"} onChange={(event) => {
            const mode = event.target.value;
            if (mode === "direct") {
              const next = { ...selectedNode.widget, directBinding: createDefaultDirectBinding() };
              delete next.datasetId; delete next.pipelineId;
              onCommand(createUpdateDashboardDataWidgetCommand(page.id, selectedNode.id, next));
            } else if (mode === "platform") selectDataProduct(pipelines[0] ? `pipeline:${pipelines[0].id}` : datasets[0] ? `dataset:${datasets[0].id}` : "");
            else selectDataProduct("");
          }}><option value="unbound">{tr(locale, "实时变量 / 未绑定", "Live variable / Unbound")}</option><option value="platform">{tr(locale, "数据中台", "Data platform")}</option><option value="direct">{tr(locale, "直接 HTTP / WebSocket", "Direct HTTP / WebSocket")}</option></select></label>
          {!selectedNode.widget.directBinding && (selectedNode.widget.pipelineId || selectedNode.widget.datasetId) && <label><span>{tr(locale, "数据产品", "Data product")}</span><select value={selectedNode.widget.pipelineId ? `pipeline:${selectedNode.widget.pipelineId}` : selectedNode.widget.datasetId ? `dataset:${selectedNode.widget.datasetId}` : ""} onChange={(event) => selectDataProduct(event.target.value)}>{pipelines.length > 0 && <optgroup label={tr(locale, "数据管道（推荐）", "Data pipelines (recommended)")}>{pipelines.map((pipeline) => <option key={pipeline.id} value={`pipeline:${pipeline.id}`}>{pipeline.name}</option>)}</optgroup>}{datasets.length > 0 && <optgroup label={tr(locale, "原始数据集", "Raw datasets")}>{datasets.map((dataset) => <option key={dataset.id} value={`dataset:${dataset.id}`}>{dataset.name}</option>)}</optgroup>}</select></label>}
          {selectedNode.widget.directBinding && <DirectBindingEditor locale={locale} value={selectedNode.widget.directBinding} onChange={(directBinding: DirectBindingSpec) => updateDataWidget({ directBinding, key: selectedNode.widget.key || directBinding.selection?.field || "value" })} />}
          {(() => {
            if (selectedNode.widget.directBinding) return <label><span>{tr(locale, "组件数据键", "Widget data key")}</span><input value={selectedNode.widget.key} onChange={(event) => updateDataWidget({ key: event.target.value })} /></label>;
            const productId = selectedNode.widget.pipelineId ?? selectedNode.widget.datasetId;
            const productKey = selectedNode.widget.pipelineId ? `pipeline:${selectedNode.widget.pipelineId}` : selectedNode.widget.datasetId ? `dataset:${selectedNode.widget.datasetId}` : undefined;
            const status = productKey ? statusByProduct[productKey] : undefined;
            const fields = productKey ? fieldsByProduct[productKey] ?? [] : [];
            if (!productId) return <label><span>{tr(locale, "数据键", "Data key")}</span><input defaultValue={selectedNode.widget.key} key={`${selectedNode.id}:key:${selectedNode.widget.key}`} onBlur={(event) => { if (event.currentTarget.value !== selectedNode.widget.key) updateDataWidget({ key: event.currentTarget.value }); }} /></label>;
            if (status === "loading" && fields.length === 0) return <div className="dashboard-data-binding-state">{tr(locale, "正在读取字段…", "Loading fields…")}</div>;
            if (status === "error") return <div className="dashboard-data-binding-state error">{tr(locale, "数据产品运行失败，请到数据中心检查节点诊断。", "The data product failed. Open Data Center for node diagnostics.")}</div>;
            return <label><span>{tr(locale, "字段", "Field")}</span><select value={selectedNode.widget.field ?? ""} onChange={(event) => selectDataField(event.target.value)}><option value="">{tr(locale, "选择输出字段", "Choose an output field")}</option>{fields.map((field) => <option key={field.key} value={field.key}>{field.label}{field.unit ? ` · ${field.unit}` : ""}</option>)}</select></label>;
          })()}
          {catalogError && <div className="dashboard-data-binding-state error">{tr(locale, "数据目录暂不可用，请稍后重试。", "The data catalog is temporarily unavailable.")}</div>}
          <small className="dashboard-inspector-hint">{tr(locale, "同一数据产品可同时驱动二维组件、三维对象和对外接口。选择字段后会自动生成绑定键。", "The same data product can drive 2D widgets, 3D objects, and external endpoints. Choosing a field creates the binding key automatically.")}</small>
          <label><span>{tr(locale, "单位", "Unit")}</span><input defaultValue={selectedNode.widget.unit} key={`${selectedNode.id}:unit:${selectedNode.widget.unit}`} onBlur={(event) => { if (event.currentTarget.value !== selectedNode.widget.unit) updateDataWidget({ unit: event.currentTarget.value }); }} /></label>
          <label><span>{tr(locale, "设计数据状态", "Design data state")}</span><select value={selectedNode.widget.designState ?? "auto"} onChange={(event) => updateDataWidget({ designState: event.target.value as NonNullable<DashboardDataWidgetConfig["designState"]> })}><option value="auto">{tr(locale, "自动 / 实时", "Auto / Live")}</option><option value="empty">{tr(locale, "空数据", "Empty")}</option><option value="loading">{tr(locale, "加载中", "Loading")}</option><option value="partial">{tr(locale, "部分数据", "Partial")}</option><option value="error">{tr(locale, "错误", "Error")}</option><option value="forbidden">{tr(locale, "无权限", "No permission")}</option></select></label>
          {selectedNode.widget.type === "gauge" && <div className="dashboard-frame-grid"><label><span>MIN</span><input type="number" value={selectedNode.widget.min ?? 0} onChange={(event) => updateDataWidget({ min: Number(event.target.value) })} /></label><label><span>MAX</span><input type="number" value={selectedNode.widget.max ?? 100} onChange={(event) => updateDataWidget({ max: Number(event.target.value) })} /></label></div>}
        </section>}

        {inspectorTab === "style" && selectedNode.kind === "data-widget" && <section className="dashboard-inspector-section dashboard-data-widget-properties">
          <label><span>{tr(locale, "强调色", "Accent")}</span><input type="color" value={selectedNode.widget.color ?? "#d4a84f"} onChange={(event) => updateDataWidget({ color: event.target.value })} /></label>
          <label><span>{tr(locale, "背景色", "Background")}</span><input type="color" value={selectedNode.widget.backgroundColor ?? "#172126"} onChange={(event) => updateDataWidget({ backgroundColor: event.target.value })} /></label>
          <label><span>{tr(locale, "文字色", "Text color")}</span><input type="color" value={selectedNode.widget.textColor ?? "#eef2f4"} onChange={(event) => updateDataWidget({ textColor: event.target.value })} /></label>
          {selectedNode.widget.type === "text" && <><label><span>{tr(locale, "字号", "Font size")}</span><input type="number" min="8" max="240" value={selectedNode.widget.fontSize ?? 28} onChange={(event) => updateDataWidget({ fontSize: Number(event.target.value) })} /></label><label><span>{tr(locale, "对齐", "Alignment")}</span><select value={selectedNode.widget.textAlign ?? "left"} onChange={(event) => updateDataWidget({ textAlign: event.target.value as NonNullable<DashboardDataWidgetConfig["textAlign"]> })}><option value="left">{tr(locale, "左", "Left")}</option><option value="center">{tr(locale, "中", "Center")}</option><option value="right">{tr(locale, "右", "Right")}</option></select></label></>}
          {selectedNode.widget.type === "shape" && <><label><span>{tr(locale, "边框色", "Border color")}</span><input type="color" value={selectedNode.widget.borderColor ?? "#f0cd78"} onChange={(event) => updateDataWidget({ borderColor: event.target.value })} /></label><label><span>{tr(locale, "边框宽度", "Border width")}</span><input type="number" min="0" max="24" value={selectedNode.widget.borderWidth ?? 1} onChange={(event) => updateDataWidget({ borderWidth: Number(event.target.value) })} /></label></>}
          <label><span>{tr(locale, "背景透明度", "Background opacity")}</span><input type="range" min="0" max="1" step="0.05" value={selectedNode.widget.backgroundOpacity ?? 0.86} onChange={(event) => updateDataWidget({ backgroundOpacity: Number(event.target.value) })} /></label>
        </section>}

        {inspectorTab === "data" && selectedNode.kind === "data-widget" && ["text", "shape"].includes(selectedNode.widget.type) && <div className="dashboard-inspector-empty">{tr(locale, "静态组件不需要数据绑定。", "Static components do not require data binding.")}</div>}

        {inspectorTab === "animation" && selectedNode.kind === "data-widget" && <section className="dashboard-inspector-section dashboard-data-widget-properties">
          <label><span>{tr(locale, "进入动画", "Enter animation")}</span><select value={selectedNode.widget.animation ?? "none"} onChange={(event) => updateDataWidget({ animation: event.target.value as NonNullable<DashboardDataWidgetConfig["animation"]> })}><option value="none">{tr(locale, "无", "None")}</option><option value="fade">Fade</option><option value="slide-up">Slide up</option><option value="scale">Scale</option><option value="pulse">Pulse</option></select></label>
          <label><span>{tr(locale, "时长（秒）", "Duration (s)")}</span><input type="number" min="0.1" step="0.1" value={selectedNode.widget.animationDuration ?? 0.6} onChange={(event) => updateDataWidget({ animationDuration: Math.max(0.1, Number(event.target.value)) })} /></label>
          <label><span>{tr(locale, "延迟（秒）", "Delay (s)")}</span><input type="number" min="0" step="0.1" value={selectedNode.widget.animationDelay ?? 0} onChange={(event) => updateDataWidget({ animationDelay: Math.max(0, Number(event.target.value)) })} /></label>
          <small className="dashboard-inspector-hint">{tr(locale, "动画只在预览运行态播放，不污染设计状态。", "Animations play only in runtime preview and never mutate design state.")}</small>
        </section>}

        {((inspectorTab === "data" || inspectorTab === "style" || inspectorTab === "animation") && selectedNode.kind === "scene-viewport") && <div className="dashboard-inspector-empty">{tr(locale, "三维组件的该类属性请进入三维编辑器配置。", "Configure this property category in the 3D editor.")}</div>}
        {inspectorTab === "interaction" && <InteractionFlowInspector locale={locale} application={application} source={{ kind: "widget", id: selectedNode.id }} onCommand={onCommand} onTest={(trigger) => onNodeInteraction(selectedNode.id, trigger)} />}
        <section className="dashboard-inspector-section"><button className="dashboard-delete-node" disabled={!page.nodes.some((node) => selectedNodeIds.includes(node.id) && node.locked !== true)} onClick={deleteSelectedNodes}><Minus size={13} />{selectedNodeIds.length > 1 ? tr(locale, "删除未锁定的所选组件", "Delete unlocked selection") : selectedNode.locked ? tr(locale, "图层已锁定", "Layer locked") : tr(locale, "删除组件", "Delete component")}</button></section>
      </> : <div className="dashboard-no-selection"><Layers3 size={24} /><span>{tr(locale, "选择页面中的组件以编辑属性", "Select a component on the page to edit its properties")}</span></div>}
    </aside>
  </main>;
}

function DashboardPageViewportEditor({ locale, page, onChange, compact = false }: {
  locale: AppLocale;
  page: DashboardPageDocument;
  onChange: (viewport: { width?: number; height?: number; viewportFit?: DashboardViewportFit }) => void;
  compact?: boolean;
}) {
  return <div className={`dashboard-page-viewport-editor ${compact ? "compact" : ""}`}>
    <label><span>{tr(locale, "逻辑分辨率", "Logical resolution")}</span><select value={dashboardResolutionPreset(page)} onChange={(event) => { const preset = DASHBOARD_RESOLUTION_PRESETS.find((candidate) => candidate.id === event.target.value); if (preset) onChange({ width: preset.width, height: preset.height }); }}><option value="custom">{tr(locale, "自定义", "Custom")}</option>{DASHBOARD_RESOLUTION_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label>
    <div className="dashboard-frame-grid dashboard-resolution-grid">
      <label><span>W</span><input key={`${page.id}:width:${page.width}`} aria-label={tr(locale, "页面宽度", "Page width")} type="number" min={DASHBOARD_PAGE_MIN_SIZE} max={DASHBOARD_PAGE_MAX_SIZE} defaultValue={page.width} onBlur={(event) => onChange({ width: Number(event.currentTarget.value) })} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
      <label><span>H</span><input key={`${page.id}:height:${page.height}`} aria-label={tr(locale, "页面高度", "Page height")} type="number" min={DASHBOARD_PAGE_MIN_SIZE} max={DASHBOARD_PAGE_MAX_SIZE} defaultValue={page.height} onBlur={(event) => onChange({ height: Number(event.currentTarget.value) })} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
    </div>
    <label><span>{tr(locale, "屏幕适配", "Display fit")}</span><select value={page.viewportFit} onChange={(event) => onChange({ viewportFit: event.target.value as DashboardViewportFit })}><option value="contain">{tr(locale, "完整显示（推荐）", "Contain (recommended)")}</option><option value="cover">{tr(locale, "铺满并裁切", "Cover and crop")}</option><option value="stretch">{tr(locale, "拉伸铺满", "Stretch to fill")}</option><option value="fixed">{tr(locale, "原始像素 / 滚动", "Fixed pixels / scroll")}</option></select></label>
    {!compact && <small className="dashboard-inspector-hint">{tr(locale, `支持 ${DASHBOARD_PAGE_MIN_SIZE}–${DASHBOARD_PAGE_MAX_SIZE}px；修改尺寸不会自动缩放已有组件，越界组件会在画布工具栏提示。`, `Supports ${DASHBOARD_PAGE_MIN_SIZE}–${DASHBOARD_PAGE_MAX_SIZE}px. Existing widgets are not resized automatically; out-of-bounds widgets are reported in the canvas toolbar.`)}</small>}
  </div>;
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
  const [viewport, setViewport] = useState<DashboardRuntimeViewport>(() => calculateDashboardRuntimeViewport(page, page.width * 0.5 + 32, page.height * 0.5 + 32));
  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const resize = () => {
      setViewport(calculateDashboardRuntimeViewport(page, surface.clientWidth, surface.clientHeight));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [page.width, page.height, page.viewportFit]);
  const scaleLabel = Math.abs(viewport.scaleX - viewport.scaleY) < 0.001
    ? `${Math.round(viewport.scaleX * 100)}%`
    : `${Math.round(viewport.scaleX * 100)}% × ${Math.round(viewport.scaleY * 100)}%`;
  return <main className="dashboard-runtime-preview">
    <header><div><Eye size={16} /><span><strong>{application.metadata.name}</strong><small>{page.name} · {page.width} × {page.height} · {connected ? tr(locale, "实时数据", "Live data") : tr(locale, "离线预览", "Offline preview")}</small></span></div><div><span>{scaleLabel}</span><button onClick={onClose}><X size={15} />{tr(locale, "退出预览", "Exit preview")}</button></div></header>
    <section ref={surfaceRef} className={`dashboard-runtime-surface fit-${page.viewportFit}`}><div className="dashboard-runtime-stage" style={{ width: viewport.stageWidth, height: viewport.stageHeight }}><div className="dashboard-artboard dashboard-runtime-artboard" style={{ width: page.width, height: page.height, left: viewport.offsetX, top: viewport.offsetY, transform: `scale(${viewport.scaleX}, ${viewport.scaleY})` }}>{page.nodes.filter((node) => node.visible !== false).map((node) => <DashboardNode key={node.id} runtime application={application} project={project} node={node} frame={node.frame} metric={node.kind === "data-widget" ? metrics[node.widget.key] : undefined} selected={false} locale={locale} rendererBackend={rendererBackend} onSelectionChange={onSelectionChange} onObjectInteraction={onObjectInteraction} onInteraction={(trigger) => onNodeInteraction(node.id, trigger)} onSelect={() => undefined} onEnterScene={() => undefined} onTransformStart={() => undefined} />)}</div></div></section>
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
  if (node.kind === "data-widget") return <article className={`dashboard-node dashboard-native-widget ${selected ? "selected" : ""} ${runtime ? `runtime animation-${node.widget.animation ?? "none"}` : ""}`} style={{ ...style, background: widgetBackground(node.widget), color: node.widget.textColor ?? "#eef2f4", animationDuration: `${node.widget.animationDuration ?? 0.6}s`, animationDelay: `${node.widget.animationDelay ?? 0}s` }} onClick={(event) => { event.stopPropagation(); runtime ? onInteraction("click") : onSelect(event.ctrlKey || event.metaKey); }} onPointerEnter={() => onInteraction("pointerEnter")} onPointerLeave={() => onInteraction("pointerLeave")} onAnimationStart={() => onInteraction("animationStart")} onAnimationEnd={() => onInteraction("animationEnd")}>
    <DashboardWidgetView locale={locale} widget={node.widget} metric={metric} compact={!runtime} onAnimationStart={() => onInteraction("animationStart")} onAnimationEnd={() => onInteraction("animationEnd")} />
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

function dashboardResolutionPreset(page: DashboardPageDocument): string {
  return DASHBOARD_RESOLUTION_PRESETS.find((preset) => preset.width === page.width && preset.height === page.height)?.id ?? "custom";
}

function normalizeDashboardSize(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(DASHBOARD_PAGE_MAX_SIZE, Math.max(DASHBOARD_PAGE_MIN_SIZE, Math.round(value)));
}

function sceneName(application: ApplicationDocument, sceneId: string): string {
  return application.scenes.find((scene) => scene.id === sceneId)?.name ?? sceneId;
}

function defaultDataWidget(locale: AppLocale, type: SceneDashboardWidgetType): DashboardDataWidgetConfig {
  const media = type === "image" || type === "video" || type === "monitor" || type === "url";
  const staticWidget = type === "text" || type === "shape";
  return {
    title: dataWidgetTypeLabel(locale, type),
    key: media || staticWidget ? "" : "value",
    type,
    unit: "",
    color: "#d4a84f",
    backgroundColor: "#172126",
    backgroundOpacity: 0.86,
    ...(type === "text" ? { content: tr(locale, "文本内容", "Text content"), fontSize: 28, fontWeight: 600, textAlign: "left" as const, backgroundOpacity: 0 } : {}),
    ...(type === "shape" ? { shape: "rounded" as const, content: "", color: "#d4a84f", borderColor: "#f0cd78", borderWidth: 1, backgroundOpacity: 0 } : {}),
    ...(type === "gauge" ? { min: 0, max: 100 } : {}),
    ...(type === "image" ? { imageFit: "cover" as const } : {}),
    ...(type === "video" ? { videoFit: "contain" as const, videoAutoplay: true, videoMuted: true } : {}),
    ...(type === "monitor" ? { monitorProtocol: "hls" as const, videoFit: "cover" as const, videoAutoplay: true, videoMuted: true } : {}),
    ...(type === "url" ? { url: "https://example.com" } : {})
  };
}

function dataWidgetTypeLabel(locale: AppLocale, type: SceneDashboardWidgetType): string {
  const labels: Record<SceneDashboardWidgetType, [string, string]> = {
    text: ["文本", "Text"], shape: ["形状", "Shape"], value: ["数值", "Value"], gauge: ["仪表", "Gauge"], status: ["状态", "Status"], line: ["折线", "Line"], area: ["面积", "Area"], bar: ["柱图", "Bar"], pie: ["饼图", "Pie"], table: ["表格", "Table"], image: ["图片", "Image"], video: ["视频", "Video"], monitor: ["监控", "Monitor"], url: ["网页", "Web page"]
  };
  return tr(locale, ...labels[type]);
}
