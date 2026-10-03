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

// ---------------------------------------------------------------------------
// H-autonomy：执行模式与审批来源的 UI 语义（纯函数，供工作台与测试共用）
// ---------------------------------------------------------------------------

/** H-autonomy 策略签发审批的审计身份（与 orchestrator AUTONOMY_APPROVER 同字面量）。 */
export const AUTONOMY_APPROVER_ID = "autonomy-policy";

/** run 是否处于自主执行档（checkpoint 启动时固化的自治授权）。 */
export function isAutonomousRun(checkpoint: Pick<AgentCheckpoint, "autonomy" | "planMode">): boolean {
  return checkpoint.autonomy?.mode === "autonomous" && checkpoint.planMode !== true;
}

/** 审批来源文案：策略自主签发 vs 人工审批（工具记录/待确认面板共用）。 */
export function describeApprovalSource(approvedBy: string | undefined, locale: AppLocale): string {
  if (approvedBy === AUTONOMY_APPROVER_ID) return tr(locale, "授权内自主执行（策略签发，审计留痕）", "Autonomous within authorization (policy-signed, audited)");
  return tr(locale, "人工确认", "Manually approved");
}

/** 执行模式选项标签（配置行双 chip 与运行视图徽标共用）。 */
export function describeExecutionMode(mode: "confirm" | "autonomous", locale: AppLocale): string {
  return mode === "autonomous"
    ? tr(locale, "自主执行", "Autonomous")
    : tr(locale, "逐次确认", "Confirm each");
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

export interface AgentObjectiveExamples {
  examples: string[];
  /** catalog=由当前工具目录生成；fallback=目录为空（加载失败/无能力）时的通用只读目标。 */
  source: "catalog" | "fallback";
}

/**
 * T11（审计 §二 T11）：目标示例随工具目录生成，不再用与能力面脱节的固定文案。
 * 与 T9 capabilityExampleQuestion 同族口径：按 effect 派生问句、不维护领域白名单，
 * 示例只是把话头递给模型，执行仍受白名单/审批/证据链约束。
 * 目录为空（加载失败或无只读能力）时回落通用目标并标记 fallback，不虚构能力语义。
 */
export function agentObjectiveExamples(tools: readonly AgentToolDefinition[], locale: AppLocale): AgentObjectiveExamples {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const runnable = tools.filter((tool) => !tool.requiresApproval);
  const pick = (effect: AgentToolDefinition["effect"]) => runnable.find((tool) => tool.effect === effect);
  const examples: Array<[AgentToolDefinition, string]> = [];
  const readTool = pick("read");
  if (readTool) examples.push([readTool, t(`用「${readTool.label}」检查当前项目，给出有证据的结论`, `Use "${readTool.label}" to inspect this project and return an evidence-backed conclusion`)]);
  const simulateTool = pick("simulate");
  if (simulateTool) examples.push([simulateTool, t(`先用「${simulateTool.label}」仿真验证，再给出调试建议`, `Validate with "${simulateTool.label}" first, then propose debugging actions`)]);
  const analyzeTool = pick("analyze");
  if (analyzeTool) examples.push([analyzeTool, t(`用「${analyzeTool.label}」分析当前工作区，结论必须附证据`, `Analyze this workspace with "${analyzeTool.label}"; conclusions must cite evidence`)]);
  if (examples.length) return { examples: examples.map(([, text]) => text).slice(0, 3), source: "catalog" };
  return {
    examples: [t(
      "只读检查当前项目可用能力与数据，引用实际证据给出一条可验证结论；没有数据时明确说明缺失。",
      "Inspect this project's capabilities and data read-only; return one verifiable conclusion with evidence, or state what is missing.",
    )],
    source: "fallback",
  };
}
