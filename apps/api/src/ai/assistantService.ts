import { randomUUID } from "node:crypto";
import type { AiAssistantResponse, AiProviderSettings } from "@bim-studio/contracts";
import type { AiProviderRequest, PluginRegistry } from "@bim-studio/plugin-runtime";
import { auditFingerprint, createAiAuditEvent, emitAiAudit, safeErrorMessage, type AiReliabilityAuditSink } from "./aiReliabilityAudit.js";
import { prepareAiInput, reliabilitySystemBoundary, type AiReliabilityAssessment } from "./aiReliabilityPolicy.js";
import { assistantOutputLimit, assistantPrompts, parseAssistantContent, type AssistantMode } from "./assistantPrompts.js";

export type AssistantStreamEvent =
  | { type: "delta"; delta: string }
  | { type: "done"; result: AiAssistantResponse };

export type AiRuntimeSettings = Omit<AiProviderSettings, "apiKeyConfigured" | "apiKey"> & { apiKey: string };

export interface AssistantRequest {
  mode: AssistantMode;
  question: string;
  context: unknown;
  settings: AiRuntimeSettings;
  principal: string;
  projectId?: string;
  signal?: AbortSignal;
}

export interface AssistantService {
  complete(request: AssistantRequest): Promise<AiAssistantResponse>;
  stream(request: AssistantRequest): AsyncIterable<AssistantStreamEvent>;
}

export interface AssistantServiceOptions {
  audit?: AiReliabilityAuditSink;
  now?: () => Date;
}

export class AiReliabilityBlockedError extends Error {
  public readonly code = "ai-input-blocked";
  public readonly retryable = false;
  public constructor(public readonly traceId: string, public readonly findings: string[]) {
    super("请求包含暴露敏感信息或绕过工具审批的高风险指令，已停止处理");
    this.name = "AiReliabilityBlockedError";
  }
}

/**
 * 助手只负责编排提示词和插件能力目录；具体模型协议由 AI Provider 插件实现，
 * 领域事实仍由 Capability 执行，不能把 LLM 文本当作确定性结果。
 */
export function createAssistantService(registry: PluginRegistry, options: AssistantServiceOptions = {}): AssistantService {
  return {
    async complete(request) {
      const prepared = await prepareRequest(registry, request, options);
      try {
        const completion = await registry.invokeAiProvider(request.settings.providerId, prepared.providerRequest);
        const result = withReliability(parseAssistantContent(request.mode, completion.text, completion.model), prepared);
        await emitAiAudit(options.audit, completionEvent(prepared, request, "completed", options));
        return result;
      } catch (error) {
        await emitAiAudit(options.audit, completionEvent(prepared, request, request.signal?.aborted ? "cancelled" : "failed", options, error));
        throw error;
      }
    },
    async *stream(request) {
      const prepared = await prepareRequest(registry, request, options);
      let content = "";
      try {
        for await (const event of registry.streamAiProvider(request.settings.providerId, prepared.providerRequest)) {
          if (event.type !== "delta") continue;
          content += event.delta;
          yield { type: "delta", delta: event.delta };
        }
        if (!content.trim()) throw new Error("大模型没有返回内容");
        const result = withReliability(parseAssistantContent(request.mode, content, request.settings.model), prepared);
        await emitAiAudit(options.audit, completionEvent(prepared, request, "completed", options));
        yield { type: "done", result };
      } catch (error) {
        await emitAiAudit(options.audit, completionEvent(prepared, request, request.signal?.aborted ? "cancelled" : "failed", options, error));
        throw error;
      }
    }
  };
}

interface PreparedAssistantRequest {
  traceId: string;
  providerRequest: AiProviderRequest;
  assessment: AiReliabilityAssessment;
  contextFingerprint: string;
}

