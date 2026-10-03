/**
 * G2-S2a 行为图草案变换层(最小可用编辑回路的纯函数核心)。
 *
 * 纪律(G2 设计稿 §2.2/§2.5,与 G2-S1 投影模块同一纪律的反向):
 * - 文档唯一真值仍是 restricted-graph/v1 的 `interaction.code`;本模块的全部变换都是
 *   "文档进文档出"的纯函数:不改入参、不持状态、同输入同输出(可快照)。
 * - 节点坐标不入文档(parse 严格 hasKeys 不允许额外字段),坐标是编辑器会话态。
 * - 不复制校验规则:合法性判断只复用 validateBehaviorGraph 的规则语义;连线时的
 *   端型/自环/重边/环即时反馈与校验器结论同源同措辞,仲裁仍归保存门禁
 *   parseRestrictedInteractionScript(权威,唯一落库通道)。
 * - 表达式即时校验透传 restrictedEvaluator 的 RestrictedExpressionSyntaxError
 *   (含词法偏移),本模块只补 行/列 换算,不转写错误语义。
 */
import type { SceneInteractionScriptState } from "@bim-studio/contracts";
import {
  RESTRICTED_GRAPH_PREFIX,
  parseRestrictedInteractionScript,
} from "../scripting/restrictedInteractionDocument";
import { compileExpression, RestrictedExpressionSyntaxError } from "../scripting/restrictedEvaluator";
import type { BehaviorAction, BehaviorGraph, BehaviorGraphNode } from "../scripting/behaviorGraph";

/** 画布网格(拖入落点与节点移动共同吸附的粒度)。 */
export const BEHAVIOR_GRID_SIZE = 20;

/** 节点 id 规则与校验器 ID_PATTERN 同源(展示口径;权威判定仍归校验器)。 */
export const BEHAVIOR_ID_HINT = "字母/数字/_.:-,≤64 字符";
const ID_PATTERN = /^[A-Za-z0-9_.:\-]{1,64}$/;

/* --------------------------------- 调色板 --------------------------------- */

/** 调色板条目:3 事件源 + 1 条件 + 9 动作(T31 白名单全集,零新增语义)。 */
export interface BehaviorPaletteEntry {
  readonly id: string;
  readonly group: "event" | "condition" | "action";
  readonly labelZh: string;
  readonly labelEn: string;
}

export const BEHAVIOR_PALETTE: readonly BehaviorPaletteEntry[] = [
  { id: "scene-event", group: "event", labelZh: "场景事件", labelEn: "Scene event" },
  { id: "tick", group: "event", labelZh: "定时 tick", labelEn: "Timer tick" },
  { id: "data-change", group: "event", labelZh: "数据变化", labelEn: "Data change" },
  { id: "condition", group: "condition", labelZh: "条件", labelEn: "Condition" },
  { id: "set-value", group: "action", labelZh: "写入数据", labelEn: "Set value" },
  { id: "emit-event", group: "action", labelZh: "发出事件", labelEn: "Emit event" },
  { id: "animate", group: "action", labelZh: "播放动画", labelEn: "Animate" },
  { id: "set-visibility", group: "action", labelZh: "显示隐藏", labelEn: "Visibility" },
  { id: "set-color", group: "action", labelZh: "填色", labelEn: "Set color" },
  { id: "set-opacity", group: "action", labelZh: "透明度", labelEn: "Set opacity" },
  { id: "audio", group: "action", labelZh: "音频控制", labelEn: "Audio" },
  { id: "trace", group: "action", labelZh: "调试输出", labelEn: "Trace" },
  { id: "engine-command", group: "action", labelZh: "引擎命令", labelEn: "Engine command" },
] as const;

const PALETTE_BY_ID = new Map(BEHAVIOR_PALETTE.map((entry) => [entry.id, entry]));

