import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import {
  ArrowLeft,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Box,
  Braces,
  Copy,
  Database,
  Eye,
  EyeOff,
  ExternalLink,
  GripVertical,
  Group,
  Layers3,
  LayoutDashboard,
  Lock,
  Minus,
  Plus,
  Redo2,
  Rocket,
  Save,
  Search,
  Scaling,
  ScanSearch,
  Trash2,
  Undo2,
  Ungroup,
  Unlock,
  Workflow,
  X
} from "lucide-react";
import { DASHBOARD_PAGE_MAX_SIZE, DASHBOARD_PAGE_MIN_SIZE, type ApplicationDocument, type ApplicationObjectRef, type DashboardDataWidgetConfig, type DashboardGuide, type DashboardPageDocument, type DashboardViewportFit, type DirectBindingSpec, type JsonValue, type ProjectRecord, type SceneDashboardWidgetType, type SceneInteractionTarget, type SceneInteractionTrigger, type WidgetFrame, type WidgetNode } from "@bim-studio/contracts";
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
  createUpdateDashboardSceneViewportCommand,
  createUpdateDashboardPageViewportCommand,
  createUpdateDashboardPageGuidesCommand,
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

const DATA_WIDGET_TYPES: SceneDashboardWidgetType[] = ["text", "shape", "decoration", "value", "progress", "status", "gauge", "line", "area", "bar", "pie", "scatter", "radar", "funnel", "rank", "table", "filter", "image", "video", "monitor", "url", "topology"];
const DATA_WIDGET_CATEGORIES: Array<{ id: string; zh: string; en: string; types: SceneDashboardWidgetType[] }> = [
  { id: "analysis", zh: "图表", en: "Charts", types: ["line", "area", "bar", "pie", "scatter", "radar", "funnel", "gauge"] },
  { id: "indicator", zh: "指标与表格", en: "Metrics & tables", types: ["value", "progress", "status", "rank", "table"] },
  { id: "control", zh: "筛选与内容", en: "Controls & content", types: ["filter", "text", "shape", "decoration"] },
  { id: "media", zh: "媒体与扩展", en: "Media & extensions", types: ["image", "video", "monitor", "url", "topology"] }
];
const DASHBOARD_TEMPLATES: Array<{ id: "operations" | "production" | "energy"; zh: string; en: string; categoryZh: string; categoryEn: string; descriptionZh: string; descriptionEn: string }> = [
  { id: "operations", zh: "经营驾驶舱", en: "Operations cockpit", categoryZh: "经营分析", categoryEn: "Operations", descriptionZh: "指标卡、趋势、结构分析与明细表", descriptionEn: "KPIs, trends, breakdown and detail table" },
  { id: "production", zh: "生产运行监控", en: "Production monitoring", categoryZh: "工业生产", categoryEn: "Manufacturing", descriptionZh: "产量、OEE、良率、告警和产线趋势", descriptionEn: "Output, OEE, yield, alarms and line trends" },
  { id: "energy", zh: "能源效率分析", en: "Energy efficiency", categoryZh: "能源管理", categoryEn: "Energy", descriptionZh: "综合能耗、单位能耗、负荷和节能分析", descriptionEn: "Consumption, intensity, load and savings" }
];
const DASHBOARD_RESOLUTION_PRESETS = [
  { id: "fhd", width: 1920, height: 1080, label: "Full HD · 1920 × 1080" },
  { id: "ultrawide", width: 3840, height: 1080, label: "双联大屏 · 3840 × 1080" },
  { id: "4k", width: 3840, height: 2160, label: "4K · 3840 × 2160" }
] as const;
interface SelectionRect { x: number; y: number; width: number; height: number; }
interface ActiveSnapLines { x: number[]; y: number[]; }
interface DashboardContextMenuState { x: number; y: number; nodeId: string; }
type InspectorTab = "content" | "data" | "style" | "animation" | "interaction";
const RULER_SIZE = 14;
const CANVAS_MARGIN = 72;
const SNAP_THRESHOLD_PX = 6;

export interface DashboardRuntimeViewport {
  scaleX: number;
  scaleY: number;
  stageWidth: number;
  stageHeight: number;
  offsetX: number;
  offsetY: number;
}

