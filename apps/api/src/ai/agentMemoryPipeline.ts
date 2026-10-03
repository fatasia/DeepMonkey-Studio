import type { AgentCheckpoint } from "@bim-studio/industrial-agent-orchestrator";
import { createAiAuditEvent, emitAiAudit, safeErrorMessage, type AiReliabilityAuditSink } from "./aiReliabilityAudit.js";
import {
  AGENT_LESSON_INJECTION_MAX_COUNT,
  type AgentLesson,
  type AgentMemoryStore,
  type AgentRunArchive,
} from "./agentMemory.js";

/**
 * H-C6-S2 专家日志三段流水线（归档 → 提炼 → 回灌）的归档/提炼半程：
 * 挂在 orchestrator 的受控终态通知（onRunSettled）上，run 收口时——
 * ① 归档：终态 checkpoint 摘要（runId/状态/用量/工具域）落 agentMemory runs 段；
 * ② 提炼：确定性规则把失败/受阻/回灌缺口提炼为结构化 lesson（输入截断 + 条数预算 +
 *    可取消），落 lessons 段；
 * ③ 回灌：由 AgentMemoryStore.loadDelivery 在下轮 decide 注入（域匹配 + 条数预算），
 *    见 agentMemory.ts——本模块不负责注入。
 *
 * 失败纪律（H-C5-K8 口径）：归档/提炼任一步失败都落专项审计 finding（可重试），
 * 绝不静默吞掉，也绝不改变 run 终态；提炼是确定性本地规则，无 LLM 依赖。
 */

/** 单轮提炼条数上限；注入侧另有 AGENT_LESSON_INJECTION_MAX_COUNT 二级预算。 */
export const AGENT_DISTILL_MAX_LESSONS = AGENT_LESSON_INJECTION_MAX_COUNT;
/** 提炼输入预算：失败理由/摘要的字符截断上限（证据最小化，不复制输出原文）。 */
export const AGENT_DISTILL_INPUT_MAX_CHARS = 400;

export interface DistillOptions {
  maxLessons?: number;
  /** 取消提炼：已中止的信号下不产出（取消是流程保护，不是故障）。 */
  signal?: AbortSignal;
}

export function createAgentMemoryPipeline(dependencies: {
  memory: AgentMemoryStore;
  audit?: AiReliabilityAuditSink;
  now?: () => Date;
}): { onRunSettled: (checkpoint: AgentCheckpoint) => Promise<void> } {
  async function onRunSettled(checkpoint: AgentCheckpoint): Promise<void> {
    // ① 归档：失败落审计 finding 后终止（提炼依赖归档语境，且 run 终态不得被改变）。
    try {
      await dependencies.memory.archiveRun(checkpoint.projectId, runArchiveInput(checkpoint));
    } catch (error) {
      await emitSettleFailure(dependencies.audit, checkpoint, "run-archive-failed", error);
      return;
    }
    // ② 提炼：无教训（正常完成/被取消）是正常路径，零写入零审计。
    const lessons = distillLessonsFromCheckpoint(checkpoint, { maxLessons: AGENT_DISTILL_MAX_LESSONS });
    if (!lessons.length) return;
    // ③ 落档：失败落审计 finding，不影响已完成的归档。
    try {
      await dependencies.memory.replaceLessons(checkpoint.projectId, checkpoint.id, lessons);
    } catch (error) {
      await emitSettleFailure(dependencies.audit, checkpoint, "lesson-store-failed", error);
    }
  }
  return { onRunSettled };
}

/** 终态 checkpoint → 归档条目：只存状态码/理由/用量/工具域，不存决策与输出原文。 */
export function runArchiveInput(checkpoint: AgentCheckpoint): Omit<AgentRunArchive, "objective" | "outcomeSummary"> & { objective: string; outcomeSummary: string } {
  return {
    runId: checkpoint.id,
    status: terminalStatus(checkpoint.status),
    objective: checkpoint.objective,
    outcomeSummary: runOutcomeSummary(checkpoint).slice(0, AGENT_DISTILL_INPUT_MAX_CHARS),
    ...(checkpoint.failure?.code ? { failureCode: checkpoint.failure.code } : {}),
    steps: checkpoint.usage.steps,
    toolCalls: checkpoint.usage.toolCalls,
    toolIds: runToolDomains(checkpoint),
    endedAt: checkpoint.updatedAt,
  };
}

const ARCHIVE_STATUSES = ["completed", "blocked", "failed", "cancelled", "budget-exhausted"] as const;

