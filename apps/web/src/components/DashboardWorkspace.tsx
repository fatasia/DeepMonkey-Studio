import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
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
  CircleCheck,
  Copy,
  Database,
  Eye,
  EyeOff,
  GripVertical,
  Group,
  Layers3,
  LayoutDashboard,
  Lock,
  Minus,
  Pencil,
  Plus,
  Redo2,
  Rocket,
  Save,
  Search,
  Star,
  Scaling,
  ScanSearch,
  Trash2,
  TriangleAlert,
  Undo2,
  Ungroup,
  Unlock,
  Workflow,
  X,
} from "lucide-react";
import {
  type ApplicationDocument,
  type ApplicationObjectRef,
  type DashboardDataWidgetConfig,
  type DashboardGuide,
  type DashboardPageAppearance,
  type DashboardPageDocument,
  type DirectBindingSpec,
  type JsonValue,
  type ProjectRecord,
  type SceneDashboardWidgetType,
  type SceneInteractionTarget,
  type SceneInteractionTrigger,
  type WidgetFrame,
  type WidgetNode,
} from "@bim-studio/contracts";
import {
  createDeleteDashboardNodesCommand,
  createDeleteDashboardPageCommand,
  createInsertDashboardNodeCommand,
  createInsertDashboardNodesCommand,
  createInsertDashboardPageCommand,
  createRenameDashboardPageCommand,
  createUpdateDashboardDataWidgetCommand,
  createUpdateDashboardDataWidgetsCommand,
  createUpdateDashboardNodeFrameCommand,
  createUpdateDashboardNodeFramesCommand,
  createUpdateDashboardNodeOrderCommand,
  createUpdateDashboardNodeStateCommand,
  createUpdateDashboardNodeStatesCommand,
  createUpdateDashboardSceneViewportCommand,
  createUpdateDashboardPageViewportCommand,
  createUpdateDashboardPageAppearanceCommand,
  createUpdateDashboardPageGuidesCommand,
  alignDashboardFrames,
  distributeDashboardFrames,
  type DashboardAlignment,
  type DashboardDistribution,
  type ApplicationInteractionResult,
  type StudioCommand,
} from "@bim-studio/studio-core";
import { translate as tr, type AppLocale } from "../i18n";
import { DASHBOARD_INSPECTOR_STORAGE_KEY, DASHBOARD_LEFT_PANEL_STORAGE_KEY } from "../appDefaults";
import { usePersistedBooleanState } from "../hooks/usePersistedBooleanState";
import { normalizeDashboardViewState, type DashboardViewState } from "../studio/workspaceRoute";
import { InteractionFlowInspector } from "./InteractionFlowInspector";
import { useDashboardMetrics, type DashboardMetric } from "./DashboardWidgetRuntime";
import { DashboardMediaInspector } from "./DashboardMediaInspector";
import { DashboardConditionalRulesEditor } from "./DashboardConditionalRulesEditor";
import { createDashboardTemplateNodes, DASHBOARD_TEMPLATES, type DashboardTemplateKind } from "./DashboardTemplateCatalog";
import type { DashboardComponentPreset } from "./DashboardComponentCatalog";
import { DASHBOARD_LIBRARY_DRAG_TYPE, DashboardComponentLibrary, resolveDashboardLibraryItem } from "./DashboardComponentLibrary";
import { DashboardNode } from "./DashboardCanvasNode";
import { DashboardPageViewportEditor } from "./DashboardPageViewportEditor";
import { DashboardRuler } from "./DashboardRuler";
import { DashboardRuntimePreview } from "./DashboardRuntimePreview";
import { dashboardBackgroundStyle } from "./dashboardCanvasStyle";
import { DASHBOARD_COMPONENT_BACKGROUNDS, dashboardComponentBackgroundText } from "./DashboardComponentBackgroundCatalog";
import { replaceDashboardWidgetDataProduct } from "./dashboardDataProductReplacement";
import { diagnoseDashboardPage } from "./dashboardDiagnostics";
import { downloadDashboardPageData } from "./dashboardPageExport";
import { createDefaultDirectBinding, DirectBindingEditor } from "./DirectBindingEditor";
import { UnityResourceInspector } from "./UnityResourceInspector";
import { WorkspaceModeSwitch } from "./WorkspaceModeSwitch";
import type { RendererBackend } from "../viewer/ViewerEngine";

