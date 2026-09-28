/**
 * G2-S1 只读行为图投影:把 restricted-graph/v1 脚本文本投影为图视图数据。
 *
 * 纪律(设计依据:G级巧架构设计-20260929.md §2.3/§2.5):
 * - 图只是行为 JSON 的第二个视图。真值与仲裁仍是 restrictedInteractionDocument
 *   的解析 + validateBehaviorGraph 校验器;本模块零裁决逻辑,只做
 *   "宽容提取 + dagre 布局 + issue 定位标注",便于非法图也能在图上看到错误。
 * - 本模块不抛异常:任何输入都得到可渲染的投影(parseError / issues / 空图)。
 * - 纯函数:不改入参、不持状态、不触 DOM/React;同输入同输出(可快照)。
 * - 不复制校验规则:parse 失败时展示的是权威解析器的原始 message;
 *   issue 全部原样透传 validateBehaviorGraph 的结论。
 */
import dagre from "@dagrejs/dagre";
import {
  BEHAVIOR_GRAPH_LIMITS,
  validateBehaviorGraph,
  type BehaviorGraph,
  type BehaviorGraphIssue,
} from "../scripting/behaviorGraph";
import { BEHAVIOR_GRAPH_RUNTIME_LIMITS } from "../scripting/behaviorGraphRuntime";
import type { SceneInteractionScriptState } from "@bim-studio/contracts";
import {
  RESTRICTED_GRAPH_PREFIX,
  isRestrictedInteractionScript,
  parseRestrictedInteractionScript,
} from "../scripting/restrictedInteractionDocument";

/** dagre 布局与 React Flow 节点卡共同遵守的固定节点尺寸(确定性布局的前提)。 */
export const BEHAVIOR_GRAPH_NODE_SIZE = { width: 216, height: 64 } as const;

export type ProjectedNodeKind = "event" | "condition" | "action" | "invalid";

export interface ProjectedGraphNode {
  /** React Flow 节点唯一 id;原始 id 重复时第二个起追加 `::dupN`(issue 仍按原始 id 定位到每一处)。 */
  readonly rfId: string;
  /** 原始节点 id(缺失或非法时为 "?"),与校验 issue 的 path `nodes[<id>]` 对应。 */
  readonly id: string;
  readonly kind: ProjectedNodeKind;
  readonly title: string;
  readonly detail: string;
  /** scene-event 事件源的事件名 / emit-event 动作发出的事件名(仅用于回线匹配;其余节点缺省)。 */
  readonly matchKey?: string;
}

export interface ProjectedGraphEdge {
  readonly rfId: string;
  /** 原始 edges 数组下标,与 issue path `edges[<i>]` 对应;合成回线边为 -1。 */
  readonly index: number;
  readonly from: string;
  readonly to: string;
  /** flow = JSON 声明的边;reentry = emit-event→同名 scene-event 的合成回线(仅可视化,重入仍受运行时预算约束)。 */
  readonly kind: "flow" | "reentry";
}

export interface BehaviorGraphProjectionStats {
  readonly eventCount: number;
  readonly conditionCount: number;
  readonly actionCount: number;
  readonly invalidCount: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** event 起最长路径(仅展示口径;合规判定仍归校验器)。 */
  readonly maxDepth: number;
}

/** 预算信息:图规模上限(校验器)与运行时预算(运行时常量,只读透传)。 */
export interface BehaviorGraphBudgets {
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxDepth: number;
  readonly maxStepsPerDispatch: number;
  readonly maxActionsPerDispatch: number;
  readonly maxEventReentryDepth: number;
  readonly maxTickCatchUp: number;
}

