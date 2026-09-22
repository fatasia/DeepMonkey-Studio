import { randomUUID } from "node:crypto";
import type { AiAssistantResponse, AiFailureCategory, AiProviderSettings } from "@bim-studio/contracts";
import type { AiProviderCompletion, AiProviderRequest, AiProviderStreamEvent, PluginRegistry } from "@bim-studio/plugin-runtime";
import { auditFingerprint, createAiAuditEvent, emitAiAudit, safeErrorMessage, type AiReliabilityAuditSink } from "./aiReliabilityAudit.js";
import { prepareAiInput, reliabilitySystemBoundary, type AiReliabilityAssessment } from "./aiReliabilityPolicy.js";
import { assistantOutputLimit, assistantPrompts, parseAssistantContent, type AssistantMode } from "./assistantPrompts.js";
import { attemptWithFailover, classifyAiProviderError, resolveFailoverTarget, type AiFailoverTarget } from "./aiFailoverPolicy.js";
import { newTelemetryRecord, type AiTelemetrySink } from "./aiRequestTelemetry.js";
import { assistantContextDelivery } from "./assistantContextDelivery.js";

export type AssistantStreamEvent =
  | { type: "delta"; delta: string }
  | { type: "execution"; execution: AiAssistantResponse["execution"] | null }
  | { type: "done"; result: AiAssistantResponse };

export interface AiRuntimeFailoverSettings {
  enabled: boolean;
  providerId: string;
  baseUrl: string;
  model: string;
  protocol: "auto" | "responses" | "chat-completions";
  apiKey: string;
}

export type AiRuntimeSettings = Omit<AiProviderSettings, "apiKeyConfigured" | "apiKey" | "failover"> & {
  apiKey: string;
  failover?: AiRuntimeFailoverSettings;
};

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
  telemetry?: AiTelemetrySink;
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
 * 主模型请求失败且属于可切换错误（额度/限流/服务端/超时/网络）时，
 * 用备用模型配置重试一次；主路径成功时零额外开销、无额外请求。
 */
export function createAssistantService(registry: PluginRegistry, options: AssistantServiceOptions = {}): AssistantService {
  return {
    async complete(request) {
      const startedAt = Date.now();
      const prepared = await prepareRequest(registry, request, options);
      let attempt: FailoverAttemptInfo = { servedBy: "primary" };
      try {
        const result = await attemptWithFailover({
          failover: failoverTarget(request.settings),
          ...(request.signal ? { signal: request.signal } : {}),
          primary: () => registry.invokeAiProvider(request.settings.providerId, prepared.providerRequest),
          fallback: (target) => registry.invokeAiProvider(request.settings.providerId, fallbackProviderRequest(prepared.providerRequest, target)),
        });
        attempt = { servedBy: result.servedBy, ...(result.failover ? { failover: result.failover } : {}) };
        const completion = result.result;
        const response = withReliability(parseAssistantContent(request.mode, completion.text, completion.model), prepared, attempt);
        if (completion.execution) response.execution = { ...completion.execution, servedBy: attempt.servedBy, ...(attempt.failover ? { failoverCategory: attempt.failover.category } : {}) };
        await emitAiAudit(options.audit, completionEvent(prepared, request, "completed", options, attempt));
        recordTelemetry(options, request, attempt, "completed", Date.now() - startedAt, completion);
        return response;
      } catch (error) {
        const cancelled = Boolean(request.signal?.aborted);
        await emitAiAudit(options.audit, completionEvent(prepared, request, cancelled ? "cancelled" : "failed", options, attempt, error));
        recordTelemetry(options, request, attempt, cancelled ? "cancelled" : "failed", Date.now() - startedAt, undefined, error);
        throw error;
      }
    },
    async *stream(request) {
      const startedAt = Date.now();
      const prepared = await prepareRequest(registry, request, options);
      let content = "";
      let usage: AiProviderCompletion["usage"] | undefined;
      let reportedModel: string | undefined;
      let execution: AiProviderCompletion["execution"];
      let attempt: FailoverAttemptInfo = { servedBy: "primary" };
      try {
        for await (const [event, served] of streamOnce(registry, prepared.providerRequest, request)) {
          if (served.servedBy !== attempt.servedBy) {
            reportedModel = undefined; usage = undefined; execution = undefined;
            yield { type: "execution", execution: null };
          }
          if (event.type === "delta") {
            content += event.delta;
            yield { type: "delta", delta: event.delta };
          } else if (event.type === "model") {
            reportedModel = event.model;
          } else if (event.type === "execution") {
            execution = { ...event.execution, servedBy: served.servedBy, ...(served.failover ? { failoverCategory: served.failover.category } : {}) };
            yield { type: "execution", execution };
          } else {
            usage = {
              ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
              ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
            };
          }
          attempt = served;
        }
        if (!content.trim()) throw new Error("大模型没有返回内容");
        const response = withReliability(
          parseAssistantContent(request.mode, content, reportedModel ?? servedModelName(request, attempt)),
          prepared,
          attempt,
        );
        if (execution) response.execution = execution;
        await emitAiAudit(options.audit, completionEvent(prepared, request, "completed", options, attempt));
        recordTelemetry(options, request, attempt, "completed", Date.now() - startedAt, { model: reportedModel ?? servedModelName(request, attempt), usage }, undefined, request.mode);
        yield { type: "done", result: response };
      } catch (error) {
        await emitAiAudit(options.audit, completionEvent(prepared, request, request.signal?.aborted ? "cancelled" : "failed", options, attempt, error));
        recordTelemetry(options, request, attempt, request.signal?.aborted ? "cancelled" : "failed", Date.now() - startedAt, undefined, error, request.mode);
        throw error;
      }
    }
  };
}

