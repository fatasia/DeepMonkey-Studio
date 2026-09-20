import { AiProviderHttpError } from "./openAiCompatibleProvider.js";
import type { AiFailureCategory } from "@bim-studio/contracts";

export interface AiProviderFailureClassification {
  category: AiFailureCategory;
  /** 只有额度、限流、服务端、超时、网络类错误才允许切换备用模型。 */
  failoverEligible: boolean;
  message: string;
}

export interface AiFailoverTarget {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: "auto" | "responses" | "chat-completions";
}

export interface AiFailoverAttempt<T> {
  result: T;
  servedBy: "primary" | "fallback";
  failover?: { category: AiFailureCategory; reason: string };
}

const TIMEOUT_PATTERNS = [/AI provider 调用超时/, /timed?[\s-]*out/i, /ETIMEDOUT/, /abort.{0,12}timeout/i];
const NETWORK_PATTERNS = [/fetch failed/i, /ECONNREFUSED/, /ECONNRESET/, /ENOTFOUND/, /EAI_AGAIN/, /network/i, /socket.*(hang|closed)/i, /terminated?/i];
const POLICY_PATTERNS = [/content[_\s-]?(policy|filter|management)/i, /内容政策/, /内容安全/, /safety system/i];
const CANCELLED_PATTERNS = [/已取消/, /aborted?/i, /operator cancelled/i];

/**
 * 大模型请求失败分类：401/403 属鉴权错误，必须原样精确报错，不做备用切换；
 * 400/404/422 等请求类错误换端点也不会好，同样不切换。
 */
export function classifyAiProviderError(error: unknown): AiProviderFailureClassification {
  if (error instanceof AiProviderHttpError) return classifyHttpStatus(error.status, error.message);
  const message = error instanceof Error ? error.message : String(error);
  if (matchesAny(message, POLICY_PATTERNS)) return { category: "policy", failoverEligible: false, message };
  if (matchesAny(message, TIMEOUT_PATTERNS)) return { category: "timeout", failoverEligible: true, message };
  if (matchesAny(message, CANCELLED_PATTERNS)) return { category: "cancelled", failoverEligible: false, message };
  if (matchesAny(message, NETWORK_PATTERNS)) return { category: "network", failoverEligible: true, message };
  return { category: "unknown", failoverEligible: false, message };
}

function classifyHttpStatus(status: number, message: string): AiProviderFailureClassification {
  const text = message || `HTTP ${status}`;
  if (status === 401 || status === 403) return { category: "auth", failoverEligible: false, message: text };
  if (status === 402) return { category: "quota", failoverEligible: true, message: text };
  if (status === 429) return { category: "rate-limit", failoverEligible: true, message: text };
  if (status === 408 || status >= 500) return { category: "server", failoverEligible: true, message: text };
  return { category: "invalid", failoverEligible: false, message: text };
}

/** 备用档是否真正可用：开关开启且端点、模型、密钥齐备。 */
export function resolveFailoverTarget(failover: AiFailoverTarget | undefined): AiFailoverTarget | undefined {
  if (!failover?.enabled) return undefined;
  if (!failover.baseUrl?.trim() || !failover.model?.trim() || !failover.apiKey?.trim()) return undefined;
  return failover;
}

/**
 * 主模型失败且属于可切换错误时，用备用配置重试一次；
 * 主路径成功时零额外开销（单次调用、无额外请求）。
 * 调用方取消（signal 已中止）永远不触发切换。
 */
export async function attemptWithFailover<T>(input: {
  failover: AiFailoverTarget | undefined;
  primary: () => Promise<T>;
  fallback: (target: AiFailoverTarget) => Promise<T>;
  signal?: AbortSignal;
}): Promise<AiFailoverAttempt<T>> {
  let originalError: unknown;
  let primaryError: AiProviderFailureClassification | undefined;
  try {
    const result = await input.primary();
    return { result, servedBy: "primary" };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    originalError = error;
    primaryError = classifyAiProviderError(error);
    if (!primaryError.failoverEligible) throw error;
  }
  // 未配置可用的备用档时必须原样重抛：保留错误类型、状态码与文案，调用方按原语义处理。
  const target = resolveFailoverTarget(input.failover);
  if (!target) throw originalError;
  try {
    const result = await input.fallback(target);
    return { result, servedBy: "fallback", failover: { category: primaryError.category, reason: primaryError.message } };
  } catch (fallbackError) {
    if (input.signal?.aborted) throw fallbackError;
    throw new Error(`主模型与备用模型均失败：主模型（${primaryError.category}）${primaryError.message}；备用模型${safeFallbackMessage(fallbackError)}`);
  }
}

function safeFallbackMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

function matchesAny(message: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}