/** 归档只收终态：onRunSettled 由 orchestrator 在 terminal() 时触发，此处防御非终态误投。 */
function terminalStatus(status: AgentCheckpoint["status"]): (typeof ARCHIVE_STATUSES)[number] {
  switch (status) {
    case "completed":
    case "blocked":
    case "failed":
    case "cancelled":
    case "budget-exhausted":
      return status;
    default:
      throw new Error(`运行归档只接受终态，收到 ${status}`);
  }
}

/** 结果摘要：完成摘要或失败理由（已在上游截断过一次，这里做归档侧二次保险）。 */
function runOutcomeSummary(checkpoint: AgentCheckpoint): string {
  if (checkpoint.status === "completed") return checkpoint.completion?.summary?.trim() || "运行完成（无摘要）";
  if (checkpoint.failure) return `${checkpoint.failure.code}: ${checkpoint.failure.message}`;
  return `运行以 ${checkpoint.status} 收口`;
}

/** 任务域键：本轮实际用过的工具 ID；无工具记录时回退授权面（提炼域匹配键）。 */
function runToolDomains(checkpoint: AgentCheckpoint): string[] {
  const used = [...new Set(checkpoint.toolRecords.map((record) => record.call.toolId))];
  return used.length ? used : [...new Set(checkpoint.allowedToolIds)].slice(0, 20);
}

/**
 * 确定性提炼规则：只从失败/受阻/回灌缺口提炼教训；正常完成的经验由 verdict
 * （确认制）与决策历史覆盖，不在此重复产噪。取消的运行不产教训（用户改向，
 * 不是可复用教训）。
 */
export function distillLessonsFromCheckpoint(checkpoint: AgentCheckpoint, options: DistillOptions = {}): Array<Omit<AgentLesson, "id" | "createdAt" | "runId">> {
  if (options.signal?.aborted) return [];
  const maxLessons = Math.max(0, options.maxLessons ?? AGENT_DISTILL_MAX_LESSONS);
  const toolIds = runToolDomains(checkpoint);
  const lessons: Array<Omit<AgentLesson, "id" | "createdAt" | "runId">> = [];

  const failure = checkpoint.failure;
  if (failure && checkpoint.status !== "cancelled") {
    lessons.push({ code: `failure:${failure.code}`, content: runFailureLesson(checkpoint, failure), toolIds });
  }
  const feedbackFindings = checkpoint.guards?.postExecuteFindings ?? [];
  if (feedbackFindings.length) {
    const codes = [...new Set(feedbackFindings.map((item) => item.code))].join("/");
    lessons.push({
      code: `feedback:${codes}`,
      content: `上轮有 ${feedbackFindings.length} 条记忆回灌失败（${codes}），相关验证结论可能未入库；不要假设上轮结论已被记录，必要时重新验证。`,
      toolIds,
    });
  }
  return lessons.slice(0, maxLessons);
}

function runFailureLesson(checkpoint: AgentCheckpoint, failure: NonNullable<AgentCheckpoint["failure"]>): string {
  const reason = failure.message.slice(0, AGENT_DISTILL_INPUT_MAX_CHARS);
  switch (failure.code) {
    case "time-budget":
    case "step-budget":
    case "tool-budget":
      return `上轮在 ${checkpoint.usage.steps} 步 / ${checkpoint.usage.toolCalls} 次工具调用后预算耗尽（${failure.code}）；同类目标应拆分子任务或放宽预算，优先复用已收集的证据。`;
    case "variant-circuit-open":
      return "上轮同一方案变体连续被语义预检拒绝并触发熔断；不得重复同参调用，先按拒绝理由修正假设结构再提案。";
    case "evidence-required":
      return `上轮收尾被拒：${reason}；production 结论必须引用已返回的工具证据 ID，先收集证据再收尾。`;
    case "duplicate-tool-call":
      return "上轮出现重复工具调用被阻断；已成功的调用不要重发同参请求，从既有证据继续。";
    case "decision-provider-unavailable":
      return "上轮决策提供方不可用导致中止；属于可重试的模型通道问题，恢复后可直接续跑，不必重做已完成步骤。";
    default:
      return `上轮以 ${checkpoint.status} 收口（${failure.code}）：${reason}`;
  }
}

/** K8 口径：流水线故障落专项审计 finding；指纹字段只存固定标记，不复制错误原文。 */
async function emitSettleFailure(audit: AiReliabilityAuditSink | undefined, checkpoint: AgentCheckpoint, code: string, error: unknown): Promise<void> {
  await emitAiAudit(audit, createAiAuditEvent({
    traceId: `${checkpoint.id}:settle`,
    stage: "memory-action",
    outcome: "degraded",
    principal: checkpoint.principal,
    projectId: checkpoint.projectId,
    findings: [{ code, severity: "warn", sourceId: "agent-memory", contentFingerprint: "settle-unavailable" }],
    failure: { code, message: safeErrorMessage(error), retryable: true },
  }));
}
