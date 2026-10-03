import { randomUUID } from "node:crypto";
import type { AiAssistantResponse, AiFailureCategory, AiProviderSettings } from "@bim-studio/contracts";
import type { AiProviderCompletion, AiProviderRequest, AiProviderStreamEvent, PluginRegistry } from "@bim-studio/plugin-runtime";
import { auditFingerprint, createAiAuditEvent, emitAiAudit, safeErrorMessage, type AiReliabilityAuditSink } from "./aiReliabilityAudit.js";
import { prepareAiInput, reliabilitySystemBoundary, type AiReliabilityAssessment } from "./aiReliabilityPolicy.js";
import { assistantOutputLimit, assistantPrompts, parseAssistantContent, type AssistantMode, type ParsedAssistantContent } from "./assistantPrompts.js";
import { attemptWithFailover, classifyAiProviderError, resolveFailoverTarget, type AiFailoverTarget } from "./aiFailoverPolicy.js";
import { newTelemetryRecord, type AiTelemetrySink } from "./aiRequestTelemetry.js";
import { assistantContextDelivery, assistantContextSourceSegments } from "./assistantContextDelivery.js";
import { CAPABILITY_BOUNDARY, promptCacheKey, prioritizeContextForScan } from "./assistantContextBudget.js";
import { routeAssistantModel, routeReceipt, type AiRouteDecision, type AiRoutingConfig } from "./assistantModelRouter.js";
import { auditChatAnswerEvidence, anchorChatAnswerEvidence, type ChatEvidenceAnchorSource } from "./chatEvidenceGate.js";
import type { AgentMemoryDelivery } from "./agentMemory.js";
import { agentMemoryContextDelivery, memoryDeliveryFindings } from "./industrialAgentDecisionProvider.js";
import { industrialAgentRuntimeIfReady } from "./industrialAgentRuntime.js";

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
  /** 「自动」模型路由配置（来自环境变量）；缺省视为未配置小模型。 */
  routing?: AiRoutingConfig;
};

export interface AssistantRequest {
  mode: AssistantMode;
  question: string;
  context: unknown;
  settings: AiRuntimeSettings;
  principal: string;
  projectId?: string;
  signal?: AbortSignal;
  /** 用户选择「自动」模型路由；未设置时严格使用 settings 中的模型。 */
  routing?: "auto";
}

export interface AssistantService {
  complete(request: AssistantRequest): Promise<AiAssistantResponse>;
  stream(request: AssistantRequest): AsyncIterable<AssistantStreamEvent>;
}

