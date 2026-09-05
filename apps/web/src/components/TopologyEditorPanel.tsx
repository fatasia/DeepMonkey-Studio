import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { JsonValue, TopologyDocument, TopologyNode, TopologyScadaAlarmState, TopologyScadaRuntimeState } from "@bim-studio/contracts";
import {
  alignTopologyNodes,
  applyTopologyEditorAction,
  assessTopologyScadaRuntime,
  createTopologyEdge,
  createTopologyEditorState,
  createTopologyNode,
  createTopologyScadaNode,
  duplicateTopologySelection,
  isTopologyScadaNode,
  layoutTopologyNodes,
  summarizeTopologyScadaRuntime,
  topologyNodeDataBinding,
  topologyNodeLabel,
  topologyNodeScadaConfig,
  type TopologyDataBindingRef,
  type TopologyEditorAction,
  type TopologyEditorState,
  type TopologyScadaNodeConfig,
  type TopologyScadaNodeKind,
  type TopologyAlignment,
} from "@bim-studio/studio-core";
import type { AppLocale } from "../i18n";
import {
  ScadaRuntimeCard,
  topologyEdgeAnimated,
  topologyEdgeLabel,
  topologyEdgeMedium,
  topologyEdgeStateClass,
  topologyNodeElevation,
  topologyPlanPositionFromProjected,
  topologyProjectedPosition,
  type TopologyViewMode,
} from "./topologyEditorRuntime";
import { TopologyEditorPanelView } from "./TopologyEditorPanelView";
import { useTopologyViewport } from "./useTopologyViewport";
import {
  TOPOLOGY_NODE_PRESET_GROUPS,
  TOPOLOGY_NODE_PRESETS,
  type TopologyNodePreset,
} from "./TopologyPresetCatalog";

export {
  ScadaRuntimeCard,
  topologyEdgeAnimated,
  topologyEdgeLabel,
  topologyEdgeMedium,
  topologyEdgeStateClass,
  topologyNodeElevation,
  topologyPlanPositionFromProjected,
  topologyProjectedPosition,
} from "./topologyEditorRuntime";

export interface TopologyDataProductOption {
  readonly id: string;
  readonly type: "dataset" | "pipeline";
  readonly name: string;
  readonly fields?: readonly string[];
  readonly refreshSeconds?: number;
}

export interface TopologyEditorPanelProps {
  readonly locale: AppLocale;
  readonly document: TopologyDocument;
  readonly dataProducts?: readonly TopologyDataProductOption[];
  /** Live values are supplied by the SCADA runtime and are never persisted into the topology document. */
  readonly runtimeStates?: Readonly<Record<string, TopologyScadaRuntimeState>>;
  /** Clock override for deterministic hosts/tests. Defaults to Date.now(). */
  readonly runtimeNow?: number;
  /** A point is stale after this age. Defaults to 60 seconds. */
  readonly runtimeStaleAfterMs?: number;
  /** Requests acknowledgement from the owning SCADA service; the panel never mutates the snapshot locally. */
  readonly onAcknowledgeAlarm?: (nodeId: string, alarm: TopologyScadaAlarmState) => void | Promise<void>;
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

const NODE_WIDTH = 164;
const NODE_HEIGHT = 76;
const CANVAS_WIDTH = 1600;
const CANVAS_HEIGHT = 1000;
const GRID_SIZE = 16;

function useTopologyEditorController({
  locale,
  document,
  dataProducts = [],
  runtimeStates = {},
  runtimeNow,
  runtimeStaleAfterMs = 60_000,
  onAcknowledgeAlarm,
  onChange,
  dirty = false,
  busy = false,
  autoSaveEnabled = false,
  onAutoSaveChange,
  onSave,
  onPublish,
  onInsertDashboard,
  onClose,
  onError,
}: TopologyEditorPanelProps) {
  const [editor, setEditor] = useState<TopologyEditorState>(() => createTopologyEditorState(document));
  const editorRef = useRef(editor);
  const [tool, setTool] = useState<Tool>("select");
  const [viewMode, setViewMode] = useState<TopologyViewMode>("2d");
  const viewport = useTopologyViewport(editor.document, viewMode);
  const { zoom, zoomIn, zoomOut, resetZoom } = viewport;
  const [paletteQuery, setPaletteQuery] = useState("");
  const [connectionSourceId, setConnectionSourceId] = useState<string>();
  const [drag, setDrag] = useState<{ pointerId: number; nodeId: string; offsetX: number; offsetY: number }>();
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number }>();
  const [operationError, setOperationError] = useState<string>();
  const [acknowledgePendingNodeId, setAcknowledgePendingNodeId] = useState<string>();
  const [runtimeClock, setRuntimeClock] = useState(() => Date.now());
  const canvasRef = useRef<HTMLDivElement>(null);
  const markerId = `topology-arrow-${useId().replaceAll(":", "")}`;

