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
import type { AiReliabilityAuditSink } from "./aiReliabilityAudit.js";

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
      return invocationOutcome(execution.value, definition.effect);
    } catch (error) {
      return blocked("tool-policy", error instanceof Error ? error.message : String(error));
    }
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
    `${left.kind}:${left.id}:${left.projectId ?? ""}`.localeCompare(`${right.kind}:${right.id}:${right.projectId ?? ""}`),
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