/** 引擎命令白名单展示序(与 T31 白名单一致,仅展示顺序)。 */
export const ENGINE_COMMAND_OPTIONS = ["camera.fly-to", "selection.set", "data.apply", "component.update"] as const;

/* ------------------------------- 草案数据形态 ------------------------------- */

/**
 * 草案节点:与权威结构同形,但容忍畸形字段(用户 JSON 手编中途态)。
 * 变换永不"修复"或丢弃畸形内容——修复手段是表单/源码,仲裁归校验器。
 */
export interface DraftNode {
  readonly id: string;
  readonly kind: string;
  readonly event?: Record<string, unknown>;
  readonly expression?: string;
  readonly action?: Record<string, unknown>;
}

export interface DraftGraph {
  readonly id: string;
  readonly name: string;
  readonly nodes: readonly DraftNode[];
  readonly edges: readonly { from: string; to: string }[];
}

export interface DraftParse {
  readonly graph: DraftGraph | undefined;
  /** 结构不可读时的权威口径 message(与 restrictedInteractionDocument 措辞一致)。 */
  readonly parseError: string | undefined;
}

export function emptyBehaviorGraph(): BehaviorGraph {
  return { id: "behavior-graph", name: "行为图", nodes: [], edges: [] };
}

/** 宽容结构解析:只保证"可变换"的最小形状;内容对错仍归校验器。 */
export function parseDraftGraph(text: string): DraftParse {
  const body = text.startsWith(RESTRICTED_GRAPH_PREFIX) ? text.slice(RESTRICTED_GRAPH_PREFIX.length) : text.trimStart();
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return { graph: undefined, parseError: "受限行为图 JSON 格式错误；不会回退可信 JS" };
  }
  if (!isRecord(document) || document.schemaVersion !== 1 || !isRecord(document.graph)) {
    return { graph: undefined, parseError: "受限行为图需要 schemaVersion=1 和 graph" };
  }
  const graph = document.graph;
  if (typeof graph.id !== "string" || typeof graph.name !== "string" || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return { graph: undefined, parseError: "受限行为图结构或节点/边数量非法" };
  }
  const nodes = graph.nodes.map(asDraftNode);
  const edges = graph.edges.flatMap((edge) => (isRecord(edge) && typeof edge.from === "string" && typeof edge.to === "string" ? [{ from: edge.from, to: edge.to }] : []));
  return { graph: { id: graph.id, name: graph.name, nodes, edges }, parseError: undefined };
}

function asDraftNode(raw: unknown): DraftNode {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.kind !== "string") {
    return { id: "?", kind: "invalid" };
  }
  const node: { id: string; kind: string; event?: Record<string, unknown>; expression?: string; action?: Record<string, unknown> } = { id: raw.id, kind: raw.kind };
  if (isRecord(raw.event)) node.event = raw.event;
  if (typeof raw.expression === "string") node.expression = raw.expression;
  if (isRecord(raw.action)) node.action = raw.action;
  return node;
}

/** 确定性序列化:固定键序 + 2 空格缩进;前缀与解析器要求逐字节一致。 */
export function serializeBehaviorGraph(graph: DraftGraph): string {
  const nodes = graph.nodes.map((node) => {
    const record: Record<string, unknown> = { id: node.id, kind: node.kind };
    if (node.event !== undefined) record.event = node.event;
    if (node.expression !== undefined) record.expression = node.expression;
    if (node.action !== undefined) record.action = node.action;
    return record;
  });
  return RESTRICTED_GRAPH_PREFIX + JSON.stringify({ schemaVersion: 1, graph: { id: graph.id, name: graph.name, nodes, edges: graph.edges } }, null, 2);
}

/* ------------------------------- 节点变换 ------------------------------- */

