import type { JsonValue, TopologyDocument, TopologyEdge, TopologyNode } from "@bim-studio/contracts";

export type TopologySelection =
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "edge"; readonly id: string };

export interface TopologyDataBindingRef {
  readonly productType: "dataset" | "pipeline";
  readonly productId: string;
  readonly field: string;
}

export interface TopologyNodePatch {
  readonly kind?: string;
  readonly x?: number;
  readonly y?: number;
  readonly properties?: Readonly<Record<string, JsonValue>>;
}

export interface TopologyNodePosition {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
}

export interface TopologyEditorState {
  readonly document: TopologyDocument;
  readonly selection: readonly TopologySelection[];
  readonly undoStack: readonly TopologyDocument[];
  readonly redoStack: readonly TopologyDocument[];
}

export type TopologyEditorAction =
  | { readonly type: "selection.set"; readonly selection: readonly TopologySelection[] }
  | { readonly type: "document.rename"; readonly name: string }
  | { readonly type: "node.add"; readonly node: TopologyNode }
  | { readonly type: "node.update"; readonly nodeId: string; readonly patch: TopologyNodePatch }
  | { readonly type: "node.move"; readonly positions: readonly TopologyNodePosition[] }
  | { readonly type: "node.remove"; readonly nodeIds: readonly string[] }
  | { readonly type: "edge.add"; readonly edge: TopologyEdge }
  | { readonly type: "edge.remove"; readonly edgeIds: readonly string[] }
  | { readonly type: "binding.set"; readonly nodeId: string; readonly binding?: TopologyDataBindingRef }
  | { readonly type: "history.undo" }
  | { readonly type: "history.redo" };

const DATA_BINDING_PROPERTY = "dataBinding";
const HISTORY_LIMIT = 100;

export function createTopologyDocument(id: string, name: string): TopologyDocument {
  assertNonEmpty(id, "拓扑 ID");
  assertNonEmpty(name, "拓扑名称");
  return { id, name, nodes: [], edges: [] };
}

export function createTopologyNode(id: string, kind: string, x: number, y: number, label = kind): TopologyNode {
  assertNonEmpty(id, "节点 ID");
  assertNonEmpty(kind, "节点类型");
  assertFinitePosition(x, y);
  return { id, kind, x, y, properties: { label } };
}

export function createTopologyEdge(id: string, sourceNodeId: string, targetNodeId: string): TopologyEdge {
  assertNonEmpty(id, "连线 ID");
  assertNonEmpty(sourceNodeId, "起点 ID");
  assertNonEmpty(targetNodeId, "终点 ID");
  return { id, sourceNodeId, targetNodeId, properties: {} };
}

export function createTopologyEditorState(document: TopologyDocument): TopologyEditorState {
  assertTopologyDocument(document);
  return { document: cloneDocument(document), selection: [], undoStack: [], redoStack: [] };
}

export function applyTopologyEditorAction(state: TopologyEditorState, action: TopologyEditorAction): TopologyEditorState {
  if (action.type === "selection.set") {
    return { ...state, selection: normalizeSelection(state.document, action.selection) };
  }
  if (action.type === "history.undo") return undoTopologyEdit(state);
  if (action.type === "history.redo") return redoTopologyEdit(state);

  const nextDocument = applyDocumentAction(state.document, action);
  if (nextDocument === state.document) return state;
  return {
    document: nextDocument,
    selection: normalizeSelection(nextDocument, state.selection),
    undoStack: [...state.undoStack.slice(-(HISTORY_LIMIT - 1)), cloneDocument(state.document)],
    redoStack: []
  };
}

export function topologyNodeLabel(node: TopologyNode): string {
  const label = node.properties.label;
  return typeof label === "string" && label.trim() ? label : node.kind;
}