export interface BehaviorGraphProjection {
  /** valid = 文档可完整解析(parseRestrictedInteractionScript 通过)。 */
  readonly valid: boolean;
  /** 文档级不可读时的权威解析器原始报错(标记/JSON/schema/规模),原样展示、不转写。 */
  readonly parseError?: string | undefined;
  readonly graphId: string;
  readonly graphName: string;
  readonly nodes: readonly ProjectedGraphNode[];
  /** 仅含两端都可渲染的边;端点缺失的边不进画布,其 issue 落在 edgeIssues 与问题清单。 */
  readonly edges: readonly ProjectedGraphEdge[];
  /** dagre 自上而下布局,键为 rfId,值为节点左上角坐标。 */
  readonly positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  /** validateBehaviorGraph 的权威 issue(原样透传)。 */
  readonly issues: readonly BehaviorGraphIssue[];
  readonly nodeIssues: ReadonlyMap<string, readonly BehaviorGraphIssue[]>;
  readonly edgeIssues: ReadonlyMap<number, readonly BehaviorGraphIssue[]>;
  /** 图级 issue(id/nodes/edges 维度,如 环/超深/规模超限)。 */
  readonly graphIssues: readonly BehaviorGraphIssue[];
  /** 环路节点高亮(从权威 issue message 提取,尽力而为;不影响判定)。 */
  readonly cycleNodeIds: readonly string[];
  readonly stats: BehaviorGraphProjectionStats;
  readonly budgets: BehaviorGraphBudgets;
}

const BUDGETS: BehaviorGraphBudgets = {
  maxNodes: BEHAVIOR_GRAPH_LIMITS.maxNodes,
  maxEdges: BEHAVIOR_GRAPH_LIMITS.maxEdges,
  maxDepth: BEHAVIOR_GRAPH_LIMITS.maxDepth,
  maxStepsPerDispatch: BEHAVIOR_GRAPH_RUNTIME_LIMITS.maxStepsPerDispatch,
  maxActionsPerDispatch: BEHAVIOR_GRAPH_RUNTIME_LIMITS.maxActionsPerDispatch,
  maxEventReentryDepth: BEHAVIOR_GRAPH_RUNTIME_LIMITS.maxEventReentryDepth,
  maxTickCatchUp: BEHAVIOR_GRAPH_RUNTIME_LIMITS.maxTickCatchUp,
} as const;

const NODE_KINDS = new Set(["event", "condition", "action"]);
const DETAIL_MAX = 120;

/** 入口:任意脚本文本 → 可渲染投影(不抛异常)。 */
export function projectBehaviorGraphScript(code: string): BehaviorGraphProjection {
  if (!isRestrictedInteractionScript({ code })) {
    return failureProjection("脚本未声明受限行为图域(缺少 @bim-studio/restricted-graph 标记)");
  }
  // 权威解析先行:成功即拿到已过全量校验的图;失败则复用其原始 message,再做宽容提取供视图定位。
  try {
    const graph = parseRestrictedInteractionScript({ code } as SceneInteractionScriptState);
    return projectValidGraph(graph);
  } catch (cause) {
    const parseError = cause instanceof Error ? cause.message : String(cause);
    return projectLenientGraph(code, parseError);
  }
}

function projectValidGraph(graph: BehaviorGraph): BehaviorGraphProjection {
  const nodes = graph.nodes.map((node) => describeNode(node, new Map()));
  const edges = graph.edges.map((edge, index) => ({
    rfId: `e${index}:${edge.from}->${edge.to}`,
    index,
    from: edge.from,
    to: edge.to,
    kind: "flow" as const,
  }));
  const renderable = filterRenderableEdges(nodes, edges);
  const reentry = collectReentryEdges(nodes);
  return assemble({
    graphId: graph.id,
    graphName: graph.name,
    nodes,
    edges: [...renderable, ...reentry],
    flowEdges: renderable,
    issues: [],
    parseError: undefined,
    originalEdgeCount: graph.edges.length,
  });
}

function projectLenientGraph(code: string, parseError: string): BehaviorGraphProjection {
  const extraction = extractLenient(code);
  const issues = extraction.graphLike ? runValidator(extraction.graphLike) : [];
  return assemble({
    graphId: extraction.graphId,
    graphName: extraction.graphName,
    nodes: extraction.nodes,
    edges: extraction.edges,
    flowEdges: extraction.flowEdges,
    issues,
    parseError,
    originalEdgeCount: extraction.rawEdgeCount,
  });
}

/* ------------------------------ 宽容提取(仅视图) ------------------------------ */

