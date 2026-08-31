import type { AiReliabilityAuditEvent, AiReliabilityAuditSink } from "./aiReliabilityAudit.js";
import { auditFingerprint, createAiAuditEvent, emitAiAudit, safeErrorMessage } from "./aiReliabilityAudit.js";
import { AI_RELIABILITY_POLICY_VERSION } from "./aiReliabilityPolicy.js";

export type AiToolRisk = "low" | "medium" | "high" | "critical";

export interface AiToolCall {
  toolId: string;
  projectId: string;
  arguments: Record<string, unknown>;
  resources: Array<{ kind: string; id: string; projectId?: string }>;
  approval?: { approvedBy: string; approvedAt: string; scopeFingerprint: string };
}

export interface AiToolPolicy {
  toolId: string;
  risk: AiToolRisk;
  allowedArgumentKeys: readonly string[];
  allowedResourceKinds: readonly string[];
  timeoutMs: number;
  maxInputBytes?: number;
  requiresApproval?: boolean;
  allowedRoles?: readonly string[];
}

export interface AiToolExecutionContext {
  traceId: string;
  principal: string;
  role?: string;
  projectId: string;
  signal?: AbortSignal;
  audit?: AiReliabilityAuditSink;
  now?: () => Date;
}

export interface AiToolExecutionResult<T> {
  value: T;
  degraded: boolean;
  audit: AiReliabilityAuditEvent;
  fallbackReason?: string;
}

export class AiToolPolicyError extends Error {
  public constructor(public readonly code: "tool-not-allowed" | "principal-scope" | "project-scope" | "resource-scope" | "invalid-arguments" | "approval-required", message: string) {
    super(message);
    this.name = "AiToolPolicyError";
  }
}

export function aiToolScopeFingerprint(call: Omit<AiToolCall, "approval">): string {
  return auditFingerprint({ toolId: call.toolId, projectId: call.projectId, arguments: call.arguments, resources: call.resources });
}

export function validateAiToolCall(call: AiToolCall, policy: AiToolPolicy, context: AiToolExecutionContext): void {
  if (call.toolId !== policy.toolId) throw new AiToolPolicyError("tool-not-allowed", `工具 ${call.toolId} 不在当前策略范围`);
  if (policy.allowedRoles && (!context.role || !policy.allowedRoles.includes(context.role))) throw new AiToolPolicyError("principal-scope", "当前角色不在工具授权范围");
  if (call.projectId !== context.projectId) throw new AiToolPolicyError("project-scope", "工具调用不能跨项目访问资源");
  if (!Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs <= 0) throw new AiToolPolicyError("invalid-arguments", "工具超时策略无效");
  if (!isPlainRecord(call.arguments) || !Array.isArray(call.resources) || call.resources.length > 256) throw new AiToolPolicyError("invalid-arguments", "工具参数或资源清单结构无效");
  let serialized: string;
  try { serialized = JSON.stringify({ arguments: call.arguments, resources: call.resources }); }
  catch { throw new AiToolPolicyError("invalid-arguments", "工具参数必须可安全序列化"); }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > (policy.maxInputBytes ?? 64 * 1024)) throw new AiToolPolicyError("invalid-arguments", "工具参数超过允许大小");
  const allowedKeys = new Set(policy.allowedArgumentKeys);
  const unknownKeys = Object.keys(call.arguments).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) throw new AiToolPolicyError("invalid-arguments", `工具包含未声明参数：${unknownKeys.join(", ")}`);
  validateSafeValue(call.arguments);
  const allowedKinds = new Set(policy.allowedResourceKinds);
  for (const resource of call.resources) {
    if (!allowedKinds.has(resource.kind)) throw new AiToolPolicyError("resource-scope", `资源类型 ${resource.kind} 不在工具授权范围`);
    if ((resource.projectId ?? call.projectId) !== context.projectId) throw new AiToolPolicyError("project-scope", "工具资源不能跨项目访问");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(resource.id) || resource.id.includes("..")) throw new AiToolPolicyError("resource-scope", "资源标识不合法");
  }
  if (needsApproval(policy)) validateApproval(call, context);
}

/**
 * 工具执行器统一处理审批、资源范围、超时、降级和审计。写入/控制类工具始终失败关闭，
 * 只有低中风险读取或分析工具允许显式提供回退实现。
 */
