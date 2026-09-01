import type { AgentDecision, AgentToolCall, AgentToolResource } from "./types.js";

/** 模型输出永远先收敛为有限决策联合类型，不能把自由文本当作工具指令执行。 */
export function parseAgentDecision(value: unknown): AgentDecision {
  const source = record(value, "决策");
  const kind = text(source.kind, "决策 kind");
  const rationale = boundedText(source.rationale, "决策依据", 2_000);
  if (kind === "call-tool") {
    return { kind, rationale, call: parseToolCall(source.call) };
  }
  if (kind === "finish") {
    const decisionStatus = source.decisionStatus;
    if (!["production", "shadow", "insufficient-data"].includes(String(decisionStatus))) {
      throw new Error("完成决策缺少有效 decisionStatus");
    }
    return {
      kind,
      rationale,
      summary: boundedText(source.summary, "完成摘要", 8_000),
      decisionStatus: decisionStatus as Extract<AgentDecision, { kind: "finish" }>["decisionStatus"],
      evidenceIds: stringArray(source.evidenceIds, "证据 ID", 128),
    };
  }
  if (kind === "stop") {
    return {
      kind,
      rationale,
      code: boundedText(source.code, "停止代码", 100),
      message: boundedText(source.message, "停止原因", 2_000),
    };
  }
  throw new Error(`不支持的 Agent 决策：${kind}`);
}

function parseToolCall(value: unknown): AgentToolCall {
  const source = record(value, "工具调用");
  const argumentsValue = record(source.arguments, "工具参数");
  const resources = Array.isArray(source.resources) ? source.resources : [];
  if (resources.length > 256) throw new Error("工具资源清单超过 256 项");
  return {
    toolId: boundedText(source.toolId, "工具 ID", 200),
    arguments: structuredClone(argumentsValue),
    resources: resources.map(parseResource),
  };
}

function parseResource(value: unknown): AgentToolResource {
  const source = record(value, "工具资源");
  const projectId = optionalText(source.projectId, 200);
  return {
    kind: boundedText(source.kind, "资源类型", 100),
    id: boundedText(source.id, "资源 ID", 300),
    ...(projectId ? { projectId } : {}),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  return value.trim();
}

function boundedText(value: unknown, label: string, limit: number): string {
  const result = text(value, label);
  if (result.length > limit) throw new Error(`${label}超过 ${limit} 字符`);
  return result;
}

function optionalText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, limit);
}

function stringArray(value: unknown, label: string, limit: number): string[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label}必须是不超过 ${limit} 项的数组`);
  return [...new Set(value.map((item) => boundedText(item, label, 300)))];
}