interface LenientExtraction {
  graphId: string;
  graphName: string;
  nodes: ProjectedGraphNode[];
  edges: ProjectedGraphEdge[];
  flowEdges: ProjectedGraphEdge[];
  /** 原始 edges 数组条数(issue path 的 edges[i] 按原始下标定位)。 */
  rawEdgeCount: number;
  /** 结构层可提取时给出宽松形态的图,供权威校验器复跑并回收 issue。 */
  graphLike: BehaviorGraph | undefined;
}

function extractLenient(code: string): LenientExtraction {
  const empty: LenientExtraction = { graphId: "?", graphName: "?", nodes: [], edges: [], flowEdges: [], rawEdgeCount: 0, graphLike: undefined };
  const body = code.startsWith(RESTRICTED_GRAPH_PREFIX) ? code.slice(RESTRICTED_GRAPH_PREFIX.length) : code.trimStart();
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return empty;
  }
  if (!isRecord(document) || document.schemaVersion !== 1 || !isRecord(document.graph)) return empty;
  const graph = document.graph;
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawEdges = Array.isArray(graph.edges) ? graph.edges : [];
  const dupSeen = new Map<string, number>();
  const nodes = rawNodes.map((raw) => describeNode(raw, dupSeen));
  const edges: ProjectedGraphEdge[] = [];
  const flowEdges: ProjectedGraphEdge[] = [];
  rawEdges.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.from !== "string" || typeof raw.to !== "string") return;
    const edge: ProjectedGraphEdge = { rfId: `e${index}:${raw.from}->${raw.to}`, index, from: raw.from, to: raw.to, kind: "flow" };
    edges.push(edge);
    flowEdges.push(edge);
  });
  const renderable = filterRenderableEdges(nodes, flowEdges);
  const reentry = collectReentryEdges(nodes);
  return {
    graphId: typeof graph.id === "string" ? graph.id : "?",
    graphName: typeof graph.name === "string" ? graph.name : "?",
    nodes,
    edges: [...renderable, ...reentry],
    flowEdges: renderable,
    rawEdgeCount: rawEdges.length,
    graphLike: {
      id: typeof graph.id === "string" ? graph.id : "",
      name: typeof graph.name === "string" ? graph.name : "",
      nodes: rawNodes as BehaviorGraph["nodes"],
      edges: rawEdges as BehaviorGraph["edges"],
    },
  };
}

function describeNode(raw: unknown, dupSeen: Map<string, number>): ProjectedGraphNode {
  const record = isRecord(raw) ? raw : {};
  const id = typeof record.id === "string" && record.id ? record.id : "?";
  const occurrences = dupSeen.get(id) ?? 0;
  dupSeen.set(id, occurrences + 1);
  const rfId = occurrences === 0 ? id : `${id}::dup${occurrences}`;
  const kind = NODE_KINDS.has(record.kind as string) ? (record.kind as ProjectedNodeKind) : "invalid";
  if (kind === "invalid") {
    let snippet = "";
    try { snippet = JSON.stringify(raw) ?? ""; } catch { snippet = String(raw); }
    return { rfId, id, kind, title: "未知节点", detail: snippet.slice(0, DETAIL_MAX) };
  }
  if (kind === "event") {
    const event = isRecord(record.event) ? record.event : {};
    if (event.kind === "tick") {
      return { rfId, id, kind, title: "事件 · 定时 tick", detail: `${String(event.intervalMs)}ms` };
    }
    if (event.kind === "data-change") {
      return { rfId, id, kind, title: "事件 · 数据变化", detail: String(event.key ?? "?").slice(0, DETAIL_MAX) };
    }
    const name = typeof event.name === "string" ? event.name : "?";
    return { rfId, id, kind, title: "事件 · 场景事件", detail: name.slice(0, DETAIL_MAX), ...(name !== "?" ? { matchKey: name } : {}) };
  }
  if (kind === "condition") {
    return { rfId, id, kind, title: "条件", detail: String(record.expression ?? "?").slice(0, DETAIL_MAX) };
  }
  const action = isRecord(record.action) ? record.action : {};
  const emitName = action.type === "emit-event" && typeof action.name === "string" ? action.name : undefined;
  return {
    rfId,
    id,
    kind,
    title: `动作 · ${String(action.type ?? "?")}`,
    detail: describeAction(action),
    ...(emitName ? { matchKey: emitName } : {}),
  };
}