export interface AssistantServiceOptions {
  audit?: AiReliabilityAuditSink;
  telemetry?: AiTelemetrySink;
  now?: () => Date;
  /** K4：chat 请求按项目注入守则/记忆/既往结论；测试直注，生产走 industrialAgentRuntime 共享实例。 */
  memory?: (projectId: string) => Promise<AgentMemoryDelivery>;
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
          primary: () => invokeWithRouteFallback(registry, request.settings.providerId, prepared, request.signal),
          fallback: (target) => registry.invokeAiProvider(request.settings.providerId, fallbackProviderRequest(prepared.providerRequest, target)),
        });
        attempt = { servedBy: result.servedBy, ...(result.failover ? { failover: result.failover } : {}) };
        const completion = result.result;
        const response = withReliability(parseAssistantContent(request.mode, completion.text, completion.model), prepared, attempt);
        if (completion.execution) response.execution = { ...completion.execution, servedBy: attempt.servedBy, ...(attempt.failover ? { failoverCategory: attempt.failover.category } : {}), ...routeField(prepared) };
        await emitAiAudit(options.audit, completionEvent(prepared, prepared.request, "completed", options, attempt));
        recordTelemetry(options, prepared, attempt, "completed", Date.now() - startedAt, completion);
        return response;
      } catch (error) {
        const cancelled = Boolean(request.signal?.aborted);
        await emitAiAudit(options.audit, completionEvent(prepared, prepared.request, cancelled ? "cancelled" : "failed", options, attempt, error));
        recordTelemetry(options, prepared, attempt, cancelled ? "cancelled" : "failed", Date.now() - startedAt, undefined, error);
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
        for await (const [event, served] of streamOnce(registry, prepared, request)) {
          if (served.servedBy !== attempt.servedBy || served.routeFellBack !== attempt.routeFellBack) {
            reportedModel = undefined; usage = undefined; execution = undefined;
            yield { type: "execution", execution: null };
          }
          if (event.type === "delta") {
            content += event.delta;
            yield { type: "delta", delta: event.delta };
          } else if (event.type === "model") {
            reportedModel = event.model;
          } else if (event.type === "execution") {
            execution = { ...event.execution, servedBy: served.servedBy, ...(served.failover ? { failoverCategory: served.failover.category } : {}), ...routeField(prepared) };
            yield { type: "execution", execution };
          } else {
            usage = {
              ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
              ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
              ...(event.cachedInputTokens !== undefined ? { cachedInputTokens: event.cachedInputTokens } : {}),
            };
          }
          attempt = served;
        }
        if (!content.trim()) throw new Error("大模型没有返回内容");
        const response = withReliability(
          parseAssistantContent(request.mode, content, reportedModel ?? servedModelName(prepared.request, attempt)),
          prepared,
          attempt,
        );
        if (execution) response.execution = { ...execution, ...routeField(prepared) };
        await emitAiAudit(options.audit, completionEvent(prepared, prepared.request, "completed", options, attempt));
        recordTelemetry(options, prepared, attempt, "completed", Date.now() - startedAt, { model: reportedModel ?? servedModelName(prepared.request, attempt), usage }, undefined, request.mode);
        yield { type: "done", result: response };
      } catch (error) {
        await emitAiAudit(options.audit, completionEvent(prepared, prepared.request, request.signal?.aborted ? "cancelled" : "failed", options, attempt, error));
        recordTelemetry(options, prepared, attempt, request.signal?.aborted ? "cancelled" : "failed", Date.now() - startedAt, undefined, error, request.mode);
        throw error;
      }
    }
  };
}

type FailoverAttemptInfo = { servedBy: "primary" | "fallback"; failover?: { category: string; reason: string }; routeFellBack?: boolean };

/**
 * 流式生成器：首个增量发出之前失败且属于可切换错误时，整体改用备用配置重新流出；
 * 已经有增量输出后的失败原样抛出（客户端保留已收内容与精确原因），绝不重复拼接内容。
 */
async function* streamOnce(
  registry: PluginRegistry,
  prepared: PreparedAssistantRequest,
  request: AssistantRequest,
): AsyncGenerator<[AiProviderStreamEvent, FailoverAttemptInfo]> {
  let yieldedDelta = false;
  let primaryError: ReturnType<typeof classifyAiProviderError> | undefined;
  let providerRequest = prepared.providerRequest;
  for (;;) {
    try {
      for await (const event of registry.streamAiProvider(request.settings.providerId, providerRequest)) {
        yieldedDelta = yieldedDelta || event.type === "delta";
        yield [event, { servedBy: "primary", ...(prepared.routeFellBack ? { routeFellBack: true } : {}) }];
      }
      return;
    } catch (error) {
      if (yieldedDelta || request.signal?.aborted) throw error;
      // 自动路由 fail-open：小模型在出字前失败，原地改用用户/服务默认的强模型再试一次。
      if (prepared.strongRequest && !prepared.routeFellBack) { markRouteFallback(prepared); providerRequest = prepared.strongRequest; continue; }
      primaryError = classifyAiProviderError(error);
      if (!primaryError.failoverEligible || !resolveFailoverTarget(failoverTarget(request.settings))) throw error;
      break;
    }
  }
  const target = resolveFailoverTarget(failoverTarget(request.settings))!;
  try {
    for await (const event of registry.streamAiProvider(request.settings.providerId, fallbackProviderRequest(providerRequest, target))) {
      yield [event, { servedBy: "fallback", failover: { category: primaryError!.category, reason: primaryError!.message }, ...(prepared.routeFellBack ? { routeFellBack: true } : {}) }];
    }
  } catch (fallbackError) {
    if (request.signal?.aborted) throw fallbackError;
    throw new Error(`主模型与备用模型均失败：主模型（${primaryError!.category}）${primaryError!.message}；备用模型${safeErrorMessage(fallbackError)}`);
  }
}