import {
  CANVAS_MARGIN,
  DATA_WIDGET_TYPES,
  DECORATION_ASSETS,
  RULER_SIZE,
  SNAP_THRESHOLD_PX,
  TEMPLATE_FAVORITES_KEY,
  calculateDashboardEditorFocus,
  calculateDashboardEditorZoom,
  dashboardNodeIdentity as nodeIdentity,
  dashboardNodeLabel as nodeLabel,
  dashboardSceneName as sceneName,
  dashboardNodeSelection,
  dataWidgetTypeLabel,
  readTemplateFavorites,
  snapDashboardFrame,
  uniqueDashboardNodeName as uniqueNodeName,
  type ActiveSnapLines,
  type DashboardContextMenuState,
  type InspectorTab,
  type SelectionRect,
} from "./dashboardWorkspaceModel";
import { createDashboardCanvasController } from "./dashboardCanvasController";
import { createDashboardContentController } from "./dashboardContentController";
import type { DashboardWorkspaceProps } from "./dashboardWorkspaceTypes";
import { DashboardWorkspaceView } from "./DashboardWorkspaceView";

export {
  calculateDashboardEditorFocus,
  calculateDashboardEditorZoom,
  calculateDashboardRuntimeViewport,
  dashboardNodeSelection,
  snapDashboardFrame,
  updateDashboardParameterDraft,
} from "./dashboardWorkspaceModel";
export type { DashboardWorkspaceProps } from "./dashboardWorkspaceTypes";