function describeAction(action: unknown): string {
  if (!isRecord(action)) return "?";
  const parts: string[] = [];
  for (const key of ["target", "key", "name", "command", "mode", "color", "expression", "message"] as const) {
    const value = action[key];
    if (typeof value === "string" && value) parts.push(value.slice(0, 48));
  }
  return parts.join(" · ").slice(0, DETAIL_MAX) || "(无参数)";
}

function filterRenderableEdges(nodes: readonly ProjectedGraphNode[], edges: readonly ProjectedGraphEdge[]): ProjectedGraphEdge[] {
  const known = new Set(nodes.map((node) => node.rfId));
  return edges.filter((edge) => known.has(edge.from) && known.has(edge.to));
}

/** emit-event 回线(设计 §2.3 要点 2):运行时按同名 scene-event 重入派发,这里仅做可视化。 */
function collectReentryEdges(nodes: readonly ProjectedGraphNode[]): ProjectedGraphEdge[] {
  const eventTargets = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind === "event" && node.matchKey && !eventTargets.has(node.matchKey)) {
      eventTargets.set(node.matchKey, node.rfId);
    }
  }
  const reentry: ProjectedGraphEdge[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== "action" || !node.matchKey) continue;
    const target = eventTargets.get(node.matchKey);
    if (!target || seen.has(`${node.rfId}->${target}`)) continue;
    seen.add(`${node.rfId}->${target}`);
    reentry.push({ rfId: `reentry:${node.rfId}->${target}`, index: -1, from: node.rfId, to: target, kind: "reentry" });
  }
  return reentry;
}

function runValidator(graphLike: BehaviorGraph): BehaviorGraphIssue[] {
  try {
    const result = validateBehaviorGraph(graphLike);
    return result.valid ? [] : [...result.issues];
  } catch {
    // 深度畸形内容可能令权威校验器自身抛错;视图层吞掉并落空 issue(解析错误已在横幅展示)。
    return [];
  }
}

/* ------------------------------ issue 定位 ------------------------------ */

const NODE_PATH = /^nodes\[(.+?)\]/;
const EDGE_PATH = /^edges\[(\d+)\]/;

function locateIssues(issues: readonly BehaviorGraphIssue[], nodeIds: ReadonlySet<string>, edgeCount: number): {
  nodeIssues: Map<string, BehaviorGraphIssue[]>;
  edgeIssues: Map<number, BehaviorGraphIssue[]>;
  graphIssues: BehaviorGraphIssue[];
  cycleNodeIds: string[];
} {
  const nodeIssues = new Map<string, BehaviorGraphIssue[]>();
  const edgeIssues = new Map<number, BehaviorGraphIssue[]>();
  const graphIssues: BehaviorGraphIssue[] = [];
  const cycleNodeIds: string[] = [];
  for (const issue of issues) {
    const nodeMatch = NODE_PATH.exec(issue.path);
    if (nodeMatch?.[1] && nodeIds.has(nodeMatch[1])) {
      pushIssue(nodeIssues, nodeMatch[1], issue);
      continue;
    }
    const edgeMatch = EDGE_PATH.exec(issue.path);
    if (edgeMatch && Number(edgeMatch[1]) < edgeCount) {
      pushIssue(edgeIssues, Number(edgeMatch[1]), issue);
      continue;
    }
    graphIssues.push(issue);
    if (issue.code === "cycle") {
      // message 形如 "图存在环:a -> b -> c"(权威格式,尽力提取用于高亮,不参与判定)。
      const path = issue.message.replace(/^图存在环:/, "");
      for (const segment of path.split(" -> ")) {
        if (nodeIds.has(segment) && !cycleNodeIds.includes(segment)) cycleNodeIds.push(segment);
      }
    }
  }
  return { nodeIssues, edgeIssues, graphIssues, cycleNodeIds };
}

function pushIssue<K>(map: Map<K, BehaviorGraphIssue[]>, key: K, issue: BehaviorGraphIssue): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(issue);
  else map.set(key, [issue]);
}

/* ------------------------------ dagre 布局 ------------------------------ */