export function calculateDashboardRuntimeViewport(page: Pick<DashboardPageDocument, "width" | "height" | "viewportFit">, surfaceWidth: number, surfaceHeight: number): DashboardRuntimeViewport {
  const availableWidth = Math.max(1, surfaceWidth);
  const availableHeight = Math.max(1, surfaceHeight);
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

export function calculateDashboardEditorZoom(page: Pick<DashboardPageDocument, "width" | "height">, surfaceWidth: number, surfaceHeight: number): number {
  const availableWidth = Math.max(120, surfaceWidth - 84);
  const availableHeight = Math.max(120, surfaceHeight - 84);
  return Math.max(0.1, Math.min(2, Number(Math.min(availableWidth / page.width, availableHeight / page.height).toFixed(3))));
}

export function snapDashboardFrame(frame: WidgetFrame, mode: "move" | "resize", xCandidates: readonly number[], yCandidates: readonly number[], threshold: number): { frame: WidgetFrame; lines: ActiveSnapLines } {
  const xAnchors = mode === "move" ? [frame.x, frame.x + frame.width / 2, frame.x + frame.width] : [frame.x + frame.width];
  const yAnchors = mode === "move" ? [frame.y, frame.y + frame.height / 2, frame.y + frame.height] : [frame.y + frame.height];
  const xSnap = nearestSnap(xAnchors, xCandidates, threshold);
  const ySnap = nearestSnap(yAnchors, yCandidates, threshold);
  return {
    frame: mode === "move"
      ? { ...frame, x: frame.x + (xSnap?.delta ?? 0), y: frame.y + (ySnap?.delta ?? 0) }
      : { ...frame, width: Math.max(40, frame.width + (xSnap?.delta ?? 0)), height: Math.max(40, frame.height + (ySnap?.delta ?? 0)) },
    lines: { x: xSnap ? [xSnap.candidate] : [], y: ySnap ? [ySnap.candidate] : [] }
  };
}

function nearestSnap(anchors: readonly number[], candidates: readonly number[], threshold: number): { delta: number; candidate: number } | undefined {
  let result: { delta: number; candidate: number } | undefined;
  for (const anchor of anchors) for (const candidate of candidates) {
    const delta = candidate - anchor;
    if (Math.abs(delta) <= threshold && (!result || Math.abs(delta) < Math.abs(result.delta))) result = { delta, candidate };
  }
  return result;
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
  autoSaveEnabled?: boolean;
  selection: readonly ApplicationObjectRef[];
  variables: Readonly<Record<string, JsonValue>>;
  onBack: () => void;
  onSelectPage: (pageId: string, view: DashboardViewState) => void;
  onEnterScene: (sceneId: string, view: DashboardViewState) => void;
  onOpenTopology: () => void;
  onOpenData: () => void;
  onOpenScripts?: () => void;
  onSelectionChange: (selection: readonly ApplicationObjectRef[]) => void;
  onObjectInteraction: (sceneId: string, trigger: SceneInteractionTrigger, target: SceneInteractionTarget) => void;
  onNodeInteraction: (nodeId: string, trigger?: SceneInteractionTrigger) => ApplicationInteractionResult | undefined;
  onCommand: (command: StudioCommand) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onAutoSaveChange?: (enabled: boolean) => void;
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
  autoSaveEnabled = false,
  selection,
  variables,
  onBack,
  onSelectPage,
  onEnterScene,
  onOpenTopology,
  onOpenData,
  onOpenScripts,
  onSelectionChange,
  onObjectInteraction,
  onNodeInteraction,
  onCommand,
  onUndo,
  onRedo,
  onSave,
  onAutoSaveChange,
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
  const [guidesVisible, setGuidesVisible] = useState(true);
  const [draftGuides, setDraftGuides] = useState<DashboardGuide[]>();
  const [activeSnapLines, setActiveSnapLines] = useState<ActiveSnapLines>({ x: [], y: [] });
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("content");
  const [componentSearch, setComponentSearch] = useState("");
  const [nodeNameError, setNodeNameError] = useState("");
  const [templateLibraryOpen, setTemplateLibraryOpen] = useState(false);
  const [templateQuery, setTemplateQuery] = useState("");
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const [viewportScroll, setViewportScroll] = useState({ left: 0, top: 0 });
  const [panning, setPanning] = useState(false);
  const [contextMenu, setContextMenu] = useState<DashboardContextMenuState>();
  const [draggedLayerId, setDraggedLayerId] = useState<string>();
  const [layerDropTargetId, setLayerDropTargetId] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const artboardRef = useRef<HTMLDivElement>(null);
  const spacePressedRef = useRef(false);
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
  const stageWidth = Math.max(surfaceSize.width, page.width * zoom + CANVAS_MARGIN * 2);
  const stageHeight = Math.max(surfaceSize.height, page.height * zoom + CANVAS_MARGIN * 2);
  const artboardOffsetX = Math.max(CANVAS_MARGIN, (stageWidth - page.width * zoom) / 2);
  const artboardOffsetY = Math.max(CANVAS_MARGIN, (stageHeight - page.height * zoom) / 2);

  useEffect(() => {
    const surface = scrollRef.current;
    if (!surface) return;
    const update = () => setSurfaceSize({ width: surface.clientWidth, height: surface.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(undefined);
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.code === "Space" && !target?.matches("input,textarea,select,[contenteditable=true]")) {
        spacePressedRef.current = true;
        event.preventDefault();
      }
    };
    const keyUp = (event: KeyboardEvent) => { if (event.code === "Space") spacePressedRef.current = false; };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => { window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp); };
  }, []);

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
      const isDefaultEntry = normalizedInitialView.zoom === 0.5
        && normalizedInitialView.scrollLeft === 0
        && normalizedInitialView.scrollTop === 0
        && normalizedInitialView.selectedNodeIds.length === 0;
      if (isDefaultEntry) fitCanvasToViewport();
      else {
        scrollRef.current.scrollLeft = normalizedInitialView.scrollLeft;
        scrollRef.current.scrollTop = normalizedInitialView.scrollTop;
      }
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

  function handleCanvasScroll() {
    const surface = scrollRef.current;
    if (surface) setViewportScroll({ left: surface.scrollLeft, top: surface.scrollTop });
    emitViewState();
  }

  function fitCanvasToViewport() {
    const surface = scrollRef.current;
    if (!surface) return;
    const nextZoom = calculateDashboardEditorZoom(page, surface.clientWidth, surface.clientHeight);
    setZoom(nextZoom);
    window.requestAnimationFrame(() => {
      const nextStageWidth = Math.max(surface.clientWidth, page.width * nextZoom + CANVAS_MARGIN * 2);
      const nextStageHeight = Math.max(surface.clientHeight, page.height * nextZoom + CANVAS_MARGIN * 2);
      surface.scrollLeft = Math.max(0, (nextStageWidth - surface.clientWidth) / 2);
      surface.scrollTop = Math.max(0, (nextStageHeight - surface.clientHeight) / 2);
      onViewStateChange({ zoom: nextZoom, scrollLeft: surface.scrollLeft, scrollTop: surface.scrollTop, selectedNodeIds });
    });
  }

  function changeZoom(nextZoom: number, clientX?: number, clientY?: number) {
    const surface = scrollRef.current;
    const clamped = Math.max(0.1, Math.min(2, Number(nextZoom.toFixed(3))));
    if (!surface || clamped === zoom) return setZoom(clamped);
    const bounds = surface.getBoundingClientRect();
    const localX = clientX === undefined ? surface.clientWidth / 2 : clientX - bounds.left;
    const localY = clientY === undefined ? surface.clientHeight / 2 : clientY - bounds.top;
    const logicalX = (surface.scrollLeft + localX - artboardOffsetX) / zoom;
    const logicalY = (surface.scrollTop + localY - artboardOffsetY) / zoom;
    const nextStageWidth = Math.max(surface.clientWidth, page.width * clamped + CANVAS_MARGIN * 2);
    const nextStageHeight = Math.max(surface.clientHeight, page.height * clamped + CANVAS_MARGIN * 2);
    const nextOffsetX = Math.max(CANVAS_MARGIN, (nextStageWidth - page.width * clamped) / 2);
    const nextOffsetY = Math.max(CANVAS_MARGIN, (nextStageHeight - page.height * clamped) / 2);
    setZoom(clamped);
    window.requestAnimationFrame(() => {
      surface.scrollLeft = Math.max(0, nextOffsetX + logicalX * clamped - localX);
      surface.scrollTop = Math.max(0, nextOffsetY + logicalY * clamped - localY);
      onViewStateChange({ zoom: clamped, scrollLeft: surface.scrollLeft, scrollTop: surface.scrollTop, selectedNodeIds });
    });
  }

  function zoomCanvas(event: ReactWheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    changeZoom(zoom * (event.deltaY > 0 ? 0.9 : 1.1), event.clientX, event.clientY);
  }

  function beginCanvasPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 1 && !(event.button === 0 && spacePressedRef.current)) return;
    const surface = scrollRef.current;
    if (!surface) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = surface.scrollLeft;
    const startTop = surface.scrollTop;
    const pointerId = event.pointerId;
    setPanning(true);
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      surface.scrollLeft = startLeft - (pointer.clientX - startX);
      surface.scrollTop = startTop - (pointer.clientY - startY);
    };
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      setPanning(false);
      emitViewState();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  function selectNode(node: WidgetNode, additive: boolean, force = false) {
    if (node.locked || (!force && node.selectable === false)) return;
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
    const otherNodes = page.nodes.filter((candidate) => !nodeIds.includes(candidate.id) && candidate.visible !== false);
    const xCandidates = [0, page.width / 2, page.width, ...(guidesVisible ? (page.guides ?? []).filter((guide) => guide.orientation === "vertical").map((guide) => guide.position) : []), ...otherNodes.flatMap((candidate) => [candidate.frame.x, candidate.frame.x + candidate.frame.width / 2, candidate.frame.x + candidate.frame.width])];
    const yCandidates = [0, page.height / 2, page.height, ...(guidesVisible ? (page.guides ?? []).filter((guide) => guide.orientation === "horizontal").map((guide) => guide.position) : []), ...otherNodes.flatMap((candidate) => [candidate.frame.y, candidate.frame.y + candidate.frame.height / 2, candidate.frame.y + candidate.frame.height])];
    const framesAt = (clientX: number, clientY: number): { frames: Record<string, WidgetFrame>; lines: ActiveSnapLines } => {
      let dx = Math.round((clientX - startX) / zoom);
      let dy = Math.round((clientY - startY) / zoom);
      let lines: ActiveSnapLines = { x: [], y: [] };
      if (snapEnabled) {
        const anchor = initial.get(node.id)!;
        if (mode === "move") {
          dx = Math.round((anchor.x + dx) / 8) * 8 - anchor.x;
          dy = Math.round((anchor.y + dy) / 8) * 8 - anchor.y;
        } else {
          dx = Math.round((anchor.width + dx) / 8) * 8 - anchor.width;
          dy = Math.round((anchor.height + dy) / 8) * 8 - anchor.height;
        }
        const proposed = mode === "move"
          ? { ...anchor, x: anchor.x + dx, y: anchor.y + dy }
          : { ...anchor, width: anchor.width + dx, height: anchor.height + dy };
        const snapped = snapDashboardFrame(proposed, mode, xCandidates, yCandidates, SNAP_THRESHOLD_PX / zoom);
        lines = snapped.lines;
        if (mode === "move") { dx += snapped.frame.x - proposed.x; dy += snapped.frame.y - proposed.y; }
        else { dx += snapped.frame.width - proposed.width; dy += snapped.frame.height - proposed.height; }
      }
      const frames = Object.fromEntries([...initial].map(([nodeId, frame]) => {
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
      return { frames, lines };
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      const next = framesAt(pointer.clientX, pointer.clientY);
      setDraftFrames(next.frames);
      setActiveSnapLines(next.lines);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      cleanup();
      const finalFrames = framesAt(pointer.clientX, pointer.clientY).frames;
      setDraftFrames({});
      setActiveSnapLines({ x: [], y: [] });
      const changes = Object.entries(finalFrames)
        .filter(([nodeId, frame]) => JSON.stringify(frame) !== JSON.stringify(initial.get(nodeId)))
        .map(([nodeId, frame]) => ({ nodeId, frame }));
      if (changes.length > 0) onCommand(createUpdateDashboardNodeFramesCommand(page.id, changes));
    };
    const cancel = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      cleanup();
      setDraftFrames({});
      setActiveSnapLines({ x: [], y: [] });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  }

  function addGuide(orientation: DashboardGuide["orientation"], event: ReactPointerEvent<HTMLElement>) {
    const artboard = artboardRef.current;
    if (!artboard || event.button !== 0) return;
    const bounds = artboard.getBoundingClientRect();
    const raw = orientation === "vertical" ? (event.clientX - bounds.left) / zoom : (event.clientY - bounds.top) / zoom;
    const limit = orientation === "vertical" ? page.width : page.height;
    const position = Math.max(0, Math.min(limit, Math.round(raw)));
    onCommand(createUpdateDashboardPageGuidesCommand(page.id, [...(page.guides ?? []), { id: `guide:${crypto.randomUUID()}`, orientation, position }]));
  }

  function beginGuideDrag(event: ReactPointerEvent<HTMLButtonElement>, guide: DashboardGuide) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const currentGuides = structuredClone(page.guides ?? []);
    const positionAt = (pointer: PointerEvent) => {
      const bounds = artboardRef.current?.getBoundingClientRect();
      if (!bounds) return guide.position;
      return Math.round((guide.orientation === "vertical" ? pointer.clientX - bounds.left : pointer.clientY - bounds.top) / zoom);
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      const position = positionAt(pointer);
      setDraftGuides(currentGuides.map((item) => item.id === guide.id ? { ...item, position } : item));
    };
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      cleanup();
      const limit = guide.orientation === "vertical" ? page.width : page.height;
      const position = positionAt(pointer);
      const next = position < 0 || position > limit
        ? currentGuides.filter((item) => item.id !== guide.id)
        : currentGuides.map((item) => item.id === guide.id ? { ...item, position: Math.max(0, Math.min(limit, position)) } : item);
      setDraftGuides(undefined);
      onCommand(createUpdateDashboardPageGuidesCommand(page.id, next));
    };
    const cancel = () => { cleanup(); setDraftGuides(undefined); };
    const cleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", cancel); };
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
    const usedNames = new Set(page.nodes.map((node) => nodeIdentity(node).toLocaleLowerCase()));
    const nodes = clipboardRef.current.map((source, index): WidgetNode => {
      const name = uniqueNodeName(`${nodeIdentity(source)} ${tr(locale, "副本", "copy")}`, usedNames);
      usedNames.add(name.toLocaleLowerCase());
      return {
        ...structuredClone(source),
        id: `${source.kind}:${crypto.randomUUID()}`,
        name,
        frame: {
          ...source.frame,
          x: Math.min(page.width - source.frame.width, Math.max(0, source.frame.x + 24)),
          y: Math.min(page.height - source.frame.height, Math.max(0, source.frame.y + 24))
        },
        zIndex: topZIndex + index + 1,
        visible: true,
        locked: false,
        ...(source.groupId ? { groupId: groupIds.get(source.groupId)! } : {})
      };
    });
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

  function deleteLayerNode(node: WidgetNode) {
    if (busy || node.locked) return;
    if (!window.confirm(tr(locale, `确定删除组件“${nodeLabel(node)}”吗？删除后仍可通过撤销恢复。`, `Delete “${nodeLabel(node)}”? You can still restore it with Undo.`))) return;
    onCommand(createDeleteDashboardNodesCommand(page.id, [node.id]));
    const remaining = selectedNodeIds.filter((id) => id !== node.id);
    setSelectedNodeIds(remaining);
    onSelectionChange(remaining.map((id) => ({ kind: "widget", id })));
  }

  function toggleLayerLock(node: WidgetNode) {
    const locked = !node.locked;
    onCommand(createUpdateDashboardNodeStateCommand(page.id, node.id, { locked, selectable: !locked }));
    if (!locked || !selectedNodeIds.includes(node.id)) return;
    const remaining = selectedNodeIds.filter((id) => id !== node.id);
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
    reorderNodeIds(selectedNodeIds, direction);
  }

  function reorderNodeIds(nodeIds: readonly string[], direction: "front" | "forward" | "backward" | "back") {
    const selected = new Set(page.nodes.filter((node) => nodeIds.includes(node.id) && node.locked !== true).map((node) => node.id));
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

  function reorderLayerByDrop(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const displayed = [...page.nodes].sort((left, right) => right.zIndex - left.zIndex);
    const source = displayed.find((node) => node.id === sourceId);
    const targetIndex = displayed.findIndex((node) => node.id === targetId);
    if (!source || source.locked || targetIndex < 0) return;
    const withoutSource = displayed.filter((node) => node.id !== sourceId);
    const insertionIndex = withoutSource.findIndex((node) => node.id === targetId);
    withoutSource.splice(Math.max(0, insertionIndex), 0, source);
    const order = [...withoutSource].reverse().map((node, zIndex) => ({ nodeId: node.id, zIndex }));
    onCommand(createUpdateDashboardNodeOrderCommand(page.id, order));
  }

  function contextNodeIds(): string[] {
    if (!contextMenu) return [];
    return selectedNodeIds.includes(contextMenu.nodeId) ? selectedNodeIds : [contextMenu.nodeId];
  }

  function openNodeContextMenu(event: ReactMouseEvent, node: WidgetNode) {
    if (node.locked) return;
    event.preventDefault();
    event.stopPropagation();
    if (!selectedNodeIds.includes(node.id)) {
      setSelectedNodeIds([node.id]);
      onSelectionChange([{ kind: "widget", id: node.id }]);
    }
    const menuWidth = 190;
    const menuHeight = 310;
    setContextMenu({ x: Math.min(event.clientX, window.innerWidth - menuWidth - 8), y: Math.min(event.clientY, window.innerHeight - menuHeight - 8), nodeId: node.id });
  }

  function copyContextNodes(duplicate = false) {
    const ids = contextNodeIds();
    clipboardRef.current = page.nodes.filter((node) => ids.includes(node.id)).map((node) => structuredClone(node));
    if (duplicate) pasteCopiedNodes();
    setContextMenu(undefined);
  }

  function updateContextNodes(state: Parameters<typeof createUpdateDashboardNodeStatesCommand>[1][number]["state"], label: string) {
    const ids = contextNodeIds();
    if (!ids.length) return;
    onCommand(createUpdateDashboardNodeStatesCommand(page.id, ids.map((nodeId) => ({ nodeId, state })), label));
    if (state.locked === true) {
      setSelectedNodeIds([]);
      onSelectionChange([]);
    }
    setContextMenu(undefined);
  }

  function deleteContextNodes() {
    const ids = contextNodeIds();
    const nodes = page.nodes.filter((node) => ids.includes(node.id) && !node.locked);
    if (!nodes.length || !window.confirm(tr(locale, `确定删除 ${nodes.length} 个组件吗？删除后仍可通过撤销恢复。`, `Delete ${nodes.length} component(s)? You can still restore them with Undo.`))) return;
    onCommand(createDeleteDashboardNodesCommand(page.id, nodes.map((node) => node.id)));
    setSelectedNodeIds([]);
    onSelectionChange([]);
    setContextMenu(undefined);
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
    const wide = ["line", "area", "bar", "pie", "scatter", "radar", "funnel", "rank", "table", "filter", "image", "video", "monitor", "url", "topology", "decoration"].includes(type);
    const node: WidgetNode = {
      id,
      name: uniqueNodeName(dataWidgetTypeLabel(locale, type), new Set(page.nodes.map((item) => nodeIdentity(item).toLocaleLowerCase()))),
      kind: "data-widget",
      frame: { x: 48 + index % 4 * 28, y: 48 + index % 4 * 28, width: wide ? 420 : 260, height: type === "decoration" ? 72 : wide || type === "gauge" ? 240 : 140 },
      zIndex: Math.max(0, ...page.nodes.map((item) => item.zIndex)) + 1,
      widget: { ...defaultDataWidget(locale, type), ...(type === "topology" && application.topologies[0] ? { topologyId: application.topologies[0].id } : {}) }
    };
    onCommand(createInsertDashboardNodeCommand(page.id, node));
    setSelectedNodeIds([id]);
    onSelectionChange([{ kind: "widget", id }]);
  }

  function addSceneViewport() {
    const scene = application.scenes[0];
    if (!scene) return;
    const id = `scene-viewport:${crypto.randomUUID()}`;
    const name = uniqueNodeName(scene.name || tr(locale, "三维场景", "3D scene"), new Set(page.nodes.map((item) => nodeIdentity(item).toLocaleLowerCase())));
    onCommand(createInsertDashboardNodeCommand(page.id, {
      id,
      name,
      kind: "scene-viewport",
      frame: { x: 48, y: 48, width: Math.min(960, Math.max(420, page.width - 96)), height: Math.min(600, Math.max(260, page.height - 96)) },
      zIndex: Math.max(0, ...page.nodes.map((item) => item.zIndex)) + 1,
      sceneId: scene.id,
      renderMode: "realtime",
      interactionPolicy: "full-navigation",
      overlaySlot: "page"
    }));
    setSelectedNodeIds([id]);
    onSelectionChange([{ kind: "widget", id }]);
  }

  function insertDashboardTemplate(kind: "operations" | "production" | "energy") {
    if (busy) return;
    const nodes = createDashboardTemplateNodes(locale, page, kind, Math.max(0, ...page.nodes.map((node) => node.zIndex)) + 1);
    onCommand(createInsertDashboardNodesCommand(page.id, nodes));
    setSelectedNodeIds(nodes.map((node) => node.id));
    onSelectionChange(nodes.map((node) => ({ kind: "widget", id: node.id })));
  }

  function updateSceneViewport(patch: Partial<Pick<Extract<WidgetNode, { kind: "scene-viewport" }>, "sceneId" | "cameraViewId" | "renderMode" | "interactionPolicy">>) {
    if (!selectedNode || selectedNode.kind !== "scene-viewport") return;
    const next = { sceneId: selectedNode.sceneId, renderMode: selectedNode.renderMode, interactionPolicy: selectedNode.interactionPolicy, ...(selectedNode.cameraViewId ? { cameraViewId: selectedNode.cameraViewId } : {}), ...patch };
    if (!next.cameraViewId) delete next.cameraViewId;
    onCommand(createUpdateDashboardSceneViewportCommand(page.id, selectedNode.id, next));
  }

  function commitNodeName(value: string) {
    if (!selectedNode) return;
    const name = value.trim();
    if (!name) {
      setNodeNameError(tr(locale, "组件名称不能为空", "Component name is required"));
      return;
    }
    const duplicated = page.nodes.some((node) => node.id !== selectedNode.id && nodeIdentity(node).toLocaleLowerCase() === name.toLocaleLowerCase());
    if (duplicated) {
      setNodeNameError(tr(locale, "当前页面已有同名组件", "This page already contains that component name"));
      return;
    }
    setNodeNameError("");
    if (selectedNode.name !== name) onCommand(createUpdateDashboardNodeStateCommand(page.id, selectedNode.id, { name }));
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

  if (runtimePreview) return <DashboardRuntimePreview locale={locale} application={application} project={project} page={page} rendererBackend={rendererBackend} metrics={runtimeMetrics} connected={connected} onSelectPage={(pageId) => onSelectPage(pageId, currentView())} onClose={() => setRuntimePreview(false)} onPublish={onPublish} onSelectionChange={onSelectionChange} onObjectInteraction={onObjectInteraction} onNodeInteraction={onNodeInteraction} />;

  return <main className="dashboard-workspace">
    <header className="dashboard-workspace-topbar">
      <button className="dashboard-back" onClick={onBack}><ArrowLeft size={16} />{tr(locale, "项目", "Project")}</button>
      <div className="dashboard-workspace-title"><LayoutDashboard size={17} /><div><strong>{application.metadata.name}</strong><span>{dirty ? tr(locale, "有未保存修改", "Unsaved changes") : tr(locale, "所有修改已保存", "All changes saved")}</span></div></div>
      <nav className="workspace-mode-switch" aria-label={tr(locale, "编辑模式", "Editor mode")}>
        <span className="workspace-context"><LayoutDashboard size={14} />{tr(locale, "二维页面", "2D page")} · {page.name}</span>
        <button onClick={onOpenData}><Database size={14} />{tr(locale, "数据", "Data")}</button>
        <button onClick={() => onOpenScripts?.()}><Braces size={14} />{tr(locale, "脚本", "Scripts")}</button>
      </nav>
      <div className="dashboard-workspace-actions">
        {onAutoSaveChange && <label className="dashboard-auto-save" title={tr(locale, "修改后自动保存项目", "Automatically save project changes")}><input type="checkbox" checked={autoSaveEnabled} onChange={(event) => onAutoSaveChange(event.target.checked)} />{tr(locale, "自动保存", "Auto save")}</label>}
        <button disabled={!canUndo || busy} title={tr(locale, "撤销", "Undo")} onClick={onUndo}><Undo2 size={15} /></button>
        <button disabled={!canRedo || busy} title={tr(locale, "重做", "Redo")} onClick={onRedo}><Redo2 size={15} /></button>
        <button disabled={!dirty || busy} onClick={onSave}><Save size={15} />{tr(locale, "保存", "Save")}</button>
        <button onClick={() => setRuntimePreview(true)}><Eye size={15} />{tr(locale, "浏览", "Browse")}</button>
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
        <button className="dashboard-template-library-trigger" onClick={() => setTemplateLibraryOpen(true)}><LayoutDashboard size={14} /><span><strong>{tr(locale, "模板库", "Template library")}</strong><small>{tr(locale, "行业模板与可编辑布局", "Industry templates and editable layouts")}</small></span><em>{DASHBOARD_TEMPLATES.length}</em></button>
        <div className="dashboard-panel-label"><span>{tr(locale, "组件", "Components")}</span><small>{connected ? tr(locale, "实时", "Live") : tr(locale, "离线", "Offline")}</small></div>
        <input ref={componentSearchRef} className="dashboard-component-search" aria-label={tr(locale, "搜索组件", "Search components")} value={componentSearch} onChange={(event) => setComponentSearch(event.target.value)} placeholder={tr(locale, "搜索组件 · Ctrl+F", "Search · Ctrl+F")} />
        <div className="dashboard-component-groups">
          {tr(locale, "三维场景", "3D scene").toLocaleLowerCase().includes(componentSearch.trim().toLocaleLowerCase()) && <button disabled={application.scenes.length === 0} title={application.scenes.length === 0 ? tr(locale, "请先创建三维场景", "Create a 3D scene first") : undefined} onClick={addSceneViewport}><Plus size={11} /><span>{tr(locale, "三维场景", "3D scene")}</span></button>}
          {DATA_WIDGET_CATEGORIES.map((category) => {
            const types = category.types.filter((type) => dataWidgetTypeLabel(locale, type).toLocaleLowerCase().includes(componentSearch.trim().toLocaleLowerCase()));
            return types.length > 0 ? <details key={category.id}><summary>{tr(locale, category.zh, category.en)}<small>{types.length}</small></summary><div>{types.map((type) => <button key={type} onClick={() => addDataWidget(type)}><Plus size={11} /><span>{dataWidgetTypeLabel(locale, type)}</span></button>)}</div></details> : null;
          })}
        </div>
      </section>
      <section>
        <div className="dashboard-panel-label"><span>{tr(locale, "图层", "Layers")}</span><small>{page.nodes.length}</small></div>
        {[...page.nodes].sort((left, right) => right.zIndex - left.zIndex).map((node) => <div draggable={!node.locked} className={`dashboard-layer-row ${selectedNodeIds.includes(node.id) ? "active" : ""} ${node.visible === false ? "hidden" : ""} ${node.locked ? "locked" : ""} ${draggedLayerId === node.id ? "dragging" : ""} ${layerDropTargetId === node.id ? "drop-target" : ""}`} key={node.id} onDragStart={(event) => { setDraggedLayerId(node.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", node.id); }} onDragOver={(event) => { if (!draggedLayerId || draggedLayerId === node.id) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setLayerDropTargetId(node.id); }} onDrop={(event) => { event.preventDefault(); const sourceId = draggedLayerId ?? event.dataTransfer.getData("text/plain"); if (sourceId) reorderLayerByDrop(sourceId, node.id); setDraggedLayerId(undefined); setLayerDropTargetId(undefined); }} onDragEnd={() => { setDraggedLayerId(undefined); setLayerDropTargetId(undefined); }}>
          <button className="dashboard-layer-select" disabled={node.locked} title={node.locked ? tr(locale, "图层已锁定，解锁后可选取", "Layer is locked; unlock it to select") : nodeLabel(node)} onClick={(event) => selectNode(node, event.ctrlKey || event.metaKey, true)}>{node.kind === "scene-viewport" ? <Box size={14} /> : <Layers3 size={14} />}<span>{nodeLabel(node)}</span></button>
          <button className="dashboard-layer-action" title={node.visible === false ? tr(locale, "显示图层", "Show layer") : tr(locale, "隐藏图层", "Hide layer")} onClick={() => onCommand(createUpdateDashboardNodeStateCommand(page.id, node.id, { visible: node.visible === false }))}>{node.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}</button>
          <button className={`dashboard-layer-action ${node.locked ? "active" : ""}`} title={node.locked ? tr(locale, "解锁图层", "Unlock layer") : tr(locale, "锁定图层（同时禁止选取）", "Lock layer and prevent selection")} onClick={() => toggleLayerLock(node)}>{node.locked ? <Lock size={13} /> : <Unlock size={13} />}</button>
          <button className="dashboard-layer-action danger" disabled={node.locked} title={node.locked ? tr(locale, "请先解锁再删除", "Unlock before deleting") : tr(locale, "删除组件", "Delete component")} onClick={() => deleteLayerNode(node)}><Trash2 size={13} /></button>
        </div>)}
      </section>
    </aside>

    <section className="dashboard-design-surface">
      <div className="dashboard-canvas-toolbar">
        <span>{page.width} × {page.height}<small>{tr(locale, "空格/中键平移 · Ctrl/Cmd+滚轮缩放 · Shift 框选 · 方向键微调", "Space/middle-button pan · Ctrl/Cmd+wheel zoom · Shift box-select · Arrows nudge")}</small>{overflowNodeIds.length > 0 && <button className="dashboard-overflow-warning" title={tr(locale, "选择所有超出页面边界的组件", "Select all components outside the page bounds")} onClick={selectOverflowNodes}>{tr(locale, `${overflowNodeIds.length} 个组件越界`, `${overflowNodeIds.length} out of bounds`)}</button>}</span>
        <div className="dashboard-layout-tools" aria-label={tr(locale, "排版工具", "Layout tools")}>
          <div className="dashboard-tool-group"><button className={marqueeMode ? "active" : ""} title={tr(locale, "框选组件（Shift+拖动）", "Box select (Shift-drag)")} onClick={() => setMarqueeMode((active) => !active)}><ScanSearch size={13} /></button><button className={snapEnabled ? "active" : ""} title={tr(locale, "智能吸附：网格、参考线和组件边缘", "Smart snap: grid, guides and component edges")} onClick={() => setSnapEnabled((enabled) => !enabled)}>{tr(locale, "吸附", "Snap")}</button><button className={guidesVisible ? "active" : ""} title={tr(locale, "显示或隐藏参考线", "Show or hide guides")} onClick={() => setGuidesVisible((visible) => !visible)}>{tr(locale, "参考线", "Guides")}</button></div>
          <div className="dashboard-tool-group"><button disabled={selectedNodeIds.filter((id) => page.nodes.some((node) => node.id === id && node.locked !== true)).length < 2} title={tr(locale, "编组", "Group")} onClick={groupSelectedNodes}><Group size={13} /></button><button disabled={!page.nodes.some((node) => selectedNodeIds.includes(node.id) && node.groupId && node.locked !== true)} title={tr(locale, "解组", "Ungroup")} onClick={ungroupSelectedNodes}><Ungroup size={13} /></button></div>
          <div className="dashboard-tool-group"><button disabled={layoutSelectionCount < 2} title={tr(locale, "左对齐", "Align left")} onClick={() => layoutSelectedNodes("left")}><AlignStartVertical size={13} /></button><button disabled={layoutSelectionCount < 2} title={tr(locale, "水平居中", "Center horizontally")} onClick={() => layoutSelectedNodes("horizontal-center")}><AlignCenterVertical size={13} /></button><button disabled={layoutSelectionCount < 2} title={tr(locale, "右对齐", "Align right")} onClick={() => layoutSelectedNodes("right")}><AlignEndVertical size={13} /></button><button disabled={layoutSelectionCount < 2} title={tr(locale, "顶对齐", "Align top")} onClick={() => layoutSelectedNodes("top")}><AlignStartHorizontal size={13} /></button><button disabled={layoutSelectionCount < 2} title={tr(locale, "垂直居中", "Center vertically")} onClick={() => layoutSelectedNodes("vertical-center")}><AlignCenterHorizontal size={13} /></button><button disabled={layoutSelectionCount < 2} title={tr(locale, "底对齐", "Align bottom")} onClick={() => layoutSelectedNodes("bottom")}><AlignEndHorizontal size={13} /></button></div>
          <div className="dashboard-tool-group"><button className="wide" disabled={layoutSelectionCount < 3} title={tr(locale, "水平等距分布", "Distribute horizontally")} onClick={() => layoutSelectedNodes("horizontal")}>{tr(locale, "横向等距", "H distribute")}</button><button className="wide" disabled={layoutSelectionCount < 3} title={tr(locale, "垂直等距分布", "Distribute vertically")} onClick={() => layoutSelectedNodes("vertical")}>{tr(locale, "纵向等距", "V distribute")}</button></div>
        </div>
        <div><button title={tr(locale, "完整显示看板", "Fit dashboard")} onClick={fitCanvasToViewport}><Scaling size={13} /></button><button title={tr(locale, "缩小（以视口中心缩放）", "Zoom out around viewport center")} onClick={() => changeZoom(zoom - 0.1)}><Minus size={13} /></button><output>{Math.round(zoom * 100)}%</output><button title={tr(locale, "放大（以视口中心缩放）", "Zoom in around viewport center")} onClick={() => changeZoom(zoom + 0.1)}><Plus size={13} /></button></div>
      </div>
      <div className={`dashboard-canvas-scroll ${panning ? "panning" : ""}`} ref={scrollRef} onScroll={handleCanvasScroll} onWheel={zoomCanvas} onPointerDownCapture={beginCanvasPan} onClick={(event) => { if (event.target === event.currentTarget) { setSelectedNodeIds([]); onSelectionChange([]); } }}>
        <div className="dashboard-artboard-stage" style={{ width: stageWidth, height: stageHeight }}>
          <button className="dashboard-ruler-corner" title={tr(locale, "清空参考线", "Clear guides")} disabled={(page.guides?.length ?? 0) === 0} onClick={() => onCommand(createUpdateDashboardPageGuidesCommand(page.id, []))} />
          <DashboardRuler orientation="horizontal" length={page.width} viewportLength={surfaceSize.width} zoom={zoom} offset={artboardOffsetX - viewportScroll.left} onPointerDown={(event) => addGuide("vertical", event)} />
          <DashboardRuler orientation="vertical" length={page.height} viewportLength={surfaceSize.height} zoom={zoom} offset={artboardOffsetY - viewportScroll.top} onPointerDown={(event) => addGuide("horizontal", event)} />
          <div ref={artboardRef} className={`dashboard-artboard ${marqueeMode ? "marquee-mode" : ""}`} style={{ width: page.width, height: page.height, left: artboardOffsetX, top: artboardOffsetY, transform: `scale(${zoom})` }} onPointerDownCapture={beginMarqueeSelection}>
            {page.nodes.filter((node) => node.visible !== false).map((node) => <DashboardNode key={node.id} application={application} project={project} node={node} frame={draftFrames[node.id] ?? node.frame} metric={node.kind === "data-widget" ? runtimeMetrics[node.widget.key] : undefined} selected={selectedNodeIds.includes(node.id)} locale={locale} rendererBackend={rendererBackend} onSelectionChange={onSelectionChange} onObjectInteraction={onObjectInteraction} onInteraction={(trigger) => onNodeInteraction(node.id, trigger)} onSelect={(additive) => selectNode(node, additive)} onContextMenu={(event) => openNodeContextMenu(event, node)} onEnterScene={(sceneId) => onEnterScene(sceneId, currentView())} onTransformStart={(event, mode) => beginNodeTransform(event, node, mode)} />)}
            {guidesVisible && (draftGuides ?? page.guides ?? []).map((guide) => <button key={guide.id} className={`dashboard-guide ${guide.orientation}`} style={guide.orientation === "vertical" ? { left: guide.position } : { top: guide.position }} title={tr(locale, "拖动调整，拖出画布删除", "Drag to move; drag outside to delete")} onPointerDown={(event) => beginGuideDrag(event, guide)} />)}
            {activeSnapLines.x.map((position) => <div key={`x:${position}`} className="dashboard-smart-guide vertical" style={{ left: position }} />)}
            {activeSnapLines.y.map((position) => <div key={`y:${position}`} className="dashboard-smart-guide horizontal" style={{ top: position }} />)}
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
            <label><span>{tr(locale, "组件名称（页面内唯一）", "Component name (unique on page)")}</span><input key={`${selectedNode.id}:name:${selectedNode.name ?? ""}`} defaultValue={nodeIdentity(selectedNode)} onFocus={() => setNodeNameError("")} onBlur={(event) => commitNodeName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />{nodeNameError && <small className="dashboard-field-error">{nodeNameError}</small>}</label>
            <div className="dashboard-frame-grid">{(["x", "y", "width", "height"] as const).map((field) => <label key={field}><span>{field.toUpperCase()}</span><input type="number" disabled={selectedNode.locked === true} value={selectedNode.frame[field]} onChange={(event) => updateSelectedFrame(field, Number(event.target.value))} /></label>)}</div>
            <div className="dashboard-layer-order-actions"><button disabled={selectedNode.locked === true} onClick={() => reorderSelectedNodes("back")}>{tr(locale, "置底", "To back")}</button><button disabled={selectedNode.locked === true} onClick={() => reorderSelectedNodes("backward")}>{tr(locale, "下移", "Backward")}</button><button disabled={selectedNode.locked === true} onClick={() => reorderSelectedNodes("forward")}>{tr(locale, "上移", "Forward")}</button><button disabled={selectedNode.locked === true} onClick={() => reorderSelectedNodes("front")}>{tr(locale, "置顶", "To front")}</button></div>
          </section>
          {selectedNode.kind === "scene-viewport" && <section className="dashboard-inspector-section dashboard-data-widget-properties">
            <label><span>{tr(locale, "三维场景", "3D scene")}</span><select value={selectedNode.sceneId} onChange={(event) => updateSceneViewport({ sceneId: event.target.value })}>{application.scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.name}</option>)}</select></label>
            <label><span>{tr(locale, "渲染方式", "Render mode")}</span><select value={selectedNode.renderMode} onChange={(event) => updateSceneViewport({ renderMode: event.target.value as typeof selectedNode.renderMode })}><option value="realtime">{tr(locale, "实时渲染", "Realtime")}</option><option value="load-on-interaction">{tr(locale, "交互时加载", "Load on interaction")}</option><option value="static-placeholder">{tr(locale, "静态占位", "Static placeholder")}</option></select></label>
            <label><span>{tr(locale, "交互权限", "Interaction")}</span><select value={selectedNode.interactionPolicy} onChange={(event) => updateSceneViewport({ interactionPolicy: event.target.value as typeof selectedNode.interactionPolicy })}><option value="full-navigation">{tr(locale, "完整漫游", "Full navigation")}</option><option value="click-select">{tr(locale, "仅点击选取", "Click select")}</option><option value="display-only">{tr(locale, "仅展示", "Display only")}</option></select></label>
            <button className="dashboard-enter-scene" onClick={() => onEnterScene(selectedNode.sceneId, currentView())}><Box size={15} />{tr(locale, "进入三维编辑", "Open 3D editor")}</button>
          </section>}
          {selectedNode.kind === "data-widget" && <section className="dashboard-inspector-section dashboard-data-widget-properties">
            <label><span>{tr(locale, "类型", "Type")}</span><select value={selectedNode.widget.type} onChange={(event) => updateDataWidget({ type: event.target.value as SceneDashboardWidgetType })}>{DATA_WIDGET_TYPES.map((type) => <option key={type} value={type}>{dataWidgetTypeLabel(locale, type)}</option>)}</select></label>
            <label><span>{tr(locale, "标题", "Title")}</span><input defaultValue={selectedNode.widget.title} key={`${selectedNode.id}:title:${selectedNode.widget.title}`} onBlur={(event) => { if (event.currentTarget.value !== selectedNode.widget.title) updateDataWidget({ title: event.currentTarget.value }); }} /></label>
            {(selectedNode.widget.type === "text" || selectedNode.widget.type === "shape" || selectedNode.widget.type === "decoration") && <label><span>{tr(locale, "内容", "Content")}</span><input defaultValue={selectedNode.widget.content ?? ""} onBlur={(event) => updateDataWidget({ content: event.currentTarget.value })} /></label>}
            {selectedNode.widget.type === "shape" && <label><span>{tr(locale, "形状", "Shape")}</span><select value={selectedNode.widget.shape ?? "rounded"} onChange={(event) => updateDataWidget({ shape: event.target.value as NonNullable<DashboardDataWidgetConfig["shape"]> })}><option value="rectangle">{tr(locale, "矩形", "Rectangle")}</option><option value="rounded">{tr(locale, "圆角矩形", "Rounded")}</option><option value="ellipse">{tr(locale, "椭圆", "Ellipse")}</option><option value="line">{tr(locale, "线", "Line")}</option></select></label>}
            {selectedNode.widget.type === "decoration" && <label><span>{tr(locale, "装饰样式", "Decoration style")}</span><select value={selectedNode.widget.decorationStyle ?? "title"} onChange={(event) => updateDataWidget({ decorationStyle: event.target.value as NonNullable<DashboardDataWidgetConfig["decorationStyle"]> })}><option value="title">{tr(locale, "标题栏", "Title bar")}</option><option value="border">{tr(locale, "科技边框", "Tech border")}</option><option value="divider">{tr(locale, "分割线", "Divider")}</option><option value="corner">{tr(locale, "角标", "Corner")}</option></select></label>}
            {selectedNode.widget.type === "filter" && <label><span>{tr(locale, "选项（逗号分隔）", "Options (comma separated)")}</span><input defaultValue={(selectedNode.widget.options ?? []).join(", ")} onBlur={(event) => updateDataWidget({ options: event.currentTarget.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean) })} /></label>}
            {(selectedNode.widget.type === "image" || selectedNode.widget.type === "video" || selectedNode.widget.type === "monitor") && <DashboardMediaInspector locale={locale} projectId={project.id} widget={selectedNode.widget} onChange={updateDataWidget} />}
            {selectedNode.widget.type === "url" && <label><span>{tr(locale, "网页地址", "Web page URL")}</span><input defaultValue={selectedNode.widget.url ?? ""} onBlur={(event) => updateDataWidget({ url: event.currentTarget.value })} /></label>}
            {selectedNode.widget.type === "topology" && <><label><span>{tr(locale, "拓扑文档", "Topology document")}</span><select value={selectedNode.widget.topologyId ?? ""} onChange={(event) => updateDataWidget({ topologyId: event.target.value })}><option value="">{tr(locale, "选择拓扑", "Choose topology")}</option>{application.topologies.map((topology) => <option key={topology.id} value={topology.id}>{topology.name}</option>)}</select></label><button className="dashboard-enter-scene" disabled={!selectedNode.widget.topologyId} onClick={onOpenTopology}><Workflow size={15} />{tr(locale, "编辑当前拓扑", "Edit topology")}</button></>}
          </section>}
        </>}

        {inspectorTab === "data" && selectedNode.kind === "data-widget" && !["text", "shape", "decoration", "topology"].includes(selectedNode.widget.type) && <section className="dashboard-inspector-section dashboard-data-widget-properties">
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

        {inspectorTab === "data" && selectedNode.kind === "data-widget" && ["text", "shape", "decoration"].includes(selectedNode.widget.type) && <div className="dashboard-inspector-empty">{tr(locale, "静态组件不需要数据绑定。", "Static components do not require data binding.")}</div>}

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
    {templateLibraryOpen && <div className="dashboard-template-library-backdrop" onMouseDown={() => setTemplateLibraryOpen(false)}>
      <section className="dashboard-template-library-panel" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><span className="eyebrow">TEMPLATE LIBRARY</span><strong>{tr(locale, "看板模板库", "Dashboard template library")}</strong><small>{tr(locale, "模板插入当前页面后可完全编辑，不覆盖已有组件。", "Templates remain fully editable and never replace existing components.")}</small></div><button title={tr(locale, "关闭", "Close")} onClick={() => setTemplateLibraryOpen(false)}><X size={15} /></button></header>
        <label className="dashboard-template-search"><Search size={14} /><input autoFocus value={templateQuery} onChange={(event) => setTemplateQuery(event.target.value)} placeholder={tr(locale, "搜索模板或行业", "Search templates or industries")} /></label>
        <div className="dashboard-template-grid">{DASHBOARD_TEMPLATES.filter((template) => {
          const query = templateQuery.trim().toLocaleLowerCase();
          return !query || `${template.zh} ${template.en} ${template.categoryZh} ${template.categoryEn}`.toLocaleLowerCase().includes(query);
        }).map((template) => <article key={template.id}>
          <div className={`dashboard-template-preview template-${template.id}`}><span /><i /><i /><b /><b /><b /></div>
          <div><small>{tr(locale, template.categoryZh, template.categoryEn)}</small><strong>{tr(locale, template.zh, template.en)}</strong><p>{tr(locale, template.descriptionZh, template.descriptionEn)}</p></div>
          <button onClick={() => { insertDashboardTemplate(template.id); setTemplateLibraryOpen(false); }}>{tr(locale, "插入当前页面", "Insert into page")}</button>
        </article>)}</div>
      </section>
    </div>}
    {contextMenu && (() => {
      const target = page.nodes.find((node) => node.id === contextMenu.nodeId);
      if (!target) return null;
      const ids = contextNodeIds();
      const targets = page.nodes.filter((node) => ids.includes(node.id));
      const allHidden = targets.every((node) => node.visible === false);
      const grouped = targets.some((node) => node.groupId);
      return <div className="dashboard-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
        <header><span>{nodeLabel(target)}</span><small>{targets.length > 1 ? tr(locale, `${targets.length} 个组件`, `${targets.length} components`) : target.kind === "scene-viewport" ? "3D" : dataWidgetTypeLabel(locale, target.widget.type)}</small></header>
        <button onClick={() => copyContextNodes()}><Copy size={13} />{tr(locale, "复制", "Copy")}<kbd>Ctrl C</kbd></button>
        <button onClick={() => copyContextNodes(true)}><Plus size={13} />{tr(locale, "创建副本", "Duplicate")}<kbd>Ctrl D</kbd></button>
        <div />
        <button onClick={() => { reorderNodeIds(ids, "front"); setContextMenu(undefined); }}><Layers3 size={13} />{tr(locale, "置于顶层", "Bring to front")}<kbd>⇧ ]</kbd></button>
        <button onClick={() => { reorderNodeIds(ids, "forward"); setContextMenu(undefined); }}><Layers3 size={13} />{tr(locale, "上移一层", "Move forward")}<kbd>]</kbd></button>
        <button onClick={() => { reorderNodeIds(ids, "backward"); setContextMenu(undefined); }}><Layers3 size={13} />{tr(locale, "下移一层", "Move backward")}<kbd>[</kbd></button>
        <button onClick={() => { reorderNodeIds(ids, "back"); setContextMenu(undefined); }}><Layers3 size={13} />{tr(locale, "置于底层", "Send to back")}<kbd>⇧ [</kbd></button>
        <div />
        <button onClick={() => updateContextNodes({ visible: allHidden }, allHidden ? "显示二维组件" : "隐藏二维组件")}>{allHidden ? <Eye size={13} /> : <EyeOff size={13} />}{allHidden ? tr(locale, "显示", "Show") : tr(locale, "隐藏", "Hide")}</button>
        <button onClick={() => updateContextNodes({ locked: true, selectable: false }, "锁定二维组件")}><Lock size={13} />{tr(locale, "锁定并取消选取", "Lock and deselect")}</button>
        {targets.length > 1 && <button onClick={() => { grouped ? ungroupSelectedNodes() : groupSelectedNodes(); setContextMenu(undefined); }}>{grouped ? <Ungroup size={13} /> : <Group size={13} />}{grouped ? tr(locale, "解组", "Ungroup") : tr(locale, "编组", "Group")}</button>}
        {target.kind === "scene-viewport" && <button onClick={() => { setContextMenu(undefined); onEnterScene(target.sceneId, currentView()); }}><Box size={13} />{tr(locale, "进入三维编辑", "Open 3D editor")}</button>}
        <div />
        <button className="danger" onClick={deleteContextNodes}><Trash2 size={13} />{tr(locale, "删除", "Delete")}<kbd>Del</kbd></button>
      </div>;
    })()}
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

function DashboardRuntimePreview({ locale, application, project, page, rendererBackend, metrics, connected, onSelectPage, onClose, onPublish, onSelectionChange, onObjectInteraction, onNodeInteraction }: {
  locale: AppLocale;
  application: ApplicationDocument;
  project: ProjectRecord;
  page: DashboardPageDocument;
  rendererBackend: RendererBackend;
  metrics: Record<string, DashboardMetric>;
  connected: boolean;
  onSelectPage: (pageId: string) => void;
  onClose: () => void;
  onPublish: () => void;
  onSelectionChange: (selection: readonly ApplicationObjectRef[]) => void;
  onObjectInteraction: (sceneId: string, trigger: SceneInteractionTrigger, target: SceneInteractionTarget) => void;
  onNodeInteraction: (nodeId: string, trigger?: SceneInteractionTrigger) => ApplicationInteractionResult | undefined;
}) {
  const [controlsOpen, setControlsOpen] = useState(false);
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
  return <main className="dashboard-runtime-preview">
    <section ref={surfaceRef} className={`dashboard-runtime-surface fit-${page.viewportFit}`}><div className="dashboard-runtime-stage" style={{ width: viewport.stageWidth, height: viewport.stageHeight }}><div className="dashboard-artboard dashboard-runtime-artboard" style={{ width: page.width, height: page.height, left: viewport.offsetX, top: viewport.offsetY, transform: `scale(${viewport.scaleX}, ${viewport.scaleY})` }}>{page.nodes.filter((node) => node.visible !== false).map((node) => <DashboardNode key={node.id} runtime application={application} project={project} node={node} frame={node.frame} metric={node.kind === "data-widget" ? metrics[node.widget.key] : undefined} selected={false} locale={locale} rendererBackend={rendererBackend} onSelectionChange={onSelectionChange} onObjectInteraction={onObjectInteraction} onInteraction={(trigger) => onNodeInteraction(node.id, trigger)} onSelect={() => undefined} onEnterScene={() => undefined} onTransformStart={() => undefined} />)}</div></div></section>
    <div className={`dashboard-runtime-controller ${controlsOpen ? "open" : ""}`}>
      <button className="dashboard-runtime-controller-trigger" title={tr(locale, "项目控制", "Project controls")} onClick={() => setControlsOpen((open) => !open)}><ExternalLink size={15} /><span>{application.metadata.name}</span></button>
      {controlsOpen && <div className="dashboard-runtime-controller-panel">
        <header><strong>{application.metadata.name}</strong><small>{page.name} · {connected ? tr(locale, "实时数据", "Live data") : tr(locale, "离线数据", "Offline data")}</small></header>
        {application.pages.length > 1 && <nav aria-label={tr(locale, "页面", "Pages")}>{application.pages.map((candidate) => <button className={candidate.id === page.id ? "active" : ""} key={candidate.id} onClick={() => onSelectPage(candidate.id)}>{candidate.name}</button>)}</nav>}
        <div><button onClick={onPublish}><Rocket size={13} />{tr(locale, "发布更新", "Publish update")}</button><button onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/apps/${encodeURIComponent(application.metadata.id)}`)}><Copy size={13} />{tr(locale, "复制发布链接", "Copy published URL")}</button><button onClick={onClose}><X size={13} />{tr(locale, "返回编辑", "Back to editor")}</button></div>
      </div>}
    </div>
  </main>;
}

function DashboardRuler({ orientation, length, viewportLength, zoom, offset, onPointerDown }: {
  orientation: "horizontal" | "vertical";
  length: number;
  viewportLength: number;
  zoom: number;
  offset: number;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const majorStep = zoom >= 0.75 ? 100 : zoom >= 0.35 ? 200 : 500;
  const ticks = Array.from({ length: Math.floor(length / majorStep) + 1 }, (_, index) => index * majorStep);
  return <div className={`dashboard-ruler ${orientation}`} style={orientation === "horizontal" ? { width: viewportLength } : { height: viewportLength }} onPointerDown={onPointerDown}>
    {ticks.map((position) => <span key={position} style={orientation === "horizontal" ? { left: offset + position * zoom } : { top: offset + position * zoom }}><i />{position}</span>)}
  </div>;
}

function DashboardNode({ application, project, node, frame, metric, selected, locale, rendererBackend, runtime = false, onSelectionChange, onObjectInteraction, onInteraction, onSelect, onContextMenu, onEnterScene, onTransformStart }: {
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
  onContextMenu?: (event: ReactMouseEvent) => void;
  onEnterScene: (sceneId: string) => void;
  onTransformStart: (event: ReactPointerEvent<HTMLButtonElement>, mode: "move" | "resize") => void;
}) {
  const style = { left: frame.x, top: frame.y, width: frame.width, height: frame.height, zIndex: node.zIndex, ...(!runtime && node.selectable === false ? { pointerEvents: "none" as const } : {}) };
  useEffect(() => {
    if (!runtime || node.kind !== "data-widget") return;
    const task = window.setTimeout(() => onInteraction("load"), 0);
    return () => window.clearTimeout(task);
  }, [node.id, runtime]);
  if (node.kind === "scene-viewport") {
    const scene = application.scenes.find((candidate) => candidate.id === node.sceneId);
    return <article className={`dashboard-node dashboard-scene-viewport ${selected ? "selected" : ""} ${runtime ? "runtime" : ""}`} style={style} onClick={(event) => { event.stopPropagation(); if (!runtime) onSelect(event.ctrlKey || event.metaKey); }} onContextMenu={(event) => { if (!runtime) onContextMenu?.(event); }}>
      {scene && node.renderMode !== "static-placeholder"
        ? <SceneViewportPreview locale={locale} node={node} scene={scene} project={project} rendererBackend={rendererBackend} runtime={runtime} onSelectionChange={onSelectionChange} onObjectInteraction={(trigger, target) => { if (runtime) onObjectInteraction(scene.id, trigger, target); }} />
        : <div className="dashboard-scene-grid" />}
      {!runtime && <button className="dashboard-scene-edit-hit-target" aria-label={tr(locale, "选择三维组件", "Select 3D component")} onClick={(event) => { event.stopPropagation(); onSelect(event.ctrlKey || event.metaKey); }} />}
      {!runtime && <><div className="dashboard-scene-summary"><span><Box size={36} /></span><strong>{scene?.name ?? node.sceneId}</strong><small>{scene ? `${scene.models.length + scene.primitives.length} ${tr(locale, "个场景对象", "scene objects")}` : tr(locale, "场景引用缺失", "Missing scene reference")}</small></div><div className="dashboard-node-badge">3D · {node.renderMode}</div><NodeTransformHandles selected={selected && node.locked !== true} onTransformStart={onTransformStart} /></>}
    </article>;
  }
  if (node.kind === "data-widget") return <article className={`dashboard-node dashboard-native-widget ${selected ? "selected" : ""} ${runtime ? `runtime animation-${node.widget.animation ?? "none"}` : ""}`} style={{ ...style, background: widgetBackground(node.widget), color: node.widget.textColor ?? "#eef2f4", animationDuration: `${node.widget.animationDuration ?? 0.6}s`, animationDelay: `${node.widget.animationDelay ?? 0}s` }} onClick={(event) => { event.stopPropagation(); runtime ? onInteraction("click") : onSelect(event.ctrlKey || event.metaKey); }} onDoubleClick={(event) => { if (runtime) { event.stopPropagation(); onInteraction("doubleClick"); } }} onContextMenu={(event) => { if (runtime) { event.preventDefault(); event.stopPropagation(); onInteraction("contextMenu"); } else onContextMenu?.(event); }} onPointerEnter={() => { if (runtime) onInteraction("pointerEnter"); }} onPointerLeave={() => { if (runtime) onInteraction("pointerLeave"); }} onAnimationStart={() => { if (runtime) onInteraction("animationStart"); }} onAnimationEnd={() => { if (runtime) onInteraction("animationEnd"); }}>
    {node.widget.type === "topology" ? <DashboardTopologyView application={application} {...(node.widget.topologyId ? { topologyId: node.widget.topologyId } : {})} /> : <DashboardWidgetView locale={locale} widget={node.widget} metric={metric} compact={!runtime} onAnimationStart={() => onInteraction("animationStart")} onAnimationEnd={() => onInteraction("animationEnd")} />}
    {!runtime && <><div className="dashboard-node-badge">{dataWidgetTypeLabel(locale, node.widget.type)}</div><NodeTransformHandles selected={selected && node.locked !== true} onTransformStart={onTransformStart} /></>}
  </article>;
  return null;
}

function NodeTransformHandles({ selected, onTransformStart }: { selected: boolean; onTransformStart: (event: ReactPointerEvent<HTMLButtonElement>, mode: "move" | "resize") => void }) {
  if (!selected) return null;
  return <><button className="dashboard-node-move-handle" aria-label="移动组件" onPointerDown={(event) => onTransformStart(event, "move")}><GripVertical size={13} /></button><button className="dashboard-node-resize-handle" aria-label="缩放组件" onPointerDown={(event) => onTransformStart(event, "resize")}><Scaling size={12} /></button></>;
}

function DashboardTopologyView({ application, topologyId }: { application: ApplicationDocument; topologyId?: string }) {
  const topology = application.topologies.find((candidate) => candidate.id === topologyId);
  if (!topology) return <div className="dashboard-topology-empty"><Workflow size={24} /><span>选择拓扑文档</span></div>;
  const bounds = topology.nodes.reduce((result, node) => ({ minX: Math.min(result.minX, node.x), minY: Math.min(result.minY, node.y), maxX: Math.max(result.maxX, node.x + 164), maxY: Math.max(result.maxY, node.y + 68) }), { minX: 0, minY: 0, maxX: 640, maxY: 360 });
  const width = Math.max(320, bounds.maxX - bounds.minX + 80);
  const height = Math.max(180, bounds.maxY - bounds.minY + 80);
  return <div className="dashboard-topology-widget"><header><Workflow size={14} /><strong>{topology.name}</strong><span>{topology.nodes.length} nodes · {topology.edges.length} links</span></header><svg viewBox={`${bounds.minX - 40} ${bounds.minY - 40} ${width} ${height}`} preserveAspectRatio="xMidYMid meet">{topology.edges.map((edge) => { const source = topology.nodes.find((node) => node.id === edge.sourceNodeId); const target = topology.nodes.find((node) => node.id === edge.targetNodeId); return source && target ? <line key={edge.id} x1={source.x + 82} y1={source.y + 34} x2={target.x + 82} y2={target.y + 34} /> : null; })}{topology.nodes.map((node) => <g key={node.id} transform={`translate(${node.x} ${node.y})`}><rect width="164" height="68" rx="10" /><circle cx="20" cy="34" r="6" className={topologyNodeHasBinding(node) ? "bound" : ""} /><text x="34" y="31">{String(node.properties.label ?? node.kind)}</text><text x="34" y="46" className="kind">{node.kind}</text></g>)}</svg></div>;
}

function topologyNodeHasBinding(node: ApplicationDocument["topologies"][number]["nodes"][number]): boolean {
  return Boolean(node.properties.dataBinding && typeof node.properties.dataBinding === "object");
}

function nodeLabel(node: WidgetNode): string {
  return node.name ?? (node.kind === "scene-viewport" ? `3D · ${node.sceneId}` : node.widget.title);
}

function nodeIdentity(node: WidgetNode): string {
  return node.name?.trim() || (node.kind === "scene-viewport" ? `3D · ${node.sceneId}` : node.widget.title.trim()) || node.id;
}

function uniqueNodeName(base: string, usedNames: ReadonlySet<string>): string {
  const normalizedBase = base.trim() || "Component";
  if (!usedNames.has(normalizedBase.toLocaleLowerCase())) return normalizedBase;
  let suffix = 2;
  while (usedNames.has(`${normalizedBase} ${suffix}`.toLocaleLowerCase())) suffix += 1;
  return `${normalizedBase} ${suffix}`;
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
  const staticWidget = type === "text" || type === "shape" || type === "decoration";
  return {
    title: dataWidgetTypeLabel(locale, type),
    key: media || staticWidget || type === "topology" ? "" : "value",
    type,
    unit: "",
    color: "#d4a84f",
    backgroundColor: "#172126",
    backgroundOpacity: 0.86,
    ...(type === "text" ? { content: tr(locale, "文本内容", "Text content"), fontSize: 28, fontWeight: 600, textAlign: "left" as const, backgroundOpacity: 0 } : {}),
    ...(type === "shape" ? { shape: "rounded" as const, content: "", color: "#d4a84f", borderColor: "#f0cd78", borderWidth: 1, backgroundOpacity: 0 } : {}),
    ...(type === "decoration" ? { decorationStyle: "title" as const, content: tr(locale, "看板标题", "Dashboard title"), backgroundOpacity: 0 } : {}),
    ...(type === "filter" ? { options: [tr(locale, "全部", "All"), tr(locale, "正常", "Normal"), tr(locale, "告警", "Alarm")] } : {}),
    ...(type === "gauge" ? { min: 0, max: 100 } : {}),
    ...(type === "image" ? { imageFit: "cover" as const } : {}),
    ...(type === "video" ? { videoFit: "contain" as const, videoAutoplay: true, videoMuted: true } : {}),
    ...(type === "monitor" ? { monitorProtocol: "hls" as const, videoFit: "cover" as const, videoAutoplay: true, videoMuted: true } : {}),
    ...(type === "url" ? { url: "https://example.com" } : {})
  };
}

function dataWidgetTypeLabel(locale: AppLocale, type: SceneDashboardWidgetType): string {
  const labels: Record<SceneDashboardWidgetType, [string, string]> = {
    text: ["文本", "Text"], shape: ["形状", "Shape"], decoration: ["装饰", "Decoration"], value: ["指标卡", "Metric"], progress: ["进度条", "Progress"], gauge: ["仪表盘", "Gauge"], status: ["状态卡", "Status"], line: ["折线图", "Line"], area: ["面积图", "Area"], bar: ["柱状图", "Bar"], pie: ["饼/环图", "Pie / donut"], scatter: ["散点图", "Scatter"], radar: ["雷达图", "Radar"], funnel: ["漏斗图", "Funnel"], rank: ["排行列表", "Ranking"], table: ["明细表", "Table"], filter: ["筛选器", "Filter"], image: ["图片", "Image"], video: ["视频", "Video"], monitor: ["实时监控", "Monitor"], url: ["网页", "Web page"], topology: ["拓扑", "Topology"]
  };
  return tr(locale, ...labels[type]);
}

function createDashboardTemplateNodes(locale: AppLocale, page: DashboardPageDocument, kind: "operations" | "production" | "energy", startZ: number): WidgetNode[] {
  const gap = 24;
  const margin = 40;
  const width = Math.max(260, page.width - margin * 2);
  const title = kind === "operations" ? tr(locale, "经营驾驶舱", "Operations cockpit") : kind === "production" ? tr(locale, "生产运行监控", "Production monitoring") : tr(locale, "能源效率分析", "Energy efficiency");
  const metricTitles = kind === "operations" ? ["营收", "订单", "交付率", "客户"] : kind === "production" ? ["产量", "OEE", "良率", "告警"] : ["综合能耗", "单位能耗", "峰值负荷", "节能率"];
  const make = (type: SceneDashboardWidgetType, name: string, frame: WidgetFrame, index: number, patch: Partial<DashboardDataWidgetConfig> = {}): WidgetNode => ({
    id: `widget:${crypto.randomUUID()}`,
    name: `${name} ${Date.now().toString(36).slice(-4)}-${index + 1}`,
    kind: "data-widget",
    frame,
    zIndex: startZ + index,
    widget: { ...defaultDataWidget(locale, type), title: name, ...patch }
  });
  const metricWidth = (width - gap * 3) / 4;
  const chartTop = 230;
  const chartHeight = Math.max(220, Math.min(360, page.height * .36));
  const nodes: WidgetNode[] = [make("decoration", title, { x: margin, y: 28, width, height: 64 }, 0, { content: title })];
  metricTitles.forEach((name, index) => nodes.push(make(index === 3 ? "progress" : "value", name, { x: margin + index * (metricWidth + gap), y: 112, width: metricWidth, height: 94 }, nodes.length, { key: `${kind}.${index + 1}` })));
  nodes.push(make("line", tr(locale, "趋势分析", "Trend analysis"), { x: margin, y: chartTop, width: width * .62 - gap / 2, height: chartHeight }, nodes.length, { key: `${kind}.trend` }));
  nodes.push(make(kind === "energy" ? "radar" : "bar", tr(locale, "结构分析", "Breakdown"), { x: margin + width * .62 + gap / 2, y: chartTop, width: width * .38 - gap / 2, height: chartHeight }, nodes.length, { key: `${kind}.breakdown` }));
  const bottom = chartTop + chartHeight + gap;
  if (bottom + 180 < page.height) nodes.push(make("table", tr(locale, "明细数据", "Details"), { x: margin, y: bottom, width, height: page.height - bottom - margin }, nodes.length, { key: `${kind}.details` }));
  return nodes;
}
