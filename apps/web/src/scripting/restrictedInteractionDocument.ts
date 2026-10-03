import type { SceneInteractionScriptState } from "@bim-studio/contracts";
import { validateBehaviorGraph, type BehaviorAction, type BehaviorGraph } from "./behaviorGraph";

/** Persisted in the existing interaction.code field; never interpreted as author JavaScript. */
export const RESTRICTED_GRAPH_PREFIX = "/* @bim-studio/restricted-graph/v1 */\n";
/**
 * 受限域与可信预定义动作互斥的权威措辞(编辑器写回门禁与解析器同源引用,禁止各自转写)。
 * G2 源码写回收口:InteractionEditor 对受限脚本的 actions 写入用同一常量拦截。
 */
export const RESTRICTED_ACTIONS_MIX_MESSAGE = "受限行为图不可混用可信脚本预定义动作，请将动作写入受限图";
const MAX_DOCUMENT_LENGTH = 65_536;
const MAX_JSON_DEPTH = 16;
const ACTION_TYPES = new Set<BehaviorAction["type"]>([
  "set-value", "emit-event", "animate", "set-visibility", "set-color", "set-opacity", "audio", "trace", "engine-command",
]);
const ANIMATION = new Set(["play", "pause", "stop", "toggle"]);
const AUDIO = new Set(["play", "pause", "stop"]);
const VISIBILITY = new Set(["show", "hide", "toggle"]);

export function isRestrictedInteractionScript(script: Pick<SceneInteractionScriptState, "code">): boolean {
  // Reserve the whole restricted-graph namespace: unknown versions and damaged markers may never fall back to author JS.
  return script.code.trimStart().startsWith("/* @bim-studio/restricted-graph/");
}

export function parseRestrictedInteractionScript(script: SceneInteractionScriptState): BehaviorGraph {
  if (!isRestrictedInteractionScript(script)) throw new Error("脚本未声明受限行为图域");
  if (!script.code.startsWith(RESTRICTED_GRAPH_PREFIX)) throw new Error("受限图域标记格式错误：标记后必须换行");
  if (script.code.length > MAX_DOCUMENT_LENGTH) throw new Error(`受限行为图超过 ${MAX_DOCUMENT_LENGTH} 字符上限`);
  if (script.actions?.length) throw new Error(RESTRICTED_ACTIONS_MIX_MESSAGE);
  let document: unknown;
  try {
    document = JSON.parse(script.code.slice(RESTRICTED_GRAPH_PREFIX.length));
  } catch {
    throw new Error("受限行为图 JSON 格式错误；不会回退可信 JS");
  }
  if (!isRecord(document) || !hasKeys(document, ["schemaVersion", "graph"]) || document.schemaVersion !== 1) {
    throw new Error("受限行为图需要 schemaVersion=1 和 graph，且不允许额外顶层字段");
  }
  const stack: { value: unknown; depth: number }[] = [{ value: document, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (depth > MAX_JSON_DEPTH) throw new Error(`受限行为图 JSON 嵌套超过 ${MAX_JSON_DEPTH} 层`);
    if (value && typeof value === "object") {
      if (++nodes > 16_384) throw new Error("受限行为图 JSON 节点数量超限");
      for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
    }
  }
  const graph = document.graph;
  if (!isRecord(graph) || !hasKeys(graph, ["id", "name", "nodes", "edges"]) ||
    typeof graph.id !== "string" || typeof graph.name !== "string" ||
    !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length > 256 || graph.edges.length > 1024) {
    throw new Error("受限行为图结构或节点/边数量非法");
  }
  for (const node of graph.nodes) {
    if (!isRecord(node) || typeof node.id !== "string" ||
      (node.kind === "event" ? !hasKeys(node, ["id", "kind", "event"]) || !validEvent(node.event)
        : node.kind === "condition" ? !hasKeys(node, ["id", "kind", "expression"]) || typeof node.expression !== "string"
          : node.kind === "action" ? !hasKeys(node, ["id", "kind", "action"]) || !validAction(node.action)
            : true)) throw new Error(`受限行为图节点结构非法或动作不在白名单：${node.id ?? "?"}`);
  }
  if (graph.edges.some((edge: unknown) => !isRecord(edge) || !hasKeys(edge, ["from", "to"]) ||
    typeof edge.from !== "string" || typeof edge.to !== "string")) throw new Error("受限行为图边结构非法");
  const validated = validateBehaviorGraph(graph as unknown as BehaviorGraph);
  if (!validated.valid) throw new Error(`受限行为图校验失败：${validated.issues.map((issue) => issue.message).join("；")}`);
  return graph as unknown as BehaviorGraph;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function validEvent(event: unknown): boolean {
  return isRecord(event) && (
    event.kind === "tick" ? hasKeys(event, ["kind", "intervalMs"]) && typeof event.intervalMs === "number" :
      event.kind === "scene-event" ? hasKeys(event, ["kind", "name"]) && typeof event.name === "string" :
        event.kind === "data-change" && hasKeys(event, ["kind", "key"]) && typeof event.key === "string"
  );
}
function validAction(action: unknown): boolean {
  if (!isRecord(action) || !ACTION_TYPES.has(action.type as BehaviorAction["type"])) return false;
  const str = (key: string) => typeof action[key] === "string";
  const optionalStr = (key: string) => action[key] === undefined || str(key);
  switch (action.type) {
    case "set-value": return hasKeys(action, ["type", "key", "expression"]) && str("key") && str("expression");
    case "emit-event": return (hasKeys(action, ["type", "name"]) || hasKeys(action, ["type", "name", "payload"])) && str("name");
    case "animate": return (hasKeys(action, ["type", "command"]) || hasKeys(action, ["type", "command", "target"])) && ANIMATION.has(action.command as string) && optionalStr("target");
    case "set-visibility": return hasKeys(action, ["type", "target", "mode"]) && str("target") && VISIBILITY.has(action.mode as string);
    case "set-color": return hasKeys(action, ["type", "target", "color"]) && str("target") && str("color");
    case "set-opacity": return hasKeys(action, ["type", "target", "expression"]) && str("target") && str("expression");
    case "audio": return (hasKeys(action, ["type", "command"]) || hasKeys(action, ["type", "command", "target"])) && AUDIO.has(action.command as string) && optionalStr("target");
    case "trace": return (hasKeys(action, ["type", "message"]) || hasKeys(action, ["type", "message", "valueExpression"])) && str("message") && optionalStr("valueExpression");
    case "engine-command": return hasKeys(action, ["type", "command", "params"]) && str("command") && isRecord(action.params);
    default: return false;
  }
}
