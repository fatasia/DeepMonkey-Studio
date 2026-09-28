import {
  AiHypothesisContractError,
  fingerprint64Labeled,
  validateAiHypothesisContract,
  validateAiVerificationEnvelope,
  type AiHypothesisContract,
} from "@bim-studio/contracts";
import { createConveyorSensorAgvCalibrationModel } from "@bim-studio/plant-lite-simulation";
import type {
  AgentGuardHooks,
  AgentGuardRejection,
  AgentToolCall,
} from "@bim-studio/industrial-agent-orchestrator";
import { createAiAuditEvent, emitAiAudit, type AiReliabilityAuditSink } from "./aiReliabilityAudit.js";
import { aiToolScopeFingerprint, type AiToolCall } from "./aiToolReliability.js";
import type { AgentMemoryStore } from "./agentMemory.js";

/**
 * H-C2 保安三件（增强 1）：语义预检（挂 tool.pre-execute）、变体熔断计数键、
 * verdict 回灌（挂 tool.post-execute）。硬性 allow/deny 仍归 aiToolReliability 与
 * 工具白名单，本模块只做增值检查与记录；拒绝统一带理由码 `semantic-admission`。
 *
 * 抓手：HypothesisContract 校验只读已知字段，合同外字段（如负预热 warmupMinutes、
 * 超窗 windowMinutes）会被静默忽略——语义预检在 pre-execute fail-closed 拒绝，
 * 让提案者在消耗内核执行前拿到修正理由。
 */

export const SEMANTIC_ADMISSION_CODE = "semantic-admission";

/** 语义预检作用面：只有假设合同两工具；其余工具一律放行（不增值不添阻）。 */
const HYPOTHESIS_TOOL_IDS = new Set(["simulation.hypothesis.register", "simulation.golden.verify"]);

/** 比例型指标的值域上限：容差带覆盖全域时判题退化为恒 inconclusive（超窗），拒绝。 */
const RATIO_METRICS = new Set(["resource-utilization", "first-pass-yield"]);

export interface AgentHarnessGuardsInput {
  audit?: AiReliabilityAuditSink;
  memory?: AgentMemoryStore;
  /** 目标场景资源白名单；缺省取校准模型资源清单（与 capability 内纵深防御同源）。 */
  calibrationResourceIds?: readonly string[];
  now?: () => Date;
}

export function createAgentHarnessGuards(input: AgentHarnessGuardsInput): AgentGuardHooks {
  const resourceIds = input.calibrationResourceIds
    ?? [...new Set(createConveyorSensorAgvCalibrationModel().resources?.map((resource) => resource.id) ?? [])];
  return {
    async preExecute({ checkpoint, call }) {
      if (!HYPOTHESIS_TOOL_IDS.has(call.toolId)) return undefined;
      const rejection = semanticAdmissionRejection(call, resourceIds);
      if (!rejection) return undefined;
      const variantKey = variantKeyOf(call, rejection);
      await emitAdmissionAudit(input.audit, checkpoint, call, rejection, variantKey, input.now);
      return { ...rejection, variantKey };
    },
    async postExecute({ checkpoint, call, outcome }) {
      if (call.toolId !== "simulation.golden.verify" || !input.memory) return;
      if (outcome.status !== "completed") return;
      const envelope = readEnvelope(outcome.output);
      if (!envelope) return;
      await input.memory.recordVerdict(checkpoint.projectId, {
        proposalFingerprint: envelope.proposalFingerprint,
        resultFingerprint: envelope.resultFingerprint,
        verdict: envelope.verdict,
        reasonCode: envelope.reasonCode,
        rationale: envelope.rationale,
        runId: checkpoint.id,
        step: checkpoint.usage.steps,
      });
      // 被确定性内核反驳的结论进入候选记忆（用户确认制）：下轮注入后不得重复同方案。
      if (envelope.verdict === "refuted") {
        try {
          await input.memory.addMemoryCandidate(checkpoint.projectId, {
            content: `上轮被内核反驳的方案：${clipText(envelope.rationale, 380)}`,
            runId: checkpoint.id,
            step: checkpoint.usage.steps,
            proposalFingerprint: envelope.proposalFingerprint,
          });
        } catch { /* 记忆容量满不阻断执行链；面板清理后可再提炼。 */ }
      }
    },
  };
}

/** 合同校验 + 合同外字段拒绝 + 语义域（超窗）+ 资源存在性；全部归入 semantic-admission。 */
export function semanticAdmissionRejection(call: AgentToolCall, resourceIds: readonly string[]): Omit<AgentGuardRejection, "variantKey"> | undefined {
  const hypothesis = (call.arguments as { hypothesis?: unknown }).hypothesis;
  if (hypothesis === undefined) {
    return { code: SEMANTIC_ADMISSION_CODE, message: `${call.toolId} 缺少 hypothesis 参数，无法做语义预检` };
  }
  const unknown = unknownHypothesisFields(hypothesis);
  if (unknown.length) {
    return {
      code: SEMANTIC_ADMISSION_CODE,
      message: `假设携带未声明字段 ${unknown.join(", ")}；合同外字段（如负预热、超窗等运行参数）会被静默忽略，不得进入内核域，请修正假设结构`,
    };
  }
  let contract: AiHypothesisContract;
  try {
    contract = validateAiHypothesisContract(hypothesis);
  } catch (error) {
    if (error instanceof AiHypothesisContractError) {
      return { code: SEMANTIC_ADMISSION_CODE, message: `${error.field}: ${error.message}` };
    }
    throw error;
  }
  const overWindow = toleranceCoversEntireRange(contract);
  if (overWindow) {
    return {
      code: SEMANTIC_ADMISSION_CODE,
      message: `比例指标 ${contract.prediction.metric} 的容差 ${contract.tolerance.absolute} 覆盖整个值域，任何观测都只能判 inconclusive（超窗）；请收紧容差`,
    };
  }
  if (contract.prediction.metric === "resource-utilization" && !resourceIds.includes(contract.prediction.resourceId ?? "")) {
    return {
      code: SEMANTIC_ADMISSION_CODE,
      message: `资源 ${contract.prediction.resourceId ?? ""} 不在目标场景 ${contract.targetModel} 中；请改用场景内存在的资源 ID`,
    };
  }
  return undefined;
}