type FailoverAttemptInfo = { servedBy: "primary" | "fallback"; failover?: { category: string; reason: string } };

/**
 * 流式生成器：首个增量发出之前失败且属于可切换错误时，整体改用备用配置重新流出；
 * 已经有增量输出后的失败原样抛出（客户端保留已收内容与精确原因），绝不重复拼接内容。
 */
async function* streamOnce(
  registry: PluginRegistry,
  providerRequest: AiProviderRequest,
  request: AssistantRequest,
): AsyncGenerator<[AiProviderStreamEvent, FailoverAttemptInfo]> {
  let yieldedDelta = false;
  let primaryError: ReturnType<typeof classifyAiProviderError> | undefined;
  try {
    for await (const event of registry.streamAiProvider(request.settings.providerId, providerRequest)) {
      yieldedDelta = yieldedDelta || event.type === "delta";
      yield [event, { servedBy: "primary" }];
    }
    return;
  } catch (error) {
    if (yieldedDelta || request.signal?.aborted) throw error;
    primaryError = classifyAiProviderError(error);
    if (!primaryError.failoverEligible || !resolveFailoverTarget(failoverTarget(request.settings))) throw error;
  }
  const target = resolveFailoverTarget(failoverTarget(request.settings))!;
  try {
    for await (const event of registry.streamAiProvider(request.settings.providerId, fallbackProviderRequest(providerRequest, target))) {
      yield [event, { servedBy: "fallback", failover: { category: primaryError!.category, reason: primaryError!.message } }];
    }
  } catch (fallbackError) {
    if (request.signal?.aborted) throw fallbackError;
    throw new Error(`主模型与备用模型均失败：主模型（${primaryError!.category}）${primaryError!.message}；备用模型${safeErrorMessage(fallbackError)}`);
  }
}

function servedModelName(request: AssistantRequest, attempt: FailoverAttemptInfo): string {
  if (attempt.servedBy !== "fallback") return request.settings.model;
  return request.settings.failover?.model || request.settings.model;
}

function fallbackProviderRequest(providerRequest: AiProviderRequest, target: AiFailoverTarget): AiProviderRequest {
  const { reasoningEffort: _primaryEffort, ...config } = providerRequest.config;
  return {
    ...providerRequest,
    model: target.model,
    config: { ...config, baseUrl: target.baseUrl, apiKey: target.apiKey, protocol: target.protocol },
  };
}

function failoverTarget(settings: AiRuntimeSettings): AiFailoverTarget | undefined {
  const failover = settings.failover;
  if (!failover) return undefined;
  return {
    enabled: failover.enabled,
    baseUrl: failover.baseUrl,
    apiKey: failover.apiKey,
    model: failover.model,
    protocol: failover.protocol,
  };
}

function recordTelemetry(
  options: AssistantServiceOptions,
  request: AssistantRequest,
  attempt: FailoverAttemptInfo,
  status: "completed" | "failed" | "cancelled",
  latencyMs: number,
  completion?: { model?: string; usage?: AiProviderCompletion["usage"] },
  error?: unknown,
  mode?: AssistantMode,
): void {
  if (!options.telemetry) return;
  const classification = status === "completed" ? undefined : classifyAiProviderError(error);
  options.telemetry(newTelemetryRecord({
    occurredAt: (options.now?.() ?? new Date()).toISOString(),
    source: "assistant",
    ...(mode ? { mode } : {}),
    providerId: request.settings.providerId,
    model: completion?.model ?? servedModelName(request, attempt),
    servedBy: attempt.servedBy,
    status,
    latencyMs,
    ...(completion?.usage?.inputTokens !== undefined ? { inputTokens: completion.usage.inputTokens } : {}),
    ...(completion?.usage?.outputTokens !== undefined ? { outputTokens: completion.usage.outputTokens } : {}),
    ...(classification ? { errorCategory: classification.category satisfies AiFailureCategory, errorMessage: classification.message } : {}),
  }));
}