/** complete 路径的自动路由 fail-open：小模型失败（非取消）→ 同请求改用强模型；仍失败则交给既有主备 failover。 */
async function invokeWithRouteFallback(registry: PluginRegistry, providerId: string, prepared: PreparedAssistantRequest, signal?: AbortSignal): Promise<AiProviderCompletion> {
  try {
    return await registry.invokeAiProvider(providerId, prepared.providerRequest);
  } catch (error) {
    if (!prepared.strongRequest || prepared.routeFellBack || signal?.aborted) throw error;
    markRouteFallback(prepared);
    return registry.invokeAiProvider(providerId, prepared.strongRequest);
  }
}

function markRouteFallback(prepared: PreparedAssistantRequest): void {
  prepared.routeFellBack = true;
  if (prepared.strongRequest) prepared.providerRequest = prepared.strongRequest;
  prepared.request = { ...prepared.request, settings: prepared.strongSettings };
}

function routeField(prepared: PreparedAssistantRequest): { route?: ReturnType<typeof routeReceipt> } {
  return prepared.route ? { route: routeReceipt(prepared.route, prepared.routeFellBack) } : {};
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
  prepared: PreparedAssistantRequest,
  attempt: FailoverAttemptInfo,
  status: "completed" | "failed" | "cancelled",
  latencyMs: number,
  completion?: { model?: string; usage?: AiProviderCompletion["usage"] },
  error?: unknown,
  mode?: AssistantMode,
): void {
  if (!options.telemetry) return;
  const request = prepared.request;
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
    ...(completion?.usage?.cachedInputTokens !== undefined ? { cachedInputTokens: completion.usage.cachedInputTokens } : {}),
    contextChars: prepared.contextDelivery.sentChars,
    ...(prepared.route ? { route: routeReceipt(prepared.route, prepared.routeFellBack) } : {}),
    ...(classification ? { errorCategory: classification.category satisfies AiFailureCategory, errorMessage: classification.message } : {}),
  }));
}

interface PreparedAssistantRequest {
  traceId: string;
  /** 生效请求：自动路由选中小模型时 settings.model 即实际模型；路由回退后换回强模型。 */
  request: AssistantRequest;
  providerRequest: AiProviderRequest;
  /** 自动路由选了小模型时的强模型兜底请求与设置（fail-open）。 */
  strongRequest?: AiProviderRequest;
  strongSettings: AiRuntimeSettings;
  route?: AiRouteDecision;
  routeFellBack?: boolean;
  assessment: AiReliabilityAssessment;
  contextFingerprint: string;
  contextWarning?: string;
  contextDelivery: ReturnType<typeof assistantContextDelivery>;
  /** K2：真正发送给模型的上下文前缀——出域复核只比对模型能看到的内容。 */
  sentContext: string;
  /** T5：逐条引用锚的证据定位输入（与 contextDelivery 同坐标系，已并入各来源的已发送长度）。 */
  citationSources: ChatEvidenceAnchorSource[];
  /** K4：逐源审计与警示（读取失败时不阻断请求，但必须留痕）。 */
  memoryFindings: Array<{ code: string; severity: string; sourceId: string; contentFingerprint: string }>;
  memoryWarning?: string;
}