/** 自上而下分层布局;同输入同序 → 同坐标(纯确定性,无随机源)。 */
export function layoutBehaviorGraph(
  nodes: readonly ProjectedGraphNode[],
  flowEdges: readonly ProjectedGraphEdge[],
): Map<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 42, ranksep: 68, marginx: 20, marginy: 20 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.rfId, { ...BEHAVIOR_GRAPH_NODE_SIZE });
  for (const edge of flowEdges) graph.setEdge(edge.from, edge.to);
  dagre.layout(graph);
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    const placed = graph.node(node.rfId) as { x?: number; y?: number } | undefined;
    const x = Number.isFinite(placed?.x) ? (placed!.x as number) - BEHAVIOR_GRAPH_NODE_SIZE.width / 2 : 0;
    const y = Number.isFinite(placed?.y) ? (placed!.y as number) - BEHAVIOR_GRAPH_NODE_SIZE.height / 2 : 0;
    positions.set(node.rfId, { x, y });
  }
  return positions;
}

/* ------------------------------ 汇总 ------------------------------ */

function assemble(input: {
  graphId: string;
  graphName: string;
  nodes: ProjectedGraphNode[];
  edges: ProjectedGraphEdge[];
  flowEdges: ProjectedGraphEdge[];
  issues: BehaviorGraphIssue[];
  parseError: string | undefined;
  originalEdgeCount: number;
}): BehaviorGraphProjection {
  const nodeIds = new Set(input.nodes.map((node) => node.id));
  const located = locateIssues(input.issues, nodeIds, input.originalEdgeCount);
  return {
    valid: !input.parseError,
    parseError: input.parseError,
    graphId: input.graphId,
    graphName: input.graphName,
    nodes: input.nodes,
    edges: input.edges,
    positions: layoutBehaviorGraph(input.nodes, input.flowEdges),
    issues: input.issues,
    nodeIssues: located.nodeIssues,
    edgeIssues: located.edgeIssues,
    graphIssues: located.graphIssues,
    cycleNodeIds: located.cycleNodeIds,
    stats: {
      eventCount: input.nodes.filter((node) => node.kind === "event").length,
      conditionCount: input.nodes.filter((node) => node.kind === "condition").length,
      actionCount: input.nodes.filter((node) => node.kind === "action").length,
      invalidCount: input.nodes.filter((node) => node.kind === "invalid").length,
      nodeCount: input.nodes.length,
      edgeCount: input.flowEdges.length,
      maxDepth: computeMaxDepth(input.nodes, input.flowEdges),
    },
    budgets: BUDGETS,
  };
}

function failureProjection(parseError: string): BehaviorGraphProjection {
  return {
    valid: false,
    parseError,
    graphId: "?",
    graphName: "?",
    nodes: [],
    edges: [],
    positions: new Map(),
    issues: [],
    nodeIssues: new Map(),
    edgeIssues: new Map(),
    graphIssues: [],
    cycleNodeIds: [],
    stats: { eventCount: 0, conditionCount: 0, actionCount: 0, invalidCount: 0, nodeCount: 0, edgeCount: 0, maxDepth: 0 },
    budgets: BUDGETS,
  };
}

/** 展示口径的 event 起最长路径;带环守卫(环判定仍归校验器)。 */
function computeMaxDepth(nodes: readonly ProjectedGraphNode[], flowEdges: readonly ProjectedGraphEdge[]): number {
  const outgoing = new Map<string, string[]>();
  for (const edge of flowEdges) {
    const bucket = outgoing.get(edge.from);
    if (bucket) bucket.push(edge.to);
    else outgoing.set(edge.from, [edge.to]);
  }
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const walk = (rfId: string): number => {
    const cached = memo.get(rfId);
    if (cached !== undefined) return cached;
    if (visiting.has(rfId)) return 0; // 环:停止展开(不产出错误结论,判定交给校验器)
    visiting.add(rfId);
    let depth = 0;
    for (const next of outgoing.get(rfId) ?? []) depth = Math.max(depth, walk(next) + 1);
    visiting.delete(rfId);
    memo.set(rfId, depth);
    return depth;
  };
  let max = 0;
  for (const node of nodes) {
    if (node.kind === "event") max = Math.max(max, walk(node.rfId));
  }
  return max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