interface PreparedAssistantRequest {
  traceId: string;
  providerRequest: AiProviderRequest;
  assessment: AiReliabilityAssessment;
  contextFingerprint: string;
  contextWarning?: string;
  contextDelivery: ReturnType<typeof assistantContextDelivery>;
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
  const { systemPrompt, userPrompt, contextWarning, contextSentChars } = assistantPrompts(request.mode, prepared.question, context);
  const contextDelivery = assistantContextDelivery(request.context, context, contextSentChars);
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
      protocol: request.settings.protocol,
      ...(request.settings.reasoningEffort ? { reasoningEffort: request.settings.reasoningEffort } : {})
    },
    ...(request.signal ? { signal: request.signal } : {})
  };
  return { traceId, providerRequest, assessment: prepared.assessment, contextFingerprint, contextDelivery, ...(contextWarning ? { contextWarning } : {}) };
}

function withReliability(
  result: AiAssistantResponse,
  prepared: PreparedAssistantRequest,
  attempt: FailoverAttemptInfo = { servedBy: "primary" },
): AiAssistantResponse {
  const suspicious = prepared.assessment.findings.length > 0;
  const warnings = [
    "上下文来自客户端快照，未经服务端 Capability 证据验证",
    "助手不会自动执行写入或控制类操作",
    ...(prepared.contextWarning ? [prepared.contextWarning] : []),
    ...(suspicious ? [`可靠性策略检测到 ${prepared.assessment.findings.length} 个可疑输入特征，已约束或隔离`] : []),
    ...(prepared.assessment.quarantinedSourceIds.length ? [`已隔离 ${prepared.assessment.quarantinedSourceIds.length} 个高风险上下文片段`] : []),
    ...(attempt.servedBy === "fallback" && attempt.failover
      ? [`主模型不可用（${failoverCategoryLabel(attempt.failover.category)}），本次回答由备用模型提供`, `切换原因：${attempt.failover.reason}`]
      : []),
  ];
  return {
    ...result,
    reliability: {
      traceId: prepared.traceId,
      verification: suspicious || prepared.contextWarning || prepared.contextDelivery.sources.some((source) => source.status !== "sent") ? "limited" : "unverified",
      inputRisk: inputRisk(prepared.assessment),
      contextTrust: "client-snapshot",
      contextFingerprint: prepared.contextFingerprint,
      contextDelivery: prepared.contextDelivery,
      evidenceCount: 0,
      warnings,
      writePolicy: "read-only",
      servedProvider: attempt.servedBy,
      ...(attempt.servedBy === "fallback" && attempt.failover ? { failoverReason: `${attempt.failover.category}: ${attempt.failover.reason}` } : {}),
    },
  };
}

function failoverCategoryLabel(category: string): string {
  return ({ auth: "鉴权失败", quota: "额度不足", "rate-limit": "请求限流", server: "服务端错误", timeout: "请求超时", network: "网络错误", policy: "内容策略", invalid: "请求无效", cancelled: "已取消", unknown: "未知错误" } as Record<string, string>)[category] ?? category;
}

function inputRisk(assessment: AiReliabilityAssessment): "low" | "medium" | "high" {
  if (assessment.decision === "block" || assessment.findings.some((item) => item.severity === "critical" || item.severity === "high")) return "high";
  return assessment.findings.length ? "medium" : "low";
}

function completionEvent(
  prepared: PreparedAssistantRequest,
  request: AssistantRequest,
  outcome: "completed" | "failed" | "cancelled",
  options: AssistantServiceOptions,
  attempt: FailoverAttemptInfo,
  error?: unknown,
) {
  const fallbackServed = attempt.servedBy === "fallback";
  return createAiAuditEvent({
    traceId: prepared.traceId, stage: "model-completion", outcome: fallbackServed && outcome === "completed" ? "degraded" : outcome,
    principal: request.principal, ...(request.projectId ? { projectId: request.projectId } : {}),
    providerId: fallbackServed ? `${request.settings.providerId}#fallback` : request.settings.providerId,
    model: servedModelName(request, attempt), assessment: prepared.assessment, ...(options.now ? { now: options.now } : {}),
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