async function prepareRequest(registry: PluginRegistry, request: AssistantRequest, options: AssistantServiceOptions): Promise<PreparedAssistantRequest> {
  if (!request.settings.apiKey) throw new Error("尚未配置大模型 API Key");
  const traceId = randomUUID();
  // K4：记忆投递在可靠性扫描**之前**并入上下文——RULES.md 是人写文件，必须与
  // 客户端快照同受注入扫描与隔离约束（与 agent 决策器同族纪律，禁止扫描外注入）。
  const memory = await loadMemoryDelivery(options, request.projectId);
  const scopedContext = memory.delivery?.configured
    ? { ...(asRecord(request.context) ?? { value: request.context }), agentMemoryContext: agentMemoryContextDelivery(memory.delivery) }
    : request.context;
  // 扫描额度按键序消耗：高优先级字段（对话、证据、选中）先于 platform，避免被 {truncated:true} 挤掉。
  const prepared = prepareAiInput(request.question, prioritizeContextForScan(scopedContext));
  const contextFingerprint = auditFingerprint(request.context);
  const context = withCapabilityCatalog(registry, prepared.context, request.settings.providerId);
  const assessmentEvent = createAiAuditEvent({
    traceId, stage: "input-assessment", outcome: prepared.assessment.decision === "block" ? "denied" : prepared.assessment.decision === "constrain" ? "constrained" : "allowed",
    principal: request.principal, ...(request.projectId ? { projectId: request.projectId } : {}), providerId: request.settings.providerId, model: request.settings.model,
    assessment: prepared.assessment,
    // K4 逐源投递审计：每个注入源一条 finding（内容指纹），与 context 字段一一对应。
    findings: [...prepared.assessment.findings, ...memory.findings],
    ...(options.now ? { now: options.now } : {}),
  });
  await emitAiAudit(options.audit, assessmentEvent);
  if (prepared.assessment.decision === "block") throw new AiReliabilityBlockedError(traceId, prepared.assessment.findings.map((item) => item.code));
  const { systemPrompt, userPrompt, contextWarning, contextSentChars, sentContext, budgetedContext, shapedContext, budget } = assistantPrompts(request.mode, prepared.question, context);
  // 回执口径：preparedChars = 预算前完整上下文；sent* = 预算器输出（压缩/重排后真正发给模型的对象）。
  const sentObject: unknown = budgetedContext ?? context;
  const contextDelivery = assistantContextDelivery(request.context, shapedContext ?? context, contextSentChars, sentObject, budget);
  // T5：锚定输入与实际发送对象同源同坐标系（偏移取自发送序列化，窗口为已发送前缀）。
  const citationSources = assistantContextSourceSegments(sentObject).map((segment) => ({
    ...segment,
    sentChars: Math.max(0, Math.min(segment.text.length, contextSentChars - segment.start)),
  }));
  const route = request.routing === "auto"
    ? routeAssistantModel({ mode: request.mode, question: request.question, settings: request.settings, auto: true, assessment: prepared.assessment.decision })
    : undefined;
  const instructions = `${systemPrompt}\n${reliabilitySystemBoundary(prepared.assessment)}`;
  const cacheKey = /^(1|true|on)$/i.test(process.env.AI_PROMPT_CACHE_KEY ?? "") ? promptCacheKey(request.projectId, request.mode) : undefined;
  const buildProviderRequest = (settings: AiRuntimeSettings): AiProviderRequest => ({
    requestId: traceId,
    principal: request.principal,
    ...(request.projectId ? { projectId: request.projectId } : {}),
    model: settings.model,
    instructions,
    input: userPrompt,
    temperature: settings.temperature,
    maxOutputTokens: assistantOutputLimit(request.mode),
    ...(cacheKey ? { cacheKey } : {}),
    config: {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      protocol: settings.protocol,
      ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {})
    },
    ...(request.signal ? { signal: request.signal } : {})
  });
  const routedFast = route?.tier === "fast";
  const { reasoningEffort: _strongEffort, ...withoutEffort } = request.settings;
  const effectiveSettings: AiRuntimeSettings = routedFast ? { ...withoutEffort, model: route.model } : request.settings;
  const providerRequest = buildProviderRequest(effectiveSettings);
  return {
    traceId, request: { ...request, settings: effectiveSettings }, providerRequest, strongSettings: request.settings,
    ...(routedFast ? { strongRequest: buildProviderRequest(request.settings) } : {}),
    ...(route ? { route } : {}),
    assessment: prepared.assessment, contextFingerprint, contextDelivery, sentContext, citationSources,
    memoryFindings: memory.findings, ...(memory.warning ? { memoryWarning: memory.warning } : {}),
    ...(contextWarning ? { contextWarning } : {}),
  };
}

/**
 * K4 记忆投递解析：未配置（无实例或无项目）零开销跳过；读取失败不变成新的
 * 请求故障面，但必须留审计 finding 与用户可见警示（K8 教训：静默吞掉零提示是缺陷）。
 */
