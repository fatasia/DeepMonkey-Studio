import { compareText } from "@bim-studio/contracts";
import type {
  AgentEvidence,
  AgentToolCall,
  AgentToolDefinition,
  AgentToolEffect,
  AgentToolGateway,
  AgentToolOutcome,
} from "@bim-studio/industrial-agent-orchestrator";
import type { CapabilityDescriptor, CapabilityInvocationResult, PluginRegistry } from "@bim-studio/plugin-runtime";
import { aiToolScopeFingerprint, executeReliableAiTool, type AiToolCall, type AiToolPolicy } from "./aiToolReliability.js";
import { createAiAuditEvent, emitAiAudit, type AiReliabilityAuditSink } from "./aiReliabilityAudit.js";
import type { AiVerificationEnvelope } from "@bim-studio/contracts";
import { validateAiVerificationEnvelope } from "@bim-studio/contracts";

const CURATED_TOOL_IDS = new Set([
  "data.query.plan",
  "data.query.read",
  "operations.maintenance.assess",
  "operations.maintenance.shadow-evaluate",
  "operations.energy.analyze",
  "operations.control.apply",
  "battery.model.predict",
  "battery.release.status",
  "industrial.ai.diagnosis.compose",
  "industrial.ai.alarm-rca.compose",
  "simulation.virtual-debug.run",
  "simulation.virtual-debug.run-suite",
  "simulation.hypothesis.register",
  "simulation.golden.verify",
  "simulation.study.run-async",
  "simulation.study.status",
  "simulation.study.cancel",
  "provenance.trace",
  "manufacturing.workcell.audit",
  "modeling.parametric.validate",
]);

/** 只把已注册且明确列入工业闭环的 Capability 暴露给 Agent；不存在动态命令、shell 或文件工具。 */
export class IndustrialAgentToolGateway implements AgentToolGateway {
  constructor(private readonly registry: PluginRegistry, private readonly audit?: AiReliabilityAuditSink) {}

  list(): AgentToolDefinition[] {
    return this.registry.listCapabilities()
      .filter((descriptor) => CURATED_TOOL_IDS.has(descriptor.id))
      .map(toDefinition);
  }

  fingerprint(call: AgentToolCall): string {
    return aiToolScopeFingerprint(toReliableCall(call));
  }

  async execute(call: AgentToolCall, context: Parameters<AgentToolGateway["execute"]>[1]): Promise<AgentToolOutcome> {
    const descriptor = this.registry.getCapability(call.toolId);
    const definition = this.list().find((tool) => tool.id === call.toolId);
    if (!descriptor || !definition) return blocked("tool-not-allowed", `工具 ${call.toolId} 不在工业 Agent 白名单`);
    // H-C1 plan 档：计划模式是"更严的工具白名单"——只放行 read/analyze，
    // simulate/write/control 越界即拒并落 denied 审计（硬防线在网关，不在提示词）。
    if (context.checkpoint.planMode && !PLAN_ALLOWED_EFFECTS.includes(definition.effect)) {
      await this.emitPlanModeDenial(call, definition, context);
      return blocked("plan-mode-tool-not-allowed", `计划模式只允许读取与分析工具，${call.toolId}（${definition.effect}）被拒绝；请先输出计划等待批准后执行`);
    }
    const chosen = context.checkpoint.selections?.at(-1)?.option.id;
    if (chosen && ["data.query.plan", "data.query.read"].includes(call.toolId)) {
      const plan = call.arguments.plan as { datasetId?: unknown } | undefined;
      const datasetId = call.toolId === "data.query.plan" ? call.arguments.datasetId : plan?.datasetId;
      if (datasetId !== chosen) return blocked("selection-mismatch", "查询数据源与用户已确认的选择不一致");
    }
    const reliableCall: AiToolCall = {
      ...toReliableCall(call),
      ...(context.approval ? { approval: context.approval } : {}),
    };
    try {
      const execution = await executeReliableAiTool({
        call: reliableCall,
        policy: toolPolicy(descriptor, definition),
        context: {
          traceId: `${context.checkpoint.id}:${context.checkpoint.usage.steps}`,
          principal: context.checkpoint.principal,
          ...(context.checkpoint.role ? { role: context.checkpoint.role } : {}),
          projectId: context.checkpoint.projectId,
          signal: context.signal,
          ...(this.audit ? { audit: this.audit } : {}),
        },
        execute: async (signal) => this.registry.invokeCapability(call.toolId, {
          requestId: `${context.checkpoint.id}:${context.checkpoint.usage.toolCalls}`,
          projectId: context.checkpoint.projectId,
          principal: context.checkpoint.principal,
          ...(context.checkpoint.role ? { role: context.checkpoint.role } : {}),
          input: call.arguments,
          signal,
        }),
      });
      const outcome = invocationOutcome(execution.value, definition.effect);
      if (call.toolId === "simulation.golden.verify" && outcome.status === "completed") {
        const envelope = readVerificationEnvelope(outcome.output);
        if (envelope) {
          // K7：completed 态 gateway warnings 透传进信封（账本写失败等非致命警告必须到 UI）。
          const withWarnings = outcome.warnings?.length
            ? { ...envelope, warnings: outcome.warnings }
            : envelope;
          await this.emitVerdictAudit(call, definition, withWarnings, context);
        }
      }
      return outcome;
    } catch (error) {
      return blocked("tool-policy", error instanceof Error ? error.message : String(error));
    }
  }