function useDashboardWorkspaceController({
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
  liveDataEnabled = true,
  selection,
  variables,
  filters,
  onBack,
  onSelectPage,
  onEnterScene,
  onOpen3D,
  onOpenTopology,
  onOpenData,
  onOpenScripts,
  scriptOpen = false,
  onCloseScripts,
  onSelectionChange,
  onFilterChange,
  onVariableChange,
  onObjectInteraction,
  onNodeInteraction,
  onCommand,
  onUndo,
  onRedo,
  onSave,
  onAutoSaveChange,
  onPublish,
  onViewStateChange,
}: DashboardWorkspaceProps) {
  const normalizedInitialView = useMemo(() => normalizeDashboardViewState(initialView), [page.id]);
  const [zoom, setZoom] = useState(normalizedInitialView.zoom);
  const [selectedNodeIds, setSelectedNodeIds] = useState(normalizedInitialView.selectedNodeIds);
  const [runtimePreview, setRuntimePreview] = useState(false);
  // 左侧资源栏和右侧检查器都是辅助区，允许用户释放画布空间。
  const [leftPanelOpen, setLeftPanelOpen] = usePersistedBooleanState(DASHBOARD_LEFT_PANEL_STORAGE_KEY, true);
  const [inspectorOpen, setInspectorOpen] = usePersistedBooleanState(DASHBOARD_INSPECTOR_STORAGE_KEY, true);
  // 页面与图层是进入二维编辑器后的默认工作上下文；资源按需打开。
  const [leftPanelTab, setLeftPanelTab] = useState<"pages" | "components" | "layers">("pages");
  const [draftFrames, setDraftFrames] = useState<Record<string, WidgetFrame>>({});
  const [selectionRect, setSelectionRect] = useState<SelectionRect>();
  const [marqueeMode, setMarqueeMode] = useState(false);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [guidesVisible, setGuidesVisible] = useState(true);
  const [draftGuides, setDraftGuides] = useState<DashboardGuide[]>();
  const [activeSnapLines, setActiveSnapLines] = useState<ActiveSnapLines>({
    x: [],
    y: [],
  });
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("content");
  const [nodeNameError, setNodeNameError] = useState("");
  const [templateLibraryOpen, setTemplateLibraryOpen] = useState(false);
  const [templateQuery, setTemplateQuery] = useState("");
  const [templateCategory, setTemplateCategory] = useState("all");
  const [favoriteTemplateIds, setFavoriteTemplateIds] = useState<string[]>(readTemplateFavorites);
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const [viewportScroll, setViewportScroll] = useState({ left: 0, top: 0 });
  const [panning, setPanning] = useState(false);
  const [contextMenu, setContextMenu] = useState<DashboardContextMenuState>();
  const [draggedLayerId, setDraggedLayerId] = useState<string>();
  const [layerDropTargetId, setLayerDropTargetId] = useState<string>();
  const [libraryDropActive, setLibraryDropActive] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const artboardRef = useRef<HTMLDivElement>(null);
  const spacePressedRef = useRef(false);
  const pageNameCommitRef = useRef(page.name);
  const clipboardRef = useRef<WidgetNode[]>([]);
  const previousSurfaceSizeRef = useRef({ width: 0, height: 0 });
  const componentSearchRef = useRef<HTMLInputElement>(null);
  const backgroundImageRef = useRef<HTMLInputElement>(null);
  const componentBackgroundImageRef = useRef<HTMLInputElement>(null);
  const selectedNode = page.nodes.find((node) => selectedNodeIds.includes(node.id));
  const linkedSceneViewport = page.nodes.find((node) => node.kind === "scene-viewport");
  const linkedSceneId = linkedSceneViewport && "sceneId" in linkedSceneViewport ? linkedSceneViewport.sceneId : undefined;
  const selectedDataNodes = useMemo(
    () =>
      page.nodes.filter((node): node is Extract<WidgetNode, { kind: "data-widget" }> => selectedNodeIds.includes(node.id) && node.kind === "data-widget" && node.locked !== true),
    [page.nodes, selectedNodeIds],
  );
  const selectedDataProductValues = [
    ...new Set(
      selectedDataNodes.flatMap((node) => (node.widget.pipelineId ? [`pipeline:${node.widget.pipelineId}`] : node.widget.datasetId ? [`dataset:${node.widget.datasetId}`] : [])),
    ),
  ];
  const selectedDataProductValue = selectedDataProductValues.length === 1 ? (selectedDataProductValues[0] ?? "") : "";
  const selectedInspectorIdentity =
    selectedNode?.kind === "data-widget" ? `${selectedNode.id}:data:${selectedNode.widget.type}` : selectedNode ? `${selectedNode.id}:${selectedNode.kind}` : "none";
  const overflowNodeIds = useMemo(
    () =>
      page.nodes
        .filter((node) => node.frame.x < 0 || node.frame.y < 0 || node.frame.x + node.frame.width > page.width || node.frame.y + node.frame.height > page.height)
        .map((node) => node.id),
    [page.nodes, page.width, page.height],
  );
  const layoutSelectionCount = page.nodes.filter((node) => selectedNodeIds.includes(node.id) && node.visible !== false && node.locked !== true).length;
  const dashboardGroups = useMemo(() => {
    const groups = new Map<string, WidgetNode[]>();
    for (const node of page.nodes) {
      if (!node.groupId) continue;
      groups.set(node.groupId, [...(groups.get(node.groupId) ?? []), node]);
    }
    return [...groups.entries()].map(([id, nodes], index) => ({
      id,
      nodes,
      label: nodes.find((node) => node.groupName?.trim())?.groupName?.trim() ?? `${tr(locale, "编组", "Group")} ${index + 1}`,
    }));
  }, [locale, page.nodes]);
  const dataWidgetConfigs = useMemo(() => page.nodes.flatMap((node) => (node.kind === "data-widget" ? [node.widget] : [])), [page.nodes]);
  const dashboardDiagnostics = useMemo(() => diagnoseDashboardPage(application, page), [application, page]);
  const { metrics, datasets, pipelines, fieldsByProduct, statusByProduct, catalogError, connected } = useDashboardMetrics(
    project.id,
    dataWidgetConfigs,
    undefined,
    filters,
    liveDataEnabled,
  );
  const selectedProductKey =
    selectedNode?.kind === "data-widget"
      ? selectedNode.widget.pipelineId
        ? `pipeline:${selectedNode.widget.pipelineId}`
        : selectedNode.widget.datasetId
          ? `dataset:${selectedNode.widget.datasetId}`
          : undefined
      : undefined;
  const analysisFields = selectedProductKey ? (fieldsByProduct[selectedProductKey] ?? []) : [];
  const runtimeMetrics = useMemo<Record<string, DashboardMetric>>(
    () => ({
      ...metrics,
      ...Object.fromEntries(
        Object.entries(variables).map(([key, value]) => [
          key,
          {
            value,
            samples: typeof value === "number" && Number.isFinite(value) ? [{ time: Date.now(), value }] : [],
          },
        ]),
      ),
    }),
    [metrics, variables],
  );
  const stageWidth = Math.max(surfaceSize.width, page.width * zoom + CANVAS_MARGIN * 2);
  const stageHeight = Math.max(surfaceSize.height, page.height * zoom + CANVAS_MARGIN * 2);
  const artboardOffsetX = Math.max(CANVAS_MARGIN, (stageWidth - page.width * zoom) / 2);
  const artboardOffsetY = Math.max(CANVAS_MARGIN, (stageHeight - page.height * zoom) / 2);

  useEffect(() => {
    // Every selection/type change starts from the common content view. This prevents
    // carrying a stale data/style tab to a component where that tab has no controls.
    setInspectorTab("content");
    setNodeNameError("");
  }, [page.id, selectedInspectorIdentity]);

  useEffect(() => {
    const surface = scrollRef.current;
    if (!surface) return;
    // resize 风暴期间不跟随，停稳 180ms 后最多执行一次自动聚焦：即时 fit 会改写
    // zoom/scroll 并触发 ResizeObserver 再判定，与滚动条出现/消失形成反馈振荡
    // （画布与滚动条抖动，U1-10 根因）。setSurfaceSize 仍即时跟进保证画布盒正确。
    let fitTimer = 0;
    const update = () => {
      const nextSize = {
        width: surface.clientWidth,
        height: surface.clientHeight,
      };
      const previousSize = previousSurfaceSizeRef.current;
      const resized = previousSize.width > 0 && (previousSize.width !== nextSize.width || previousSize.height !== nextSize.height);
      const previousFocus = calculateDashboardEditorFocus(page, page.nodes, previousSize.width, previousSize.height, "smart");
      previousSurfaceSizeRef.current = nextSize;
      setSurfaceSize(nextSize);
      if (!resized || Math.abs(zoom - previousFocus.zoom) >= 0.006) return;
      window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => fitCanvasToViewport("smart"), 180);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => {
      window.clearTimeout(fitTimer);
      observer.disconnect();
    };
  }, [page.id, zoom]);

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
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spacePressedRef.current = false;
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
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
      const isDefaultEntry =
        normalizedInitialView.zoom === 0.5 && normalizedInitialView.scrollLeft === 0 && normalizedInitialView.scrollTop === 0 && normalizedInitialView.selectedNodeIds.length === 0;
      if (isDefaultEntry) fitCanvasToViewport("smart");
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
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRuntimePreview(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [runtimePreview]);

  const {
    currentView,
    emitViewState,
    handleCanvasScroll,
    fitCanvasToViewport,
    changeZoom,
    zoomCanvas,
    beginCanvasPan,
    selectNode,
    updateSelectedFrame,
    beginNodeTransform,
    addGuide,
    beginGuideDrag,
    copySelectedNodes,
    pasteCopiedNodes,
    deleteSelectedNodes,
    deleteLayerNode,
    toggleLayerLock,
    nudgeSelectedNodes,
    layoutSelectedNodes,
    groupSelectedNodes,
    ungroupSelectedNodes,
    renameDashboardGroup,
    updateDashboardGroup,
    reorderSelectedNodes,
    reorderNodeIds,
    reorderLayerByDrop,
    contextNodeIds,
    openNodeContextMenu,
    copyContextNodes,
    updateContextNodes,
    deleteContextNodes,
    beginMarqueeSelection,
  } = createDashboardCanvasController({
    locale,
    page,
    zoom,
    setZoom,
    selectedNode,
    selectedNodeIds,
    setSelectedNodeIds,
    normalizedInitialView,
    scrollRef,
    artboardRef,
    artboardOffsetX,
    artboardOffsetY,
    spacePressedRef,
    setViewportScroll,
    setPanning,
    busy,
    onViewStateChange,
    onSelectionChange,
    onNodeInteraction,
    onCommand,
    guidesVisible,
    snapEnabled,
    setDraftFrames,
    setActiveSnapLines,
    draftGuides,
    setDraftGuides,
    clipboardRef,
    contextMenu,
    setContextMenu,
    marqueeMode,
    setMarqueeMode,
    setSelectionRect,
    dashboardGroups,
  });

  useEffect(() => {
    if (runtimePreview) return;
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const key = event.key.toLowerCase();
      const commandKey = event.ctrlKey || event.metaKey;
      if (commandKey && key === "f") {
        event.preventDefault();
        componentSearchRef.current?.focus();
        return;
      }
      if (commandKey && (key === "]" || key === "[")) {
        event.preventDefault();
        reorderSelectedNodes(key === "]" ? (event.shiftKey ? "front" : "forward") : event.shiftKey ? "back" : "backward");
        return;
      }
      if (commandKey && key === "a") {
        event.preventDefault();
        const ids = page.nodes.filter((node) => node.visible !== false && node.selectable !== false).map((node) => node.id);
        setSelectedNodeIds(ids);
        onSelectionChange(ids.map((id) => ({ kind: "widget", id })));
        return;
      }
      if (commandKey && key === "c") {
        event.preventDefault();
        copySelectedNodes();
        return;
      }
      if (commandKey && key === "v") {
        event.preventDefault();
        pasteCopiedNodes();
        return;
      }
      if (commandKey && key === "d") {
        event.preventDefault();
        copySelectedNodes();
        pasteCopiedNodes();
        return;
      }
      if (commandKey && key === "s") {
        event.preventDefault();
        if (!busy) onSave();
        return;
      }
      if (commandKey && key === "z") {
        event.preventDefault();
        if (event.shiftKey ? canRedo : canUndo) (event.shiftKey ? onRedo : onUndo)();
        return;
      }
      if (commandKey && key === "y") {
        event.preventDefault();
        if (canRedo) onRedo();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelectedNodes();
        return;
      }
      if (event.key === "Escape") {
        setSelectedNodeIds([]);
        setMarqueeMode(false);
        onSelectionChange([]);
        return;
      }
      const step = event.shiftKey ? 10 : 1;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        nudgeSelectedNodes(-step, 0);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        nudgeSelectedNodes(step, 0);
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        nudgeSelectedNodes(0, -step);
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        nudgeSelectedNodes(0, step);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [page, selectedNodeIds, runtimePreview, busy, canUndo, canRedo, onSelectionChange, onCommand, onSave, onUndo, onRedo]);

  const {
    addDashboardPage,
    duplicateDashboardPage,
    deleteDashboardPage,
    commitPageName,
    commitPageViewport,
    updatePageAppearance,
    uploadPageBackground,
    clearPageBackground,
    uploadComponentBackground,
    clearComponentBackground,
    applyComponentBackground,
    selectOverflowNodes,
    addDataWidget,
    addSceneViewport,
    insertDashboardTemplate,
    updateSceneViewport,
    commitNodeName,
    updateDataWidget,
    selectDataProduct,
    replaceSelectedDataProduct,
    toggleTemplateFavorite,
    selectDataField,
    assignAnalysisField,
    toggleReportValueField,
  } = createDashboardContentController({
    locale,
    application,
    project,
    page,
    zoom,
    busy,
    selectedNode,
    selectedDataNodes,
    overflowNodeIds,
    fieldsByProduct,
    analysisFields,
    pageNameCommitRef,
    backgroundImageRef,
    componentBackgroundImageRef,
    setSelectedNodeIds,
    setNodeNameError,
    setFavoriteTemplateIds,
    onCommand,
    onSelectPage,
    onSelectionChange,
  });

  function allowLibraryDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (![...event.dataTransfer.types].includes(DASHBOARD_LIBRARY_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setLibraryDropActive(true);
  }

  function dropLibraryItem(event: ReactDragEvent<HTMLDivElement>) {
    const itemId = event.dataTransfer.getData(DASHBOARD_LIBRARY_DRAG_TYPE);
    if (!itemId || !artboardRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = artboardRef.current.getBoundingClientRect();
    const placement = {
      centerX: ((event.clientX - bounds.left) * page.width) / Math.max(bounds.width, 1),
      centerY: ((event.clientY - bounds.top) * page.height) / Math.max(bounds.height, 1),
    };
    if (itemId === "scene") addSceneViewport(placement);
    else {
      const item = resolveDashboardLibraryItem(locale, itemId);
      if (item) addDataWidget(item.type, item.preset?.widget ?? item.widget, item.preset?.frame, placement, item.label);
    }
    setLibraryDropActive(false);
  }

  return {
    activeSnapLines,
    addDashboardPage,
    addDataWidget,
    addGuide,
    addSceneViewport,
    allowLibraryDrop,
    analysisFields,
    application,
    applyComponentBackground,
    artboardOffsetX,
    artboardOffsetY,
    artboardRef,
    assignAnalysisField,
    autoSaveEnabled,
    backgroundImageRef,
    beginCanvasPan,
    beginGuideDrag,
    beginMarqueeSelection,
    beginNodeTransform,
    busy,
    canRedo,
    canUndo,
    catalogError,
    changeZoom,
    clearComponentBackground,
    clearPageBackground,
    commitNodeName,
    commitPageName,
    commitPageViewport,
    componentBackgroundImageRef,
    componentSearchRef,
    connected,
    contextMenu,
    contextNodeIds,
    copyContextNodes,
    currentView,
    dashboardDiagnostics,
    dashboardGroups,
    datasets,
    deleteContextNodes,
    deleteDashboardPage,
    deleteLayerNode,
    deleteSelectedNodes,
    dirty,
    draftFrames,
    draftGuides,
    draggedLayerId,
    dropLibraryItem,
    duplicateDashboardPage,
    favoriteTemplateIds,
    fieldsByProduct,
    filters,
    fitCanvasToViewport,
    groupSelectedNodes,
    guidesVisible,
    handleCanvasScroll,
    insertDashboardTemplate,
    inspectorTab,
    layerDropTargetId,
    layoutSelectedNodes,
    layoutSelectionCount,
    leftPanelTab,
    leftPanelOpen,
    inspectorOpen,
    libraryDropActive,
    linkedSceneId,
    locale,
    marqueeMode,
    nodeNameError,
    onAutoSaveChange,
    onBack,
    onCommand,
    onEnterScene,
    onFilterChange,
    onNodeInteraction,
    onObjectInteraction,
    onOpen3D,
    onOpenData,
    onOpenScripts,
    scriptOpen,
    onCloseScripts,
    onOpenTopology,
    onPublish,
    onRedo,
    onSave,
    onSelectPage,
    onSelectionChange,
    onUndo,
    onVariableChange,
    openNodeContextMenu,
    overflowNodeIds,
    page,
    panning,
    pipelines,
    project,
    renameDashboardGroup,
    rendererBackend,
    reorderLayerByDrop,
    reorderNodeIds,
    reorderSelectedNodes,
    replaceSelectedDataProduct,
    runtimeMetrics,
    runtimePreview,
    scrollRef,
    selectDataField,
    selectDataProduct,
    selectNode,
    selectOverflowNodes,
    selectedDataNodes,
    selectedDataProductValue,
    selectedDataProductValues,
    selectedNode,
    selectedNodeIds,
    selectionRect,
    setContextMenu,
    setDraggedLayerId,
    setGuidesVisible,
    setInspectorTab,
    setLayerDropTargetId,
    setLeftPanelTab,
    setLeftPanelOpen,
    setInspectorOpen,
    setLibraryDropActive,
    setMarqueeMode,
    setNodeNameError,
    setRuntimePreview,
    setSelectedNodeIds,
    setSnapEnabled,
    setTemplateCategory,
    setTemplateLibraryOpen,
    setTemplateQuery,
    snapEnabled,
    stageHeight,
    stageWidth,
    statusByProduct,
    surfaceSize,
    templateCategory,
    templateLibraryOpen,
    templateQuery,
    toggleLayerLock,
    toggleReportValueField,
    toggleTemplateFavorite,
    ungroupSelectedNodes,
    updateContextNodes,
    updateDashboardGroup,
    updateDataWidget,
    updatePageAppearance,
    updateSceneViewport,
    updateSelectedFrame,
    uploadComponentBackground,
    uploadPageBackground,
    variables,
    viewportScroll,
    zoom,
    zoomCanvas,
  };
}

export type DashboardWorkspaceController = ReturnType<typeof useDashboardWorkspaceController>;

export function DashboardWorkspace(props: DashboardWorkspaceProps) {
  const controller = useDashboardWorkspaceController(props);
  return <DashboardWorkspaceView controller={controller} />;
}
