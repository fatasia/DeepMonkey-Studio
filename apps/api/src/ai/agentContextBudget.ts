import type { AgentDecision, AgentDecisionRecord, AgentToolRecord } from "@bim-studio/industrial-agent-orchestrator";

export interface AgentToolResultView {
  toolId: string;
  status: string;
  output: unknown;
  evidence: unknown[];
  error?: unknown;
  /** 超出预算的历史轮次以摘要视图出现，而不是被硬截断丢弃。 */
  summarized?: boolean;
  outputLength?: number;
  evidenceCount?: number;
}

export interface AgentDecisionView {
  step: number;
  kind: AgentDecision["kind"];
  rationale?: string;
  summarized?: boolean;
}

export interface AgentContextCompression {
  applied: boolean;
  summarizedDecisions: number;
  summarizedToolResults: number;
  approxChars: number;
}

export interface CompressedAgentContext {
  decisions: Array<AgentDecisionView | AgentDecisionRecord>;
  toolResults: AgentToolResultView[];
  compression: AgentContextCompression;
}

export interface AgentContextBudgetOptions {
  /** 最近 N 轮保持全保真；更早的轮次压缩为摘要视图。 */
  recentRounds?: number;
  /** priorDecisions + toolResults 序列化后的近似字符预算。 */
  charBudget?: number;
  outputPreviewChars?: number;
  rationaleChars?: number;
}

const DIGEST_MARKER = "…[已摘要压缩]";

/**
 * Agent 上下文预算：决策与工具结果超出最近窗口时，把最旧轮次压缩为
 * 摘要视图（保留工具 ID、状态、输出预览、证据数量与错误），而不是硬截断；
 * 仍超预算时按半数收缩全保真窗口，直到满足预算或只剩最近一轮。
 */
export function compressAgentContext(
  decisions: readonly AgentDecisionRecord[],
  toolRecords: readonly AgentToolRecord[],
  options: AgentContextBudgetOptions = {},
): CompressedAgentContext {
  const recentRounds = options.recentRounds ?? 6;
  const charBudget = options.charBudget ?? 48_000;
  const outputPreviewChars = options.outputPreviewChars ?? 240;
  const rationaleChars = options.rationaleChars ?? 160;

  let window = recentRounds;
  let compressed = build(decisions, toolRecords, window, outputPreviewChars, rationaleChars);
  while (approxChars(compressed) > charBudget && window > 1) {
    window = Math.max(1, Math.floor(window / 2));
    compressed = build(decisions, toolRecords, window, Math.min(outputPreviewChars, 120), rationaleChars);
  }
  return compressed;
}

function build(
  decisions: readonly AgentDecisionRecord[],
  toolRecords: readonly AgentToolRecord[],
  recentRounds: number,
  outputPreviewChars: number,
  rationaleChars: number,
): CompressedAgentContext {
  const recentFloor = decisions.length > recentRounds ? decisions.length - recentRounds : 0;
  const compressedDecisions: Array<AgentDecisionView | AgentDecisionRecord> = decisions.map((record, index) => {
    if (index >= recentFloor) return record;
    const rationale = truncateWithMarker(rationaleOf(record.decision), rationaleChars);
    return {
      step: record.step,
      kind: record.decision.kind,
      ...(rationale ? { rationale } : {}),
      summarized: true,
    };
  });

  const recentToolFloor = toolRecords.length > recentRounds ? toolRecords.length - recentRounds : 0;
  const toolResults: AgentToolResultView[] = toolRecords.map((record, index) => {
    const evidence = [...record.outcome.evidence, ...record.outcome.verificationEvidence];
    if (index >= recentToolFloor) {
      return {
        toolId: record.call.toolId,
        status: record.outcome.status,
        output: record.outcome.output,
        evidence,
        ...(record.outcome.error ? { error: record.outcome.error } : {}),
      };
    }
    return {
      toolId: record.call.toolId,
      status: record.outcome.status,
      output: truncateWithMarker(stringify(record.outcome.output), outputPreviewChars),
      evidence: evidence.map((item) => evidenceDigest(item, outputPreviewChars)),
      ...(record.outcome.error ? { error: record.outcome.error } : {}),
      summarized: true,
      ...(record.outcome.output !== undefined && record.outcome.output !== null ? { outputLength: stringify(record.outcome.output).length } : {}),
      evidenceCount: evidence.length,
    };
  });

  return {
    decisions: compressedDecisions,
    toolResults,
    compression: {
      applied: recentFloor > 0 || recentToolFloor > 0,
      summarizedDecisions: recentFloor,
      summarizedToolResults: recentToolFloor,
      approxChars: 0,
    },
  };
}

function approxChars(context: CompressedAgentContext): number {
  return JSON.stringify({ decisions: context.decisions, toolResults: context.toolResults }).length;
}

function rationaleOf(decision: AgentDecision): string {
  return typeof (decision as { rationale?: unknown }).rationale === "string" ? (decision as { rationale: string }).rationale : "";
}

function evidenceDigest(item: unknown, previewChars: number): unknown {
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    return {
      ...record,
      ...(record.content !== undefined ? { content: truncateWithMarker(stringify(record.content), Math.min(previewChars, 80)) } : {}),
    };
  }
  return truncateWithMarker(stringify(item), Math.min(previewChars, 80));
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** 摘要视图：仅在确实发生截断时追加标记，不膨胀短文本。 */
function truncateWithMarker(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}${DIGEST_MARKER}` : value;
}