  /** plan 档越界拒绝：denied 审计事件只记工具与效果，不复制参数原文。 */
  private async emitPlanModeDenial(call: AgentToolCall, definition: AgentToolDefinition, context: Parameters<AgentToolGateway["execute"]>[1]): Promise<void> {
    if (!this.audit) return;
    const event = createAiAuditEvent({
      traceId: `${context.checkpoint.id}:${context.checkpoint.usage.steps}`,
      stage: "tool-decision",
      outcome: "denied",
      principal: context.checkpoint.principal,
      projectId: context.checkpoint.projectId,
      tool: { id: call.toolId, risk: definition.risk, resourceFingerprints: call.resources.map((resource) => `${resource.kind}:${resource.id}`) },
      inputFingerprint: this.fingerprint(call),
      failure: { code: "plan-mode-tool-not-allowed", message: `计划模式拒绝 ${definition.effect} 类工具 ${call.toolId}`, retryable: false },
    });
    await emitAiAudit(this.audit, event);
  }

  /** verdict 审计：只存三指纹、判定与理由码，不存假设陈述原文（证据最小化）。 */
  private async emitVerdictAudit(call: AgentToolCall, definition: AgentToolDefinition, envelope: AiVerificationEnvelope, context: Parameters<AgentToolGateway["execute"]>[1]): Promise<void> {
    if (!this.audit) return;
    const event = createAiAuditEvent({
      traceId: `${context.checkpoint.id}:${context.checkpoint.usage.steps}`,
      stage: "tool-result",
      outcome: "completed",
      principal: context.checkpoint.principal,
      projectId: context.checkpoint.projectId,
      tool: { id: call.toolId, risk: definition.risk, resourceFingerprints: [envelope.proposalFingerprint, envelope.inputFingerprint, envelope.resultFingerprint] },
      inputFingerprint: this.fingerprint(call),
      findings: [
        { code: `verdict:${envelope.verdict}`, severity: "info", sourceId: call.toolId, contentFingerprint: envelope.resultFingerprint },
        { code: `reason:${envelope.reasonCode}`, severity: "info", sourceId: call.toolId, contentFingerprint: envelope.proposalFingerprint },
      ],
    });
    await emitAiAudit(this.audit, event);
  }
}

function toDefinition(descriptor: CapabilityDescriptor): AgentToolDefinition {
  const effect = capabilityEffect(descriptor);
  const risk = effect === "write" || effect === "control" ? "high" : effect === "simulate" ? "medium" : "low";
  return {
    id: descriptor.id,
    label: descriptor.label,
    description: descriptor.inputSchema.description ?? `${descriptor.label}（${descriptor.inputSchemaVersion}）`,
    effect,
    risk,
    requiresApproval: risk === "high",
    inputSchema: structuredClone(descriptor.inputSchema),
  };
}

