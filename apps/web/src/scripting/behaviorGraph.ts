/**
 * T31 受限行为图:事件→条件→动作(切片一)。
 *
 * 按 Deep 口径**不建通用图编辑器**(主计划排除项);本文件只定义图的数据形态、
 * 结构校验与编译。图是声明式 DAG:
 * - event 节点:受限事件源(场景事件名 / 定时 tick / 数据键变化),只有出边;
 * - condition 节点:受限表达式(restrictedEvaluator 编译),真则放行下游;
 * - action 节点:预定义动作集白名单,必须为叶(禁出边)——分支重入只经
 *   emit-event 动作,由运行时的重入预算控制。
 *
 * 校验规则(全部机器可读 issue,可审计):
 * 1. 规模上限:节点数/边数/表达式长度/嵌套深度;
 * 2. 引用完整:边端点必须存在、无自环、无重复边;
 * 3. 无环:DFS 染色检测;
 * 4. 深度上限:event 起最长路径 ≤ maxDepth;
 * 5. 可达性:每个 condition/action 必须从某 event 可达(孤立节点拒绝);
 * 6. 动作白名单:动作类型、参数格式(颜色/键名/事件名/引擎命令集)、
 *    动作表达式可编译;可选 targetExists 注入校验目标对象存在性。
 */
import {
  compileExpression,
  type CompiledExpression,
  RESTRICTED_EVALUATOR_LIMITS,
} from "./restrictedEvaluator";

/* ---------------------------------- 限制 ---------------------------------- */

export interface BehaviorGraphLimits {
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxDepth: number;
  readonly maxIdLength: number;
  readonly maxEventNameLength: number;
  readonly maxDataKeyLength: number;
  readonly maxTraceMessageLength: number;
  readonly maxEngineCommandParamsJson: number;
}

export const BEHAVIOR_GRAPH_LIMITS: BehaviorGraphLimits = {
  maxNodes: 256,
  maxEdges: 1_024,
  maxDepth: 16,
  maxIdLength: 64,
  maxEventNameLength: 128,
  maxDataKeyLength: 128,
  maxTraceMessageLength: 256,
  maxEngineCommandParamsJson: 4_096,
} as const;

/* ---------------------------------- 类型 ---------------------------------- */

/** 受限事件源:图运行的唯一入口面。 */
export type BehaviorEventSource =
  | { readonly kind: "scene-event"; readonly name: string }
  | { readonly kind: "tick"; readonly intervalMs: number }
  | { readonly kind: "data-change"; readonly key: string };

/** 引擎公开命令白名单(切片一);执行语义由宿主适配器映射到既有引擎通道。 */
export type BehaviorEngineCommandName =
  | "camera.fly-to"
  | "selection.set"
  | "data.apply"
  | "component.update";

/**
 * 预定义动作集(白名单)。与既有 interaction 动作语义对齐
 * (viewerEngineInteraction.runInteractionAction),但以纯结构化命令输出,
 * 求值运行时零 DOM/Three/audio 触碰——执行适配是宿主职责,保证纯度可单测。
 * audio 动作只发命令,不 import T29 音频模块(文件所有权纪律)。
 */
export type BehaviorAction =
  | { readonly type: "set-value"; readonly key: string; readonly expression: string }
  | { readonly type: "emit-event"; readonly name: string; readonly payload?: unknown }
  | { readonly type: "animate"; readonly target?: string; readonly command: "play" | "pause" | "stop" | "toggle" }
  | { readonly type: "set-visibility"; readonly target: string; readonly mode: "show" | "hide" | "toggle" }
  | { readonly type: "set-color"; readonly target: string; readonly color: string }
  | { readonly type: "set-opacity"; readonly target: string; readonly expression: string }
  | { readonly type: "audio"; readonly target?: string; readonly command: "play" | "pause" | "stop" }
  | { readonly type: "trace"; readonly message: string; readonly valueExpression?: string }
  | { readonly type: "engine-command"; readonly command: BehaviorEngineCommandName; readonly params: Record<string, unknown> };

export type BehaviorGraphNode =
  | { readonly id: string; readonly kind: "event"; readonly event: BehaviorEventSource }
  | { readonly id: string; readonly kind: "condition"; readonly expression: string }
  | { readonly id: string; readonly kind: "action"; readonly action: BehaviorAction };

export interface BehaviorGraphEdge {
  readonly from: string;
  readonly to: string;
}

export interface BehaviorGraph {
  readonly id: string;
  readonly name: string;
  readonly nodes: readonly BehaviorGraphNode[];
  readonly edges: readonly BehaviorGraphEdge[];
}