/**
 * 合同外字段收集：合同 v1 顶层与 prediction/tolerance 的字段白名单之外的键。
 * 未知字段会被内核合同静默忽略——语义上等价于"负预热/超窗"一类被丢弃的非法值。
 */
function unknownHypothesisFields(hypothesis: unknown): string[] {
  if (!hypothesis || typeof hypothesis !== "object" || Array.isArray(hypothesis)) return [];
  const source = hypothesis as Record<string, unknown>;
  const unknown: string[] = [];
  const topLevel = new Set(["hypothesisVersion", "id", "statement", "targetModel", "prediction", "tolerance"]);
  for (const key of Object.keys(source)) if (!topLevel.has(key)) unknown.push(`hypothesis.${key}`);
  if (source.prediction && typeof source.prediction === "object" && !Array.isArray(source.prediction)) {
    const prediction = new Set(["metric", "resourceId", "comparator", "expected"]);
    for (const key of Object.keys(source.prediction as Record<string, unknown>)) {
      if (!prediction.has(key)) unknown.push(`hypothesis.prediction.${key}`);
    }
  }
  if (source.tolerance && typeof source.tolerance === "object" && !Array.isArray(source.tolerance)) {
    const tolerance = new Set(["absolute"]);
    for (const key of Object.keys(source.tolerance as Record<string, unknown>)) {
      if (!tolerance.has(key)) unknown.push(`hypothesis.tolerance.${key}`);
    }
  }
  return unknown;
}

/** 超窗判定：比例指标容差带覆盖 [0,1] 全域 → 恒 inconclusive，语义非法。 */
function toleranceCoversEntireRange(contract: AiHypothesisContract): boolean {
  if (!RATIO_METRICS.has(contract.prediction.metric)) return false;
  const { expected } = contract.prediction;
  return contract.tolerance.absolute >= Math.max(expected, 1 - expected);
}

/**
 * 变体键：同目标工具 + 同假设标识 + 同目标场景 + 同指标定位 + 同比较器视为同一变体；
 * expected/tolerance/statement 微扰不改变键（这正是"参数微扰重试"要被熔断的行为）。
 */
function variantKeyOf(call: AgentToolCall, _rejection: Omit<AgentGuardRejection, "variantKey">): string {
  const hypothesis = (call.arguments as { hypothesis?: Record<string, unknown> }).hypothesis ?? {};
  const prediction = (hypothesis.prediction ?? {}) as Record<string, unknown>;
  return fingerprint64Labeled([["agent-guard-variant", {
    toolId: call.toolId,
    hypothesisId: typeof hypothesis.id === "string" ? hypothesis.id : "",
    targetModel: typeof hypothesis.targetModel === "string" ? hypothesis.targetModel : "",
    metric: typeof prediction.metric === "string" ? prediction.metric : "",
    resourceId: typeof prediction.resourceId === "string" ? prediction.resourceId : "",
    comparator: typeof prediction.comparator === "string" ? prediction.comparator : "",
  }]]);
}

/** 拒绝审计：denied 事件 + 理由码 finding；只记指纹与理由码，不复制参数原文。 */
async function emitAdmissionAudit(
  audit: AiReliabilityAuditSink | undefined,
  checkpoint: Parameters<NonNullable<AgentGuardHooks["preExecute"]>>[0]["checkpoint"],
  call: AgentToolCall,
  rejection: Omit<AgentGuardRejection, "variantKey">,
  variantKey: string,
  now?: () => Date,
): Promise<void> {
  if (!audit) return;
  const projectId = call.resources.find((resource) => resource.kind === "project")?.id ?? checkpoint.projectId;
  const scope: AiToolCall = {
    toolId: call.toolId,
    projectId,
    arguments: call.arguments,
    resources: call.resources,
  };
  await emitAiAudit(audit, createAiAuditEvent({
    traceId: `${checkpoint.id}:${checkpoint.usage.steps}`,
    stage: "tool-decision",
    outcome: "denied",
    principal: checkpoint.principal,
    projectId: checkpoint.projectId,
    tool: { id: call.toolId, risk: "low", resourceFingerprints: call.resources.map((resource) => `${resource.kind}:${resource.id}`) },
    inputFingerprint: aiToolScopeFingerprint(scope),
    findings: [{
      code: `reason:${rejection.code}`,
      severity: "info",
      sourceId: call.toolId,
      contentFingerprint: variantKey,
    }],
    failure: { code: rejection.code, message: rejection.message.slice(0, 300), retryable: rejection.retryable ?? false },
    ...(now ? { now } : {}),
  }));
}

function readEnvelope(output: unknown) {
  try {
    if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
    return validateAiVerificationEnvelope(output);
  } catch {
    return undefined;
  }
}

function clipText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
