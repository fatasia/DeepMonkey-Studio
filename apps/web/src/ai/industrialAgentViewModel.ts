import type {
  AgentCheckpoint,
  AgentEvidence,
  AgentRunStatus,
  AgentToolDefinition,
} from "@bim-studio/industrial-agent-orchestrator";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";

export interface AgentEvidenceView extends AgentEvidence {
  verified: boolean;
  toolLabel: string;
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