/** 编译产物:条件表达式已解析为 AST,邻接表已建;运行时直接消费,不再触碰源文本。 */
export interface CompiledBehaviorGraph {
  readonly id: string;
  readonly name: string;
  readonly eventNodes: readonly { readonly id: string; readonly event: BehaviorEventSource }[];
  readonly conditionExpressions: ReadonlyMap<string, CompiledExpression>;
  readonly actionNodes: ReadonlyMap<string, BehaviorAction>;
  readonly outgoing: ReadonlyMap<string, readonly string[]>;
  readonly nodeKinds: ReadonlyMap<string, BehaviorGraphNode["kind"]>;
}

export interface BehaviorGraphIssue {
  readonly path: string;
  readonly code: BehaviorGraphIssueCode;
  readonly message: string;
}

export type BehaviorGraphIssueCode =
  | "limit-exceeded"
  | "invalid-id"
  | "duplicate-id"
  | "unknown-node-ref"
  | "self-loop"
  | "duplicate-edge"
  | "cycle"
  | "depth-exceeded"
  | "unreachable"
  | "dead-end"
  | "invalid-action"
  | "invalid-event"
  | "invalid-expression";

export type BehaviorGraphValidation =
  | { readonly valid: true; readonly graph: CompiledBehaviorGraph }
  | { readonly valid: false; readonly issues: readonly BehaviorGraphIssue[] };

/** 可选的目标存在性校验(宿主注入 modelId 解析器;未注入则跳过该检查并在报告口径中说明)。 */
export type BehaviorTargetExists = (target: string) => boolean;

const ID_PATTERN = /^[A-Za-z0-9_.:\-]{1,64}$/;
const NAME_KEY_PATTERN = /^[A-Za-z0-9_.:\-/#]+$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const ENGINE_COMMANDS = new Set<BehaviorEngineCommandName>([
  "camera.fly-to",
  "selection.set",
  "data.apply",
  "component.update",
]);

/* ---------------------------------- 校验 ---------------------------------- */

/**
 * 校验并编译行为图。纯函数:同图同限制 → 同结论。
 * 校验失败返回全部 issue(不是首个),便于一次修复全部问题。
 */