  useEffect(() => {
    const next = createTopologyEditorState(document);
    editorRef.current = next;
    setEditor(next);
    setConnectionSourceId(undefined);
  }, [document.id]);

  useEffect(() => {
    if (runtimeNow !== undefined) return;
    const intervalMs = Math.max(1_000, Math.min(30_000, runtimeStaleAfterMs / 2 || 1_000));
    const timer = window.setInterval(() => setRuntimeClock(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [runtimeNow, runtimeStaleAfterMs]);

  const selection = editor.selection[0];
  const selectedNodeIds = editor.selection.filter((item) => item.kind === "node").map((item) => item.id);
  const selectedNode = selection?.kind === "node" ? editor.document.nodes.find((node) => node.id === selection.id) : undefined;
  const selectedEdge = selection?.kind === "edge" ? editor.document.edges.find((edge) => edge.id === selection.id) : undefined;
  const binding = selectedNode ? topologyNodeDataBinding(selectedNode) : undefined;
  const scadaConfig = selectedNode ? topologyNodeScadaConfig(selectedNode) : undefined;
  const selectedRuntimeState = selectedNode ? runtimeStates[selectedNode.id] : undefined;
  const runtimeNowMs = runtimeNow ?? runtimeClock;
  const selectedRuntimeAssessment = assessTopologyScadaRuntime(selectedRuntimeState, runtimeNowMs, runtimeStaleAfterMs);
  const activeAlarms = editor.document.nodes.filter((node) => runtimeStates[node.id]?.alarm?.active);
  const runtimeSummary = summarizeTopologyScadaRuntime(editor.document.nodes, runtimeStates, runtimeNowMs, runtimeStaleAfterMs);
  const selectedProduct = binding ? dataProducts.find((product) => product.type === binding.productType && product.id === binding.productId) : undefined;
  const edgeGeometry = useMemo(
    () =>
      editor.document.edges
        .map((edge) => {
          const source = editor.document.nodes.find((node) => node.id === edge.sourceNodeId);
          const target = editor.document.nodes.find((node) => node.id === edge.targetNodeId);
          return source && target ? { edge, source, target } : undefined;
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    [editor.document],
  );
  const presetGroups = useMemo(() => {
    const query = paletteQuery.trim().toLocaleLowerCase();
    if (!query) return TOPOLOGY_NODE_PRESET_GROUPS;
    return TOPOLOGY_NODE_PRESET_GROUPS
      .map((group) => ({
        ...group,
        presets: group.presets.filter((preset) =>
          `${preset.labelZh} ${preset.labelEn} ${preset.kind}`.toLocaleLowerCase().includes(query)),
      }))
      .filter((group) => group.presets.length > 0);
  }, [paletteQuery]);

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

  function addNode(preset: TopologyNodePreset) {
    const index = editor.document.nodes.length;
    const x = 120 + (index % 4) * 220;
    const y = 120 + Math.floor(index / 4) * 150;
    const label = locale === "zh-CN" ? preset.labelZh : preset.labelEn;
    const node =
      preset.scada
        ? createTopologyScadaNode(crypto.randomUUID(), preset.kind as TopologyScadaNodeKind, x, y, label)
        : createTopologyNode(crypto.randomUUID(), preset.kind, x, y, label);
    dispatch({ type: "node.add", node });
    dispatch({ type: "selection.set", selection: [{ kind: "node", id: node.id }] });
  }

  function selectNode(nodeId: string, extend = false) {
    if (tool !== "connect") {
      if (!extend) {
        dispatch({ type: "selection.set", selection: [{ kind: "node", id: nodeId }] });
        return;
      }
      const selected = editorRef.current.selection.filter((item) => item.kind === "node");
      const exists = selected.some((item) => item.id === nodeId);
      dispatch({
        type: "selection.set",
        selection: exists ? selected.filter((item) => item.id !== nodeId) : [...selected, { kind: "node", id: nodeId }],
      });
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
    const source = editor.document.nodes.find((node) => node.id === connectionSourceId);
    const target = editor.document.nodes.find((node) => node.id === nodeId);
    const edge = createTopologyEdge(crypto.randomUUID(), connectionSourceId, nodeId);
    dispatch({
      type: "edge.add",
      edge: source && target && (isTopologyScadaNode(source) || isTopologyScadaNode(target)) ? { ...edge, properties: { medium: "signal", animated: true } } : edge,
    });
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
    const visual = topologyProjectedPosition(node, viewMode);
    setDrag({
      pointerId: event.pointerId,
      nodeId: node.id,
      offsetX: (event.clientX - rect.left) / zoom - visual.x,
      offsetY: (event.clientY - rect.top) / zoom - visual.y,
    });
    setDragPosition({ x: node.x, y: node.y });
    if (!editorRef.current.selection.some((item) => item.kind === "node" && item.id === node.id)) {
      dispatch({ type: "selection.set", selection: [{ kind: "node", id: node.id }] });
    }
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const node = editor.document.nodes.find((item) => item.id === drag.nodeId);
    const elevation = node ? topologyNodeElevation(node) : 0;
    const planPosition = topologyPlanPositionFromProjected(
      {
        x: (event.clientX - rect.left) / zoom - drag.offsetX,
        y: (event.clientY - rect.top) / zoom - drag.offsetY,
      },
      elevation,
      viewMode,
    );
    const x = snap(Math.max(24, Math.min(CANVAS_WIDTH - NODE_WIDTH - 24, planPosition.x)));
    const y = snap(Math.max(24, Math.min(CANVAS_HEIGHT - NODE_HEIGHT - 24, planPosition.y)));
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
    const nodeIds = editorRef.current.selection.filter((item) => item.kind === "node").map((item) => item.id);
    const edgeIds = editorRef.current.selection.filter((item) => item.kind === "edge").map((item) => item.id);
    if (nodeIds.length) dispatch({ type: "node.remove", nodeIds });
    const remainingEdges = edgeIds.filter((edgeId) => editorRef.current.document.edges.some((edge) => edge.id === edgeId));
    if (remainingEdges.length) dispatch({ type: "edge.remove", edgeIds: remainingEdges });
  }

  function autoLayout() {
    const positions = layoutTopologyNodes(editorRef.current.document);
    if (positions.length) dispatch({ type: "node.move", positions });
  }

  function alignSelection(alignment: TopologyAlignment) {
    const state = editorRef.current;
    const nodeIds = state.selection.filter((item) => item.kind === "node").map((item) => item.id);
    const positions = alignTopologyNodes(state.document, nodeIds, alignment);
    if (positions.length) dispatch({ type: "node.move", positions });
  }

  function duplicateSelection() {
    const state = editorRef.current;
    const nodeIds = state.selection.filter((item) => item.kind === "node").map((item) => item.id);
    if (!nodeIds.length) return;
    const copy = duplicateTopologySelection(state.document, nodeIds, () => crypto.randomUUID());
    dispatch({ type: "graph.insert", nodes: copy.nodes, edges: copy.edges });
    dispatch({ type: "selection.set", selection: copy.nodeIds.map((id) => ({ kind: "node" as const, id })) });
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
    } else if (command && event.key.toLowerCase() === "d") {
      event.preventDefault();
      duplicateSelection();
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

  function updateScadaConfig(patch: Partial<TopologyScadaNodeConfig>) {
    if (!selectedNode || !scadaConfig) return;
    const next = { ...scadaConfig, ...patch };
    const scada: Record<string, JsonValue> = {
      tag: next.tag,
      unit: next.unit,
      alarmSeverity: next.alarmSeverity,
    };
    if (next.lowAlarm !== undefined) scada.lowAlarm = next.lowAlarm;
    if (next.highAlarm !== undefined) scada.highAlarm = next.highAlarm;
    dispatch({ type: "node.update", nodeId: selectedNode.id, patch: { properties: { ...selectedNode.properties, scada } } });
  }

  function updateScadaThreshold(field: "lowAlarm" | "highAlarm", value: number | undefined) {
    if (!selectedNode || !scadaConfig) return;
    const scada: Record<string, JsonValue> = {
      tag: scadaConfig.tag,
      unit: scadaConfig.unit,
      alarmSeverity: scadaConfig.alarmSeverity,
    };
    const otherField = field === "lowAlarm" ? "highAlarm" : "lowAlarm";
    const otherValue = scadaConfig[otherField];
    if (otherValue !== undefined) scada[otherField] = otherValue;
    if (value !== undefined) scada[field] = value;
    dispatch({ type: "node.update", nodeId: selectedNode.id, patch: { properties: { ...selectedNode.properties, scada } } });
  }

  function updateEdgeProperties(patch: Record<string, JsonValue>) {
    if (!selectedEdge) return;
    dispatch({ type: "edge.update", edgeId: selectedEdge.id, patch: { properties: { ...selectedEdge.properties, ...patch } } });
  }

  async function acknowledgeAlarm() {
    const alarm = selectedRuntimeState?.alarm;
    if (!selectedNode || !alarm?.active || alarm.acknowledged || !onAcknowledgeAlarm || acknowledgePendingNodeId) return;
    setAcknowledgePendingNodeId(selectedNode.id);
    try {
      await onAcknowledgeAlarm(selectedNode.id, alarm);
      setOperationError(undefined);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setOperationError(message);
      onError?.(message);
    } finally {
      setAcknowledgePendingNodeId(undefined);
    }
  }

  return {
    CANVAS_HEIGHT,
    CANVAS_WIDTH,
    GRID_SIZE,
    NODE_HEIGHT,
    NODE_PRESETS: TOPOLOGY_NODE_PRESETS,
    NODE_WIDTH,
    acknowledgeAlarm,
    acknowledgePendingNodeId,
    activeAlarms,
    addNode,
    alignSelection,
    autoLayout,
    autoSaveEnabled,
    beginDrag,
    binding,
    busy,
    canvasRef,
    connectionSourceId,
    dataProducts,
    dirty,
    dispatch,
    document,
    drag,
    dragPosition,
    duplicateSelection,
    edgeGeometry,
    editor,
    endDrag,
    handleKeyboard,
    locale,
    markerId,
    moveDrag,
    nodeName,
    onAcknowledgeAlarm,
    onAutoSaveChange,
    onChange,
    onClose,
    onInsertDashboard,
    onPublish,
    onSave,
    operationError,
    paletteQuery,
    presetGroups,
    removeSelection,
    runtimeNowMs,
    runtimeStaleAfterMs,
    runtimeStates,
    runtimeSummary,
    scadaConfig,
    selectNode,
    selectTool,
    selectedEdge,
    selectedNode,
    selectedProduct,
    selectedRuntimeAssessment,
    selectedRuntimeState,
    selectedNodeIds,
    selection,
    setBindingProduct,
    setOperationError,
    setPaletteQuery,
    setViewMode,
    tool,
    updateEdgeProperties,
    updateScadaConfig,
    updateScadaThreshold,
    viewMode,
    zoom,
    zoomIn,
    zoomOut,
    resetZoom,
    viewport,
  };
}

function nodeName(document: TopologyDocument, nodeId: string): string {
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  return node ? topologyNodeLabel(node) : nodeId;
}

function snap(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

export type TopologyEditorController = ReturnType<typeof useTopologyEditorController>;

export function TopologyEditorPanel(props: TopologyEditorPanelProps) {
  const controller = useTopologyEditorController(props);
  return <TopologyEditorPanelView controller={controller} />;
}
