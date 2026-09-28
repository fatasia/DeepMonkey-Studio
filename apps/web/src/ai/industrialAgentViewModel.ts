import type {
  AgentCheckpoint,
  AgentEvidence,
  AgentRunStatus,
  AgentToolDefinition,
} from "@bim-studio/industrial-agent-orchestrator";
import type { AiVerificationEnvelope } from "@bim-studio/contracts";
import { validateAiVerificationEnvelope } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";

export interface AgentEvidenceView extends AgentEvidence {
  verified: boolean;
  toolLabel: string;
}

/**
 * H-C1：从工具记录提取经合同校验的 VerificationEnvelope（结论卡片数据源）。
 * 形状不符（旧数据/损坏输出）一律跳过，不让未校验数据进 UI。
 */
export function agentVerdictEnvelopes(checkpoint: AgentCheckpoint): Array<{ envelope: AiVerificationEnvelope; toolLabel: string }> {
  const verdicts: Array<{ envelope: AiVerificationEnvelope; toolLabel: string }> = [];
  for (const record of checkpoint.toolRecords) {
    if (record.call.toolId !== "simulation.golden.verify" || record.outcome.status !== "completed") continue;
    try {
      verdicts.push({
        envelope: validateAiVerificationEnvelope(record.outcome.output),
        toolLabel: record.call.toolId,
      });
    } catch { /* 非信封输出不渲染卡片。 */ }
  }
  return verdicts;
}

export function agentStatusLabel(status: AgentRunStatus, locale: AppLocale): string {
  const labels: Record<AgentRunStatus, [string, string]> = {
    running: ["正在运行", "Running"],
    "awaiting-approval": ["等待确认", "Awaiting confirmation"],
    "awaiting-input": ["请选择数据源", "Choose a data source"],
    completed: ["已完成", "Completed"],
    blocked: ["已阻断", "Blocked"],
    failed: ["运行失败", "Failed"],
    cancelled: ["已取消", "Cancelled"],
    "budget-exhausted": ["预算已用尽", "Budget exhausted"],
  };
  return tr(locale, ...labels[status]);
}

export function agentStatusTone(status: AgentRunStatus): "active" | "warning" | "success" | "danger" | "muted" {
  if (status === "running") return "active";
  if (status === "awaiting-approval" || status === "awaiting-input" || status === "budget-exhausted") return "warning";
  if (status === "completed") return "success";
  if (status === "cancelled") return "muted";
  return "danger";
}

export function agentDecisionStatusLabel(status: NonNullable<AgentCheckpoint["completion"]>["decisionStatus"], locale: AppLocale): string {
  const labels = { production: ["已验证", "Verified"], shadow: ["影子评估", "Shadow evaluation"], "insufficient-data": ["数据不足", "Insufficient data"] } as const;
  const [zh, en] = labels[status];
  return tr(locale, zh, en);
}

export function agentProgress(checkpoint: AgentCheckpoint): number {
  if (checkpoint.status === "completed") return 100;
  const step = checkpoint.usage.steps / Math.max(1, checkpoint.budget.maxSteps);
  const tools = checkpoint.usage.toolCalls / Math.max(1, checkpoint.budget.maxToolCalls);
  return Math.max(4, Math.min(96, Math.round(Math.max(step, tools) * 100)));
}

export function agentEvidenceViews(
  checkpoint: AgentCheckpoint,
  tools: readonly AgentToolDefinition[],
): AgentEvidenceView[] {
  const toolLabels = new Map(tools.map((tool) => [tool.id, tool.label]));
  const seen = new Map<string, AgentEvidenceView>();
  for (const record of checkpoint.toolRecords) {
    const verificationIds = new Set(record.outcome.verificationEvidence.map((item) => item.id));
    for (const evidence of [...record.outcome.evidence, ...record.outcome.verificationEvidence]) {
      const current = seen.get(evidence.id);
      seen.set(evidence.id, {
        ...evidence,
        verified: Boolean(current?.verified) || verificationIds.has(evidence.id),
        toolLabel: toolLabels.get(record.call.toolId) ?? record.call.toolId,
      });
    }
  }
  return [...seen.values()];
}

export function selectedToolPreview(tools: readonly AgentToolDefinition[], selectedIds: ReadonlySet<string>) {
  const selected = tools.filter((tool) => selectedIds.has(tool.id));
  return {
    selected,
    highRiskCount: selected.filter((tool) => tool.requiresApproval).length,
    evidenceRequired: selected.some((tool) => tool.effect === "write" || tool.effect === "control"),
  };
}

/**
 * H-C2 保安拒绝（M6 气泡数据源）：pre-execute 语义预检与变体熔断的拒绝
 * 都以 blocked 工具记录落 checkpoint，决策者与 UI 共用同一数据源。
 */
export interface AgentGuardDenial {
  step: number;
  toolId: string;
  code: string;
  message: string;
}

const GUARD_DENIAL_CODES = new Set(["semantic-admission", "variant-circuit-open"]);

export function agentGuardDenials(checkpoint: AgentCheckpoint): AgentGuardDenial[] {
  const denials: AgentGuardDenial[] = [];
  for (const record of checkpoint.toolRecords) {
    if (record.outcome.status !== "blocked") continue;
    const code = record.outcome.error?.code ?? "";
    if (!GUARD_DENIAL_CODES.has(code)) continue;
    denials.push({
      step: record.step,
      toolId: record.call.toolId,
      code,
      message: record.outcome.error?.message ?? "",
    });
  }
  return denials;
}

/** 熔断状态（落 checkpoint，恢复语义：本轮终态，人工介入后新开 run 计数独立）。 */
export function agentGuardCircuit(checkpoint: AgentCheckpoint): NonNullable<AgentCheckpoint["guards"]>["circuit"] {
  return checkpoint.guards?.circuit;
}

export function isAgentTerminal(status: AgentRunStatus): boolean {
  return ["completed", "blocked", "failed", "cancelled", "budget-exhausted"].includes(status);
}

export function describeAgentEffect(effect: AgentToolDefinition["effect"], locale: AppLocale): string {
  const labels: Record<AgentToolDefinition["effect"], [string, string]> = {
    read: ["只读", "Read"],
    analyze: ["分析", "Analyze"],
    simulate: ["仿真", "Simulate"],
    write: ["写入", "Write"],
    control: ["控制", "Control"],
  };
  return tr(locale, ...labels[effect]);
}