export async function executeReliableAiTool<T>(input: {
  call: AiToolCall;
  policy: AiToolPolicy;
  context: AiToolExecutionContext;
  execute: (signal: AbortSignal) => Promise<T>;
  fallback?: (failure: Error) => Promise<T> | T;
}): Promise<AiToolExecutionResult<T>> {
  const { call, policy, context } = input;
  const resourceFingerprints = call.resources.map((resource) => auditFingerprint(resource));
  const tool = { id: call.toolId, risk: policy.risk, resourceFingerprints };
  try { validateAiToolCall(call, policy, context); }
  catch (error) {
    const failure = error instanceof AiToolPolicyError ? error : new AiToolPolicyError("invalid-arguments", safeErrorMessage(error));
    const denied = createAiAuditEvent({ traceId: context.traceId, stage: "tool-decision", outcome: "denied", principal: context.principal, projectId: context.projectId, tool, inputFingerprint: aiToolScopeFingerprint(call), failure: { code: failure.code, message: failure.message, retryable: false }, ...(context.now ? { now: context.now } : {}) });
    await emitAiAudit(context.audit, denied);
    throw failure;
  }
  const decision = createAiAuditEvent({ traceId: context.traceId, stage: "tool-decision", outcome: "allowed", principal: context.principal, projectId: context.projectId, tool, inputFingerprint: aiToolScopeFingerprint(call), ...(context.now ? { now: context.now } : {}) });
  await emitAiAudit(context.audit, decision, needsDurableAudit(policy));

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(context.signal?.reason);
  if (context.signal?.aborted) abortFromCaller();
  else context.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error(`AI 工具调用超时（${policy.timeoutMs}ms）`)), policy.timeoutMs);
  try {
    const value = await Promise.race([input.execute(controller.signal), abortPromise(controller.signal)]);
    const audit = createAiAuditEvent({ traceId: context.traceId, stage: "tool-result", outcome: "completed", principal: context.principal, projectId: context.projectId, tool, inputFingerprint: aiToolScopeFingerprint(call), ...(context.now ? { now: context.now } : {}) });
    await emitAiAudit(context.audit, audit, needsDurableAudit(policy));
    return { value, degraded: false, audit };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const callerCancelled = Boolean(context.signal?.aborted);
    if (!callerCancelled && input.fallback && allowsFallback(policy)) {
      try {
        const value = await input.fallback(failure);
        const audit = createAiAuditEvent({ traceId: context.traceId, stage: "tool-result", outcome: "degraded", principal: context.principal, projectId: context.projectId, tool, inputFingerprint: aiToolScopeFingerprint(call), failure: { code: "primary-failed", message: safeErrorMessage(failure), retryable: true }, ...(context.now ? { now: context.now } : {}) });
        await emitAiAudit(context.audit, audit);
        return { value, degraded: true, fallbackReason: safeErrorMessage(failure), audit };
      } catch (fallbackError) {
        const audit = createAiAuditEvent({ traceId: context.traceId, stage: "tool-result", outcome: "failed", principal: context.principal, projectId: context.projectId, tool, inputFingerprint: aiToolScopeFingerprint(call), failure: { code: "fallback-failed", message: safeErrorMessage(fallbackError), retryable: true }, ...(context.now ? { now: context.now } : {}) });
        await emitAiAudit(context.audit, audit);
        throw fallbackError;
      }
    }
    const outcome = callerCancelled ? "cancelled" : "failed";
    const audit = createAiAuditEvent({ traceId: context.traceId, stage: "tool-result", outcome, principal: context.principal, projectId: context.projectId, tool, inputFingerprint: aiToolScopeFingerprint(call), failure: { code: callerCancelled ? "cancelled" : controller.signal.aborted ? "timeout" : "provider-failed", message: safeErrorMessage(failure), retryable: !callerCancelled }, ...(context.now ? { now: context.now } : {}) });
    await emitAiAudit(context.audit, audit, needsDurableAudit(policy));
    throw failure;
  } finally {
    clearTimeout(timeout);
    context.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function validateApproval(call: AiToolCall, context: AiToolExecutionContext): void {
  const approval = call.approval;
  if (!approval?.approvedBy.trim() || approval.scopeFingerprint !== aiToolScopeFingerprint(call)) throw new AiToolPolicyError("approval-required", "工具调用需要与当前参数完全匹配的审批");
  const approvedAt = Date.parse(approval.approvedAt);
  const now = (context.now?.() ?? new Date()).getTime();
  if (!Number.isFinite(approvedAt) || approvedAt > now + 60_000 || now - approvedAt > 15 * 60_000) throw new AiToolPolicyError("approval-required", "工具审批已过期或时间无效");
}

function validateSafeValue(value: unknown, depth = 0): void {
  if (depth > 12) throw new AiToolPolicyError("invalid-arguments", "工具参数嵌套过深");
  if (!value || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new AiToolPolicyError("invalid-arguments", "工具参数包含非有限数值");
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new AiToolPolicyError("invalid-arguments", "工具参数包含危险对象键");
    validateSafeValue(item, depth + 1);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function needsApproval(policy: AiToolPolicy): boolean { return policy.requiresApproval ?? ["high", "critical"].includes(policy.risk); }
function needsDurableAudit(policy: AiToolPolicy): boolean { return ["high", "critical"].includes(policy.risk); }
function allowsFallback(policy: AiToolPolicy): boolean { return policy.risk === "low" || policy.risk === "medium"; }
function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error("AI 工具调用已取消"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

export { AI_RELIABILITY_POLICY_VERSION };