export function topologyNodeDataBinding(node: TopologyNode): TopologyDataBindingRef | undefined {
  const value = node.properties[DATA_BINDING_PROPERTY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const productType = value.productType;
  const productId = value.productId;
  const field = value.field;
  if ((productType !== "dataset" && productType !== "pipeline") || typeof productId !== "string" || !productId.trim() || typeof field !== "string") return undefined;
  return { productType, productId, field };
}

export function canUndoTopologyEdit(state: TopologyEditorState): boolean {
  return state.undoStack.length > 0;
}

export function canRedoTopologyEdit(state: TopologyEditorState): boolean {
  return state.redoStack.length > 0;
}

function applyDocumentAction(document: TopologyDocument, action: Exclude<TopologyEditorAction, { type: "selection.set" | "history.undo" | "history.redo" }>): TopologyDocument {
  switch (action.type) {
    case "document.rename": {
      const name = action.name.trim();
      assertNonEmpty(name, "拓扑名称");
      return name === document.name ? document : { ...document, name };
    }
    case "node.add": {
      assertTopologyNode(action.node);
      if (document.nodes.some((node) => node.id === action.node.id)) throw new Error(`拓扑节点 ${action.node.id} 已存在`);
      return { ...document, nodes: [...document.nodes, cloneNode(action.node)] };
    }
    case "node.update": {
      const current = requireNode(document, action.nodeId);
      const next = patchNode(current, action.patch);
      if (nodesEqual(current, next)) return document;
      return { ...document, nodes: document.nodes.map((node) => node.id === action.nodeId ? next : node) };
    }
    case "node.move": {
      if (action.positions.length === 0) return document;
      const positions = new Map<string, TopologyNodePosition>();
      for (const position of action.positions) {
        requireNode(document, position.nodeId);
        assertFinitePosition(position.x, position.y);
        positions.set(position.nodeId, position);
      }
      const changed = document.nodes.some((node) => {
        const position = positions.get(node.id);
        return position && (position.x !== node.x || position.y !== node.y);
      });
      if (!changed) return document;
      return {
        ...document,
        nodes: document.nodes.map((node) => {
          const position = positions.get(node.id);
          return position ? { ...node, x: position.x, y: position.y } : node;
        })
      };
    }
    case "node.remove": {
      if (action.nodeIds.length === 0) return document;
      const nodeIds = new Set(action.nodeIds);
      for (const nodeId of nodeIds) requireNode(document, nodeId);
      return {
        ...document,
        nodes: document.nodes.filter((node) => !nodeIds.has(node.id)),
        edges: document.edges.filter((edge) => !nodeIds.has(edge.sourceNodeId) && !nodeIds.has(edge.targetNodeId))
      };
    }
    case "edge.add": {
      assertTopologyEdge(document, action.edge);
      if (document.edges.some((edge) => edge.id === action.edge.id)) throw new Error(`拓扑连线 ${action.edge.id} 已存在`);
      if (document.edges.some((edge) => edge.sourceNodeId === action.edge.sourceNodeId && edge.targetNodeId === action.edge.targetNodeId)) {
        throw new Error(`节点 ${action.edge.sourceNodeId} 到 ${action.edge.targetNodeId} 的连线已存在`);
      }
      return { ...document, edges: [...document.edges, cloneEdge(action.edge)] };
    }
    case "edge.remove": {
      if (action.edgeIds.length === 0) return document;
      const edgeIds = new Set(action.edgeIds);
      for (const edgeId of edgeIds) requireEdge(document, edgeId);
      return { ...document, edges: document.edges.filter((edge) => !edgeIds.has(edge.id)) };
    }
    case "binding.set": {
      const node = requireNode(document, action.nodeId);
      const properties = { ...node.properties };
      if (action.binding) {
        assertDataBinding(action.binding);
        properties[DATA_BINDING_PROPERTY] = { ...action.binding };
      } else {
        delete properties[DATA_BINDING_PROPERTY];
      }
      const next = { ...node, properties };
      if (nodesEqual(node, next)) return document;
      return { ...document, nodes: document.nodes.map((candidate) => candidate.id === node.id ? next : candidate) };
    }
  }
}

function undoTopologyEdit(state: TopologyEditorState): TopologyEditorState {
  const previous = state.undoStack.at(-1);
  if (!previous) return state;
  const document = cloneDocument(previous);
  return {
    document,
    selection: normalizeSelection(document, state.selection),
    undoStack: state.undoStack.slice(0, -1),
    redoStack: [...state.redoStack.slice(-(HISTORY_LIMIT - 1)), cloneDocument(state.document)]
  };
}

function redoTopologyEdit(state: TopologyEditorState): TopologyEditorState {
  const next = state.redoStack.at(-1);
  if (!next) return state;
  const document = cloneDocument(next);
  return {
    document,
    selection: normalizeSelection(document, state.selection),
    undoStack: [...state.undoStack.slice(-(HISTORY_LIMIT - 1)), cloneDocument(state.document)],
    redoStack: state.redoStack.slice(0, -1)
  };
}

function normalizeSelection(document: TopologyDocument, selection: readonly TopologySelection[]): TopologySelection[] {
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  const edgeIds = new Set(document.edges.map((edge) => edge.id));
  const seen = new Set<string>();
  return selection.filter((item) => {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return item.kind === "node" ? nodeIds.has(item.id) : edgeIds.has(item.id);
  }).map((item) => ({ ...item }));
}

function patchNode(node: TopologyNode, patch: TopologyNodePatch): TopologyNode {
  const kind = patch.kind === undefined ? node.kind : patch.kind.trim();
  assertNonEmpty(kind, "节点类型");
  const x = patch.x ?? node.x;
  const y = patch.y ?? node.y;
  assertFinitePosition(x, y);
  return {
    ...node,
    kind,
    x,
    y,
    ...(patch.properties ? { properties: structuredClone(patch.properties) as Record<string, JsonValue> } : {})
  };
}

function assertTopologyDocument(document: TopologyDocument): void {
  assertNonEmpty(document.id, "拓扑 ID");
  assertNonEmpty(document.name, "拓扑名称");
  const nodeIds = new Set<string>();
  for (const node of document.nodes) {
    assertTopologyNode(node);
    if (nodeIds.has(node.id)) throw new Error(`拓扑节点 ${node.id} 重复`);
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of document.edges) {
    assertTopologyEdge(document, edge);
    if (edgeIds.has(edge.id)) throw new Error(`拓扑连线 ${edge.id} 重复`);
    edgeIds.add(edge.id);
  }
}

function assertTopologyNode(node: TopologyNode): void {
  assertNonEmpty(node.id, "节点 ID");
  assertNonEmpty(node.kind, "节点类型");
  assertFinitePosition(node.x, node.y);
}

function assertTopologyEdge(document: TopologyDocument, edge: TopologyEdge): void {
  assertNonEmpty(edge.id, "连线 ID");
  if (edge.sourceNodeId === edge.targetNodeId) throw new Error("拓扑连线不能连接节点自身");
  requireNode(document, edge.sourceNodeId);
  requireNode(document, edge.targetNodeId);
}

function assertDataBinding(binding: TopologyDataBindingRef): void {
  if (binding.productType !== "dataset" && binding.productType !== "pipeline") throw new Error("数据产品类型无效");
  assertNonEmpty(binding.productId, "数据产品 ID");
  if (typeof binding.field !== "string") throw new Error("数据字段必须是字符串");
}

function requireNode(document: TopologyDocument, nodeId: string): TopologyNode {
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`拓扑节点 ${nodeId} 不存在`);
  return node;
}

function requireEdge(document: TopologyDocument, edgeId: string): TopologyEdge {
  const edge = document.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) throw new Error(`拓扑连线 ${edgeId} 不存在`);
  return edge;
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label}不能为空`);
}

function assertFinitePosition(x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("节点坐标必须是有限数字");
}

function nodesEqual(left: TopologyNode, right: TopologyNode): boolean {
  return left.id === right.id && left.kind === right.kind && left.x === right.x && left.y === right.y
    && JSON.stringify(left.properties) === JSON.stringify(right.properties);
}

function cloneNode(node: TopologyNode): TopologyNode {
  return { ...node, properties: structuredClone(node.properties) };
}

function cloneEdge(edge: TopologyEdge): TopologyEdge {
  return { ...edge, properties: structuredClone(edge.properties) };
}

function cloneDocument(document: TopologyDocument): TopologyDocument {
  return {
    ...document,
    nodes: document.nodes.map(cloneNode),
    edges: document.edges.map(cloneEdge)
  };
}
