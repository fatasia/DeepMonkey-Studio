import { AgentRunError } from "./errors.js";
import { requiredText } from "./runValidation.js";
import type { AgentCheckpoint, ResumeAgentRunOptions } from "./types.js";

export const MAX_AGENT_DECISION_RECOVERIES = 3;

export function canRetryAgentDecision(checkpoint: AgentCheckpoint): boolean {
  const failure = checkpoint.failure;
  // 旧 checkpoint 缺少传输分类，仅兼容既有适配器的精确 HTTP 错误，不按任意错误文本猜测。
  const transportFailure = (failure?.code === "decision-provider-unavailable" && failure.phase === "decision")
    || (failure?.code === "invalid-decision" && /^大模型请求失败：HTTP (429|502|503|504)$/.test(failure.message));
  return checkpoint.status === "failed" && failure?.retryable === true && transportFailure
    && !checkpoint.pendingTool && !checkpoint.pendingSelection
    && checkpoint.toolRecords.every(record => record.outcome.status === "completed")
    && checkpoint.decisions.filter(record => record.decision.kind === "call-tool").every(decision => checkpoint.toolRecords.some(record => record.step === decision.step))
    && (checkpoint.decisionRecoveries?.length ?? 0) < MAX_AGENT_DECISION_RECOVERIES
    && checkpoint.usage.steps < checkpoint.budget.maxSteps
    && checkpoint.usage.activeDurationMs < checkpoint.budget.maxDurationMs;
}

/** 只修改等待的输入/失败决策；已执行工具、指纹和预算不可重置。 */
export function prepareAgentRecovery(checkpoint: AgentCheckpoint, options: ResumeAgentRunOptions, now: string): boolean {
  const choosing = checkpoint.status === "awaiting-input";
  const retrying = canRetryAgentDecision(checkpoint);
  if (choosing && !options.selectionId) return false;
  if (!choosing && !retrying) {
    if (options.selectionId) throw new AgentRunError("invalid-state", "当前运行没有等待选择的数据源");
    return false;
  }
  if (options.expectedRevision !== checkpoint.revision) throw new AgentRunError("checkpoint-conflict", "检查点已更新，请刷新后再继续");
  if (options.approval) throw new AgentRunError("invalid-state", "选择或重试不能同时审批工具调用");
  if (choosing) {
    const pending = checkpoint.pendingSelection;
    const option = pending?.options.find(item => item.id === options.selectionId);
    if (!pending || !option) throw new AgentRunError("invalid-input", "请选择当前列出的数据源");
    const selectedBy = requiredText(options.selectedBy ?? "", "选择人", 200);
    (checkpoint.selections ??= []).push({ step: pending.step, option: structuredClone(option), selectedBy, selectedAt: now });
    delete checkpoint.pendingSelection;
  } else {
    if (options.selectionId) throw new AgentRunError("invalid-state", "失败决策不能接收额外数据源选择");
    (checkpoint.decisionRecoveries ??= []).push({ revision: checkpoint.revision, resumedAt: now, failure: { ...checkpoint.failure! } });
    delete checkpoint.failure;
  }
  checkpoint.status = "running";
  return true;
}