const PLAN_ALLOWED_EFFECTS: readonly AgentToolEffect[] = ["read", "analyze"];

/** 从成功的 golden.verify 输出中读回经合同校验的信封；形状不符一律视作无 verdict。 */
function readVerificationEnvelope(output: unknown): AiVerificationEnvelope | undefined {
  try {
    if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
    return validateAiVerificationEnvelope(output);
  } catch {
    return undefined;
  }
}

function capabilityEffect(descriptor: CapabilityDescriptor): AgentToolEffect {
  if (descriptor.kind === "query") return "read";
  if (descriptor.kind === "simulation") return "simulate";
  if (descriptor.kind === "action") return descriptor.permissions.some((item) => /control|execute/i.test(item)) ? "control" : "write";
  if (descriptor.permissions.some((item) => item.endsWith(".write"))) return "write";
  return "analyze";
}

function toolPolicy(descriptor: CapabilityDescriptor, definition: AgentToolDefinition): AiToolPolicy {
  const properties = descriptor.inputSchema.properties ?? {};
  return {
    toolId: descriptor.id,
    risk: definition.risk,
    allowedArgumentKeys: Object.keys(properties),
    allowedResourceKinds: ["project", "scene", "object", "dataset", "model", "deployment"],
    timeoutMs: descriptor.timeoutMs,
    maxInputBytes: 2 * 1024 * 1024,
    requiresApproval: definition.requiresApproval,
    allowedRoles: definition.requiresApproval ? ["admin", "editor"] : ["admin", "editor", "viewer"],
  };
}

function toReliableCall(call: AgentToolCall): Omit<AiToolCall, "approval"> {
  const resources = structuredClone(call.resources).sort((left, right) =>
    compareText(`${left.kind}:${left.id}:${left.projectId ?? ""}`, `${right.kind}:${right.id}:${right.projectId ?? ""}`),
  );
  return {
    toolId: call.toolId,
    projectId: resources.find((item) => item.projectId)?.projectId ?? resources.find((item) => item.kind === "project")?.id ?? "",
    arguments: structuredClone(call.arguments),
    resources,
  };
}

function invocationOutcome(result: CapabilityInvocationResult, effect: AgentToolEffect): AgentToolOutcome {
  const evidence = result.evidence.map(toEvidence);
  const successful = result.status === "completed";
  return {
    status: successful ? "completed" : result.status === "failed" ? "failed" : "blocked",
    ...(result.output !== undefined ? { output: structuredClone(result.output) } : {}),
    evidence,
    verificationEvidence: successful && (effect === "write" || effect === "control") && outputVerified(result.output, evidence)
      ? evidence.filter((item) => Boolean(item.fingerprint))
      : [],
    // K7 修复：completed 态的 warnings 必须透传，禁止静默丢弃（verdict 卡与审计事件消费）。
    ...(result.warnings.length > 0 ? { warnings: [...result.warnings] } : {}),
    ...(result.error ? { error: structuredClone(result.error) } : !successful ? { error: { code: result.status, message: result.warnings.join("；") || "能力未完成", retryable: result.status === "failed" } } : {}),
  };
}

function outputVerified(output: unknown, evidence: AgentEvidence[]): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const source = output as Record<string, unknown>;
  if (source.verificationStatus === "passed") return evidence.some((item) => Boolean(item.fingerprint));
  return typeof source.evidenceFingerprint === "string"
    && evidence.some((item) => item.fingerprint === source.evidenceFingerprint);
}

function toEvidence(value: CapabilityInvocationResult["evidence"][number]): AgentEvidence {
  return {
    id: value.id,
    kind: value.kind,
    label: value.label,
    source: value.source,
    ...(value.fingerprint ? { fingerprint: value.fingerprint } : {}),
  };
}

function blocked(code: string, message: string): AgentToolOutcome {
  return { status: "blocked", evidence: [], verificationEvidence: [], error: { code, message, retryable: false } };
}