/** 确定性 id:`<base>-<n>`,n 自 1 起取最小未占用值(同文档同结果)。 */
export function nextNodeId(graph: DraftGraph, base: string): string {
  const used = new Set(graph.nodes.map((node) => node.id));
  for (let n = 1; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** 调色板条目 → 默认节点(默认值全部可通过权威校验器的字段级规则,除"待接线"类拓扑项)。 */
export function createNodeForEntry(entryId: string, nodeId: string, graph: DraftGraph): DraftNode | undefined {
  if (!PALETTE_BY_ID.has(entryId)) return undefined;
  const eventBase = nextEventNameBase(graph);
  switch (entryId) {
    case "scene-event":
      return { id: nodeId, kind: "event", event: { kind: "scene-event", name: `${eventBase}` } };
    case "tick":
      return { id: nodeId, kind: "event", event: { kind: "tick", intervalMs: 1_000 } };
    case "data-change":
      return { id: nodeId, kind: "event", event: { kind: "data-change", key: "value" } };
    case "condition":
      return { id: nodeId, kind: "condition", expression: "true" };
    case "set-value":
      return { id: nodeId, kind: "action", action: { type: "set-value", key: "value", expression: "0" } };
    case "emit-event":
      return { id: nodeId, kind: "action", action: { type: "emit-event", name: `${eventBase}` } };
    case "animate":
      return { id: nodeId, kind: "action", action: { type: "animate", command: "play" } };
    case "set-visibility":
      return { id: nodeId, kind: "action", action: { type: "set-visibility", target: "", mode: "toggle" } };
    case "set-color":
      return { id: nodeId, kind: "action", action: { type: "set-color", target: "", color: "#ff4057" } };
    case "set-opacity":
      return { id: nodeId, kind: "action", action: { type: "set-opacity", target: "", expression: "1" } };
    case "audio":
      return { id: nodeId, kind: "action", action: { type: "audio", command: "play" } };
    case "trace":
      return { id: nodeId, kind: "action", action: { type: "trace", message: "触发" } };
    case "engine-command":
      return { id: nodeId, kind: "action", action: { type: "engine-command", command: "camera.fly-to", params: {} } };
    default:
      return undefined;
  }
}

/** 事件名系列(场景事件默认名与 emit-event 默认名共用,便于一回线联动的开箱体验)。 */
function nextEventNameBase(graph: DraftGraph): string {
  const used = new Set<string>();
  for (const node of graph.nodes) {
    if (node.event?.kind === "scene-event" && typeof node.event.name === "string") used.add(node.event.name);
    if (node.action?.type === "emit-event" && typeof node.action.name === "string") used.add(node.action.name);
  }
  for (let n = 1; ; n += 1) {
    const candidate = `event-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export interface AddNodeResult {
  readonly graph: DraftGraph;
  readonly nodeId: string | undefined;
}

/** 添加节点:超规模上限时拒绝(返回原图,理由由校验器 issue 呈现)。 */
export function addDraftNode(graph: DraftGraph, entryId: string, maxNodes = 256): AddNodeResult {
  if (graph.nodes.length >= maxNodes) return { graph, nodeId: undefined };
  const base = PALETTE_BY_ID.get(entryId)?.id ?? entryId;
  const nodeId = nextNodeId(graph, base);
  const node = createNodeForEntry(entryId, nodeId, graph);
  if (!node) return { graph, nodeId: undefined };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, nodeId };
}

/** 删除节点并级联清理关联边(纯函数,不触碰无关节点)。 */
export function removeDraftNodes(graph: DraftGraph, ids: readonly string[]): DraftGraph {
  const removed = new Set(ids);
  if (removed.size === 0) return graph;
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => !removed.has(node.id)),
    edges: graph.edges.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to)),
  };
}

/** 替换单个节点(表单提交路径;id 不可变,改 id 走删+建)。 */
export function replaceDraftNode(graph: DraftGraph, id: string, node: DraftNode): DraftGraph {
  if (!graph.nodes.some((existing) => existing.id === id)) return graph;
  return { ...graph, nodes: graph.nodes.map((existing) => (existing.id === id ? node : existing)) };
}

export function removeDraftEdge(graph: DraftGraph, index: number): DraftGraph {
  if (index < 0 || index >= graph.edges.length) return graph;
  return { ...graph, edges: graph.edges.filter((_, i) => i !== index) };
}

/* ------------------------------- 连线合法性 ------------------------------- */

/**
 * 连线合法性(与 T31 校验器规则同源同措辞):
 * - 端型:event/condition 只有出边能力、condition/action 只有入边能力(端口可见性已在
 *   画布层保证);本函数兜底校验 from 不能是 action(动作必须为叶)。
 * - 自环、重复边、成环:逐一给出可读理由(即连线拖拽的红色反馈文案)。
 * 返回 undefined = 合法;字符串 = 非法理由。
 */
export function connectIllegalReason(graph: DraftGraph, from: string, to: string): string | undefined {
  if (from === to) return "不能连接节点自身(自环)";
  const fromNode = graph.nodes.find((node) => node.id === from);
  const toNode = graph.nodes.find((node) => node.id === to);
  if (!fromNode || !toNode) return "端点不存在";
  if (fromNode.kind === "action") return "动作节点必须为叶,不允许出边(分支请用 emit-event)";
  if (toNode.kind === "event") return "事件节点是图的入口,不接受入边";
  if (graph.edges.some((edge) => edge.from === from && edge.to === to)) return "两条节点之间已存在连线(重复边)";
  if (wouldCreateCycle(graph, from, to)) return "该连线会构成环;分支重入请使用 emit-event 回线";
  return undefined;
}

/** 从 to 沿出边可达 from,则 from→to 成环(to 自身也计数,自环由调用方先行拦截)。 */
export function wouldCreateCycle(graph: DraftGraph, from: string, to: string): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const bucket = outgoing.get(edge.from);
    if (bucket) bucket.push(edge.to);
    else outgoing.set(edge.from, [edge.to]);
  }
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const current = stack.pop()!;
    if (current === from) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of outgoing.get(current) ?? []) stack.push(next);
  }
  return false;
}

export type ConnectResult = { readonly ok: true; readonly graph: DraftGraph } | { readonly ok: false; readonly reason: string };

export function connectDraftEdge(graph: DraftGraph, from: string, to: string): ConnectResult {
  const reason = connectIllegalReason(graph, from, to);
  if (reason) return { ok: false, reason };
  return { ok: true, graph: { ...graph, edges: [...graph.edges, { from, to }] } };
}

/* --------------------------------- 门禁 --------------------------------- */

export type GraphGateResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * 保存门禁:受限域文本落库前的唯一权威通道(与运行时 Play 预校验同一解析器)。
 * 非法文档 0 条落库——调用方收到 ok=false 时必须保留草案、不得触碰真值。
 */
export function gateBehaviorGraphCode(code: string): GraphGateResult {
  try {
    parseRestrictedInteractionScript({ code } as SceneInteractionScriptState);
    return { ok: true };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * InteractionEditor 直写守卫(修复 G2-S1 已知洞:受限图源码可绕过校验落库)。
 * - 结果不是受限域(可信 JS 模板)→ 放行,可信通道一字不动;
 * - 结果在受限域 → 必须过 parseRestrictedInteractionScript,失败返回权威 message。
 */
export function guardRestrictedCodeWrite(nextCode: string): string | undefined {
  if (!nextCode.trimStart().startsWith("/* @bim-studio/restricted-graph/")) return undefined;
  const gate = gateBehaviorGraphCode(nextCode);
  return gate.ok ? undefined : gate.message;
}

/* ------------------------------- 表达式定位 ------------------------------- */

export interface ExpressionIssue {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

/** 表达式即时校验:词法/语法错误透传求值器 message,并换算 1 基 行/列。 */
export function expressionIssueOf(expression: string): ExpressionIssue | undefined {
  if (!expression.trim()) return undefined;
  try {
    compileExpression(expression);
    return undefined;
  } catch (cause) {
    if (!(cause instanceof RestrictedExpressionSyntaxError)) {
      return { message: cause instanceof Error ? cause.message : String(cause), line: 1, column: 1 };
    }
    const before = expression.slice(0, Math.min(cause.offset, expression.length));
    const line = before.split("\n").length;
    const column = before.length - (before.lastIndexOf("\n") + 1) + 1;
    return { message: cause.message, line, column };
  }
}

/** 求值器 message 自带"(偏移 N)";表单已用 行/列 定位,展示时剥掉重复定位段。 */
export function formatExpressionMessage(message: string): string {
  return message.replace(/\(偏移 \d+\)$/, "");
}

/* ------------------------------- 坐标与吸附 ------------------------------- */

export interface GridPoint {
  x: number;
  y: number;
}

/** 吸附到画布网格(拖入落点/新增节点共用;负坐标合法,画布无限)。 */
export function snapToGrid(point: GridPoint, grid = BEHAVIOR_GRID_SIZE): GridPoint {
  return { x: Math.round(point.x / grid) * grid, y: Math.round(point.y / grid) * grid };
}

/** 点击新增(无拖拽落点)时的确定性槽位:按现有节点数列优先铺开,同输入同位置。 */
export function defaultNodePosition(graph: DraftGraph): GridPoint {
  const columnSize = 5;
  const index = graph.nodes.length;
  return snapToGrid({ x: 40 + Math.floor(index / columnSize) * 300, y: 40 + (index % columnSize) * 130 });
}

/* ------------------------------- 参数助手 ------------------------------- */

/** engine-command params 的 JSON 预检(序列化面校验,非校验器规则复制)。 */
export function parseParamsJson(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return { ok: false, message: "params 必须是 JSON 对象" };
    return { ok: true, value };
  } catch {
    return { ok: false, message: "params 不是合法 JSON" };
  }
}

/** 草案节点 → 权威形态(供类型收窄的只读展示;畸形节点返回 undefined)。 */
export function asBehaviorNode(node: DraftNode): BehaviorGraphNode | undefined {
  if (node.kind !== "event" && node.kind !== "condition" && node.kind !== "action") return undefined;
  if (node.kind === "condition") {
    return typeof node.expression === "string" ? { id: node.id, kind: "condition", expression: node.expression } : undefined;
  }
  if (!isRecord(node.event) && !isRecord(node.action)) return undefined;
  return node as unknown as BehaviorGraphNode;
}

export function asBehaviorAction(action: Record<string, unknown> | undefined): BehaviorAction | undefined {
  return isRecord(action) ? (action as unknown as BehaviorAction) : undefined;
}

/**
 * 动作字段的严格键集补丁:受限文档节点键集是精确 hasKeys,可选键在"空值"时必须
 * 整键移除而不是写空串/undefined,否则文档级解析直接失败(比校验 issue 更糟)。
 * - animate/audio 的 target 是可选键:空串 → 移除;
 * - set-visibility/set-color/set-opacity 的 target 是必需键:保留空串,由校验器
 *   以 "缺少目标对象/目标非法" 引导补全(表单受控回显空串);
 * - trace.valueExpression / emit-event.payload:undefined → 移除。
 */
export function asDraftActionPatch(action: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const optionalTarget = action.type === "animate" || action.type === "audio";
  const next: Record<string, unknown> = { ...action };
  for (const [key, value] of Object.entries(patch)) {
    const optionalKey = (key === "target" && optionalTarget) || key === "valueExpression" || key === "payload";
    if (optionalKey && (value === undefined || value === "")) delete next[key];
    else next[key] = value;
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 新建受限图脚本 code(InteractionEditor「新建行为图」入口;空图合法可保存)。 */
export function newRestrictedGraphCode(): string {
  return serializeBehaviorGraph(emptyBehaviorGraph());
}
