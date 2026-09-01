import { AgentRunError } from "./errors.js";
import type { AgentApproval, AgentBudget, AgentToolDefinition } from "./types.js";

const DEFAULT_BUDGET: AgentBudget = { maxSteps: 8, maxDurationMs: 120_000, maxToolCalls: 6 };

/** 统一收敛运行输入，避免 API、恢复流程与内核形成不同预算边界。 */
export function normalizeBudget(input: Partial<AgentBudget> | undefined): AgentBudget {
  return {
    maxSteps: boundedInteger(input?.maxSteps, DEFAULT_BUDGET.maxSteps, 1, 64, "最大步骤数"),
    maxDurationMs: boundedInteger(input?.maxDurationMs, DEFAULT_BUDGET.maxDurationMs, 1_000, 15 * 60_000, "时间预算"),
    maxToolCalls: boundedInteger(input?.maxToolCalls, DEFAULT_BUDGET.maxToolCalls, 0, 64, "工具预算"),
  };
}

export function normalizeAllowedTools(input: string[], available: AgentToolDefinition[]): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) throw new AgentRunError("invalid-input", "至少选择一个且最多选择 64 个 Agent 工具");
  const availableIds = new Set(available.map((tool) => tool.id));
  const normalized = [...new Set(input.map((id) => requiredText(id, "工具 ID", 200)))];
  const unknown = normalized.filter((id) => !availableIds.has(id));
  if (unknown.length) throw new AgentRunError("invalid-input", `Agent 工具不存在：${unknown.join(", ")}`);
  return normalized;
}

export function normalizeApproval(value: AgentApproval): AgentApproval {
  const approvedAt = new Date(value.approvedAt);
  if (!Number.isFinite(approvedAt.getTime())) throw new AgentRunError("invalid-input", "审批时间无效");
  return {
    approvedBy: requiredText(value.approvedBy, "审批人", 200),
    approvedAt: approvedAt.toISOString(),
    scopeFingerprint: requiredText(value.scopeFingerprint, "审批范围指纹", 200),
  };
}

export function requiredText(value: string, label: string, limit: number): string {
  const result = value?.trim();
  if (!result) throw new AgentRunError("invalid-input", `${label}不能为空`);
  if (result.length > limit) throw new AgentRunError("invalid-input", `${label}超过 ${limit} 字符`);
  return result;
}

export function safeClone(value: unknown): unknown {
  try { return structuredClone(value); }
  catch { throw new AgentRunError("invalid-input", "Agent 上下文必须可安全序列化"); }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new AgentRunError("invalid-input", `${label}必须在 ${min} 至 ${max} 之间`);
  return result;
}