async function loadMemoryDelivery(options: AssistantServiceOptions, projectId: string | undefined): Promise<{
  delivery?: AgentMemoryDelivery;
  findings: Array<{ code: string; severity: string; sourceId: string; contentFingerprint: string }>;
  warning?: string;
}> {
  if (!projectId) return { findings: [] };
  const provider = options.memory ?? runtimeMemoryProvider();
  if (!provider) return { findings: [] };
  try {
    const delivery = await provider(projectId);
    return delivery.configured
      ? { delivery, findings: memoryDeliveryFindings(delivery, []) }
      : { findings: [] };
  } catch (error) {
    // 指纹字段只存固定标记，不复制错误原文（可能含路径等敏感信息）。
    return {
      findings: [{ code: "memory-delivery-failed", severity: "warn", sourceId: "agent-memory", contentFingerprint: "delivery-unavailable" }],
      warning: `项目记忆读取失败（${safeErrorMessage(error)}），本轮未注入守则与既往验证结论；回答不参考历史反驳记录。`,
    };
  }
}

function runtimeMemoryProvider(): ((projectId: string) => Promise<AgentMemoryDelivery>) | undefined {
  const runtime = industrialAgentRuntimeIfReady();
  return runtime ? (projectId) => runtime.memory.loadDelivery(projectId) : undefined;
}

function withReliability(
  result: ParsedAssistantContent,
  prepared: PreparedAssistantRequest,
  attempt: FailoverAttemptInfo = { servedBy: "primary" },
): AiAssistantResponse {
  const suspicious = prepared.assessment.findings.length > 0;
  // K2 出域复核：答案中的数值/编号与发送上下文逐项比对，未命中即披露并降级。
  const evidence = auditChatAnswerEvidence(result.text, prepared.sentContext);
  // T5 逐条引用锚：把命中 token 对齐到真正证据定位（来源+指纹+已发送窗口内偏移）。
  const citations = anchorChatAnswerEvidence(result.text, prepared.citationSources);
  const evidenceWarnings = evidence.unmatched.length
    ? [`出域复核：${evidence.unmatched.join("、")} 未在本次发送的上下文中找到依据，相关数值或编号不可作为事实引用`]
    : [];
  const degraded = Boolean(prepared.contextWarning || result.formatWarning || evidence.unmatched.length);
  const warnings = [
    ...(evidence.matched.length ? [] : ["上下文来自客户端快照，未经服务端 Capability 证据验证"]),
    "助手不会自动执行写入或控制类操作",
    ...(prepared.contextWarning ? [prepared.contextWarning] : []),
    ...(result.formatWarning ? [result.formatWarning] : []),
    ...evidenceWarnings,
    ...(prepared.memoryWarning ? [prepared.memoryWarning] : []),
    ...(suspicious ? [`可靠性策略检测到 ${prepared.assessment.findings.length} 个可疑输入特征，已约束或隔离`] : []),
    ...(prepared.assessment.quarantinedSourceIds.length ? [`已隔离 ${prepared.assessment.quarantinedSourceIds.length} 个高风险上下文片段`] : []),
    ...(attempt.servedBy === "fallback" && attempt.failover
      ? [`主模型不可用（${failoverCategoryLabel(attempt.failover.category)}），本次回答由备用模型提供`, `切换原因：${attempt.failover.reason}`]
      : []),
  ];
  // formatWarning 是服务端内部信号（已并入 warnings），不随对外合同外泄。
  const { formatWarning: _formatWarning, ...response } = result;
  return {
    ...response,
    reliability: {
      traceId: prepared.traceId,
      verification: suspicious || degraded || prepared.contextDelivery.sources.some((source) => source.status !== "sent") ? "limited" : "unverified",
      inputRisk: inputRisk(prepared.assessment),
      // K2：服务端完成出域复核且命中依据才可声明 server-evidence；零命中保持诚实基线。
      contextTrust: evidence.matched.length > 0 ? "server-evidence" : "client-snapshot",
      contextFingerprint: prepared.contextFingerprint,
      contextDelivery: prepared.contextDelivery,
      evidenceCount: 0,
      // T5：无锚不挂字段（省体积且与合同「缺省=无锚」语义一致）。
      ...(citations.length ? { citations } : {}),
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
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
      decisionBoundary: CAPABILITY_BOUNDARY
    })),
    aiProvider: registry.getAiProvider(providerId) ?? { id: providerId, status: "unavailable" }
  };
}