async function prepareRequest(registry: PluginRegistry, request: AssistantRequest, options: AssistantServiceOptions): Promise<PreparedAssistantRequest> {
  if (!request.settings.apiKey) throw new Error("尚未配置大模型 API Key");
  const traceId = randomUUID();
  const prepared = prepareAiInput(request.question, request.context);
  const contextFingerprint = auditFingerprint(request.context);
  const assessmentEvent = createAiAuditEvent({
    traceId, stage: "input-assessment", outcome: prepared.assessment.decision === "block" ? "denied" : prepared.assessment.decision === "constrain" ? "constrained" : "allowed",
    principal: request.principal, ...(request.projectId ? { projectId: request.projectId } : {}), providerId: request.settings.providerId, model: request.settings.model,
    assessment: prepared.assessment, ...(options.now ? { now: options.now } : {}),
  });
  await emitAiAudit(options.audit, assessmentEvent);
  if (prepared.assessment.decision === "block") throw new AiReliabilityBlockedError(traceId, prepared.assessment.findings.map((item) => item.code));
  const context = withCapabilityCatalog(registry, prepared.context, request.settings.providerId);
  const { systemPrompt, userPrompt } = assistantPrompts(request.mode, prepared.question, context);
  const providerRequest: AiProviderRequest = {
    requestId: traceId,
    principal: request.principal,
    ...(request.projectId ? { projectId: request.projectId } : {}),
    model: request.settings.model,
    instructions: `${systemPrompt}\n${reliabilitySystemBoundary(prepared.assessment)}`,
    input: userPrompt,
    temperature: request.settings.temperature,
    maxOutputTokens: assistantOutputLimit(request.mode),
    config: {
      baseUrl: request.settings.baseUrl,
      apiKey: request.settings.apiKey,
      protocol: request.settings.protocol
    },
    ...(request.signal ? { signal: request.signal } : {})
  };
  return { traceId, providerRequest, assessment: prepared.assessment, contextFingerprint };
}

function withReliability(result: AiAssistantResponse, prepared: PreparedAssistantRequest): AiAssistantResponse {
  const suspicious = prepared.assessment.findings.length > 0;
  const warnings = [
    "上下文来自客户端快照，未经服务端 Capability 证据验证",
    "助手不会自动执行写入或控制类操作",
    ...(suspicious ? [`可靠性策略检测到 ${prepared.assessment.findings.length} 个可疑输入特征，已约束或隔离`] : []),
    ...(prepared.assessment.quarantinedSourceIds.length ? [`已隔离 ${prepared.assessment.quarantinedSourceIds.length} 个高风险上下文片段`] : []),
  ];
  return {
    ...result,
    reliability: {
      traceId: prepared.traceId,
      verification: suspicious ? "limited" : "unverified",
      inputRisk: inputRisk(prepared.assessment),
      contextTrust: "client-snapshot",
      contextFingerprint: prepared.contextFingerprint,
      evidenceCount: 0,
      warnings,
      writePolicy: "read-only",
    },
  };
}

function inputRisk(assessment: AiReliabilityAssessment): "low" | "medium" | "high" {
  if (assessment.decision === "block" || assessment.findings.some((item) => item.severity === "critical" || item.severity === "high")) return "high";
  return assessment.findings.length ? "medium" : "low";
}

function completionEvent(prepared: PreparedAssistantRequest, request: AssistantRequest, outcome: "completed" | "failed" | "cancelled", options: AssistantServiceOptions, error?: unknown) {
  return createAiAuditEvent({
    traceId: prepared.traceId, stage: "model-completion", outcome, principal: request.principal, ...(request.projectId ? { projectId: request.projectId } : {}),
    providerId: request.settings.providerId, model: request.settings.model, assessment: prepared.assessment, ...(options.now ? { now: options.now } : {}),
    ...(error ? { failure: { code: outcome, message: safeErrorMessage(error), retryable: outcome === "failed" } } : {}),
  });
}

function withCapabilityCatalog(registry: PluginRegistry, context: unknown, providerId: string): Record<string, unknown> {
  const supplied = context && typeof context === "object" && !Array.isArray(context) ? context as Record<string, unknown> : { value: context };
  return {
    ...supplied,
    availableCapabilities: registry.listCapabilities().map((capability) => ({
      id: capability.id,
      label: capability.label,
      kind: capability.kind,
      inputSchemaVersion: capability.inputSchemaVersion,
      inputSchema: capability.inputSchema,
      decisionBoundary: "目录仅表示可调用；未返回 capabilityResult 前不得声称已经执行"
    })),
    aiProvider: registry.getAiProvider(providerId) ?? { id: providerId, status: "unavailable" }
  };
}