export function validateBehaviorGraph(
  graph: BehaviorGraph,
  options: {
    readonly limits?: Partial<BehaviorGraphLimits>;
    readonly targetExists?: BehaviorTargetExists;
  } = {},
): BehaviorGraphValidation {
  const limits = { ...BEHAVIOR_GRAPH_LIMITS, ...(options.limits ?? {}) } as BehaviorGraphLimits;
  const issues: BehaviorGraphIssue[] = [];
  const push = (issue: BehaviorGraphIssue): void => {
    issues.push(issue);
  };

  if (!graph.id || graph.id.length > limits.maxIdLength || !ID_PATTERN.test(graph.id)) {
    push({ path: "id", code: "invalid-id", message: `图 id 非法(须匹配 ${ID_PATTERN.source} 且 ≤${limits.maxIdLength} 字符)` });
  }
  if (graph.nodes.length > limits.maxNodes) {
    push({ path: "nodes", code: "limit-exceeded", message: `节点数 ${graph.nodes.length} 超过上限 ${limits.maxNodes}` });
  }
  if (graph.edges.length > limits.maxEdges) {
    push({ path: "edges", code: "limit-exceeded", message: `边数 ${graph.edges.length} 超过上限 ${limits.maxEdges}` });
  }

  // id 唯一性与节点内容校验(事件源/动作白名单/表达式可编译)。
  const ids = new Set<string>();
  const conditionExpressions = new Map<string, CompiledExpression>();
  const actionNodes = new Map<string, BehaviorAction>();
  const eventNodes: { id: string; event: BehaviorEventSource }[] = [];
  const nodeKinds = new Map<string, BehaviorGraphNode["kind"]>();
  for (const node of graph.nodes) {
    if (!node.id || node.id.length > limits.maxIdLength || !ID_PATTERN.test(node.id)) {
      push({ path: `nodes[${node.id || "?"}].id`, code: "invalid-id", message: `节点 id 非法(须匹配 ${ID_PATTERN.source})` });
      continue;
    }
    if (ids.has(node.id)) {
      push({ path: `nodes[${node.id}].id`, code: "duplicate-id", message: `节点 id “${node.id}” 重复` });
      continue;
    }
    ids.add(node.id);
    nodeKinds.set(node.id, node.kind);
    if (node.kind === "event") {
      const eventIssue = validateEventSource(node.event, limits);
      if (eventIssue) push({ path: `nodes[${node.id}].event`, code: "invalid-event", message: eventIssue });
      else eventNodes.push({ id: node.id, event: node.event });
    } else if (node.kind === "condition") {
      try {
        conditionExpressions.set(node.id, compileExpression(node.expression));
      } catch (error) {
        push({
          path: `nodes[${node.id}].expression`,
          code: "invalid-expression",
          message: `条件表达式非法:${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } else {
      actionNodes.set(node.id, node.action);
      for (const actionIssue of validateAction(node.action, options.targetExists, limits)) {
        push({ path: `nodes[${node.id}].action`, code: "invalid-action", message: actionIssue });
      }
    }
  }

  // 边校验:端点存在、无自环、无重复。
  const seenEdges = new Set<string>();
  const outgoing = new Map<string, string[]>();
  for (const [index, edge] of graph.edges.entries()) {
    const label = `edges[${index}]`;
    if (!ids.has(edge.from)) {
      push({ path: `${label}.from`, code: "unknown-node-ref", message: `边起点 “${edge.from}” 不存在` });
      continue;
    }
    if (!ids.has(edge.to)) {
      push({ path: `${label}.to`, code: "unknown-node-ref", message: `边终点 “${edge.to}” 不存在` });
      continue;
    }
    if (edge.from === edge.to) {
      push({ path: label, code: "self-loop", message: `节点 “${edge.from}” 存在自环` });
      continue;
    }
    const key = `${edge.from}->${edge.to}`;
    if (seenEdges.has(key)) {
      push({ path: label, code: "duplicate-edge", message: `重复边 ${key}` });
      continue;
    }
    seenEdges.add(key);
    const fromKind = nodeKinds.get(edge.from);
    if (fromKind === "action") {
      push({ path: label, code: "dead-end", message: `动作节点 “${edge.from}” 必须为叶,不允许出边(分支请用 emit-event)` });
      continue;
    }
    const bucket = outgoing.get(edge.from);
    if (bucket) bucket.push(edge.to);
    else outgoing.set(edge.from, [edge.to]);
  }

  if (issues.length > 0) return { valid: false, issues };

  // 无环检测(至此图规模受限、端点完整,DFS 安全)。
  const color = new Map<string, 0 | 1 | 2>();
  const cyclePath: string[] = [];
  const visit = (nodeId: string): boolean => {
    const state = color.get(nodeId) ?? 0;
    if (state === 1) {
      cyclePath.push(nodeId);
      return true;
    }
    if (state === 2) return false;
    color.set(nodeId, 1);
    for (const next of outgoing.get(nodeId) ?? []) {
      if (visit(next)) {
        if (cyclePath[0] !== cyclePath[cyclePath.length - 1]) cyclePath.push(nodeId);
        return true;
      }
    }
    color.set(nodeId, 2);
    return false;
  };
  for (const id of ids) {
    cyclePath.length = 0;
    if (visit(id)) {
      push({
        path: "edges",
        code: "cycle",
        message: `图存在环:${[...cyclePath].reverse().join(" -> ")}`,
      });
      // 存在环时禁止继续深度/可达性计算(后两者只对 DAG 有定义,否则无限递归)。
      return { valid: false, issues };
    }
  }

  // 深度与可达性:event 起最长路径;非 event 节点必须可达。
  const longestFrom = new Map<string, number>();
  const computeDepth = (nodeId: string): number => {
    const cached = longestFrom.get(nodeId);
    if (cached !== undefined) return cached;
    let depth = 0;
    for (const next of outgoing.get(nodeId) ?? []) depth = Math.max(depth, computeDepth(next) + 1);
    longestFrom.set(nodeId, depth);
    return depth;
  };
  const reachable = new Set<string>();
  const walkReachable = (nodeId: string): void => {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    for (const next of outgoing.get(nodeId) ?? []) walkReachable(next);
  };
  let maxDepthSeen = 0;
  for (const event of eventNodes) {
    maxDepthSeen = Math.max(maxDepthSeen, computeDepth(event.id));
    walkReachable(event.id);
  }
  if (maxDepthSeen > limits.maxDepth) {
    push({ path: "edges", code: "depth-exceeded", message: `event 起最长路径 ${maxDepthSeen} 超过上限 ${limits.maxDepth}` });
  }
  for (const [id, kind] of nodeKinds) {
    if (kind === "event") {
      if (!(outgoing.get(id)?.length)) {
        push({ path: `nodes[${id}]`, code: "dead-end", message: `事件节点 “${id}” 没有任何出边(死事件)` });
      }
      continue;
    }
    if (!reachable.has(id)) {
      push({ path: `nodes[${id}]`, code: "unreachable", message: `${kind === "condition" ? "条件" : "动作"}节点 “${id}” 无法从任何事件节点到达` });
    } else if (kind === "condition" && !(outgoing.get(id)?.length)) {
      push({ path: `nodes[${id}]`, code: "dead-end", message: `条件节点 “${id}” 没有任何出边(死分支)` });
    }
  }

  if (issues.length > 0) return { valid: false, issues };

  return {
    valid: true,
    graph: {
      id: graph.id,
      name: graph.name,
      eventNodes,
      conditionExpressions,
      actionNodes,
      outgoing,
      nodeKinds,
    },
  };
}

function validateEventSource(event: BehaviorEventSource, limits: BehaviorGraphLimits): string | undefined {
  if (event.kind === "scene-event") {
    if (!event.name || event.name.length > limits.maxEventNameLength || !NAME_KEY_PATTERN.test(event.name)) {
      return `场景事件名非法(须匹配 ${NAME_KEY_PATTERN.source} 且 ≤${limits.maxEventNameLength} 字符)`;
    }
    return undefined;
  }
  if (event.kind === "tick") {
    if (!Number.isFinite(event.intervalMs) || event.intervalMs < 10 || event.intervalMs > 3_600_000) {
      return "tick 间隔须在 [10, 3600000] 毫秒内";
    }
    return undefined;
  }
  if (!event.key || event.key.length > limits.maxDataKeyLength || !NAME_KEY_PATTERN.test(event.key)) {
    return `数据键非法(须匹配 ${NAME_KEY_PATTERN.source} 且 ≤${limits.maxDataKeyLength} 字符)`;
  }
  return undefined;
}

function validateAction(
  action: BehaviorAction,
  targetExists: BehaviorTargetExists | undefined,
  limits: BehaviorGraphLimits,
): string[] {
  const issues: string[] = [];
  const checkExpression = (expression: string, label: string): void => {
    try {
      compileExpression(expression);
    } catch (error) {
      issues.push(`${label}表达式非法:${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const checkTarget = (target: string | undefined, required: boolean, label: string): void => {
    if (target === undefined) {
      if (required) issues.push(`${label}缺少目标对象`);
      return;
    }
    if (!ID_PATTERN.test(target)) {
      issues.push(`${label}目标 “${target}” 非法(须匹配 ${ID_PATTERN.source})`);
      return;
    }
    if (targetExists && !targetExists(target)) issues.push(`${label}目标 “${target}” 在当前场景中不存在`);
  };
  switch (action.type) {
    case "set-value":
      if (!action.key || action.key.length > limits.maxDataKeyLength || !NAME_KEY_PATTERN.test(action.key)) {
        issues.push(`set-value 键名非法(须匹配 ${NAME_KEY_PATTERN.source})`);
      }
      checkExpression(action.expression, "set-value");
      break;
    case "emit-event":
      if (!action.name || action.name.length > limits.maxEventNameLength || !NAME_KEY_PATTERN.test(action.name)) {
        issues.push(`emit-event 事件名非法(须匹配 ${NAME_KEY_PATTERN.source})`);
      }
      break;
    case "animate":
      checkTarget(action.target, false, "animate");
      break;
    case "set-visibility":
      checkTarget(action.target, true, "set-visibility");
      break;
    case "set-color":
      checkTarget(action.target, true, "set-color");
      if (!COLOR_PATTERN.test(action.color)) issues.push(`set-color 颜色 “${action.color}” 须为 #RRGGBB`);
      break;
    case "set-opacity":
      checkTarget(action.target, true, "set-opacity");
      checkExpression(action.expression, "set-opacity");
      break;
    case "audio":
      checkTarget(action.target, false, "audio");
      break;
    case "trace":
      if (!action.message || action.message.length > limits.maxTraceMessageLength) {
        issues.push(`trace 消息须非空且 ≤${limits.maxTraceMessageLength} 字符`);
      }
      if (action.valueExpression !== undefined) checkExpression(action.valueExpression, "trace");
      break;
    case "engine-command": {
      if (!ENGINE_COMMANDS.has(action.command)) {
        issues.push(`引擎命令 “${action.command}” 不在白名单:${[...ENGINE_COMMANDS].join(", ")}`);
      }
      let serialized = "";
      try {
        serialized = JSON.stringify(action.params) ?? "";
      } catch {
        issues.push("engine-command params 无法序列化");
      }
      if (serialized.length > limits.maxEngineCommandParamsJson) {
        issues.push(`engine-command params 序列化 ${serialized.length} 字符超过上限 ${limits.maxEngineCommandParamsJson}`);
      }
      break;
    }
  }
  return issues;
}

/** 便捷汇总:表达式相关的求值器限制直接继承全局口径(报告口径一致性)。 */
export function behaviorGraphEvaluatorLimits(): typeof RESTRICTED_EVALUATOR_LIMITS {
  return RESTRICTED_EVALUATOR_LIMITS;
}
