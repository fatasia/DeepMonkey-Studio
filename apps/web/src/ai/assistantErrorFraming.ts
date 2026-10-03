import { ServerRequestError } from "@bim-studio/server-sdk";
import { translate, type AppLocale } from "../i18n";
import { AI_FAILOVER_CATEGORY_LABELS } from "./aiSettingsDraft";

/**
 * K15/K16:chat/agent 失败的用户面分型与本地化。
 * 同类错误给同一恢复动作;浏览器/服务端英文原文不直接透传给用户
 * (细节保留在开发者日志域)。分型复用 AI_FAILOVER_CATEGORY_LABELS 的十类口径,
 * 与管理端 failover 遥测同一套词表。
 */
export type AssistantErrorCategory = keyof typeof AI_FAILOVER_CATEGORY_LABELS;

export function classifyAssistantError(reason: unknown): AssistantErrorCategory {
  if (reason instanceof ServerRequestError) {
    if (reason.status === 401 || reason.status === 403) return "auth";
    if (reason.status === 429) return "rate-limit";
    if (reason.status >= 500) return "server";
    if (reason.status >= 400) return "invalid";
    return "unknown";
  }
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/AI 响应超时/.test(message)) return "timeout";
  if (/额度不足|quota exhausted/i.test(message)) return "quota";
  if (/内容策略|content policy/i.test(message)) return "policy";
  if (reason instanceof TypeError || /failed to fetch|networkerror|load failed|网络错误/i.test(message)) return "network";
  if (/请求无效|invalid request/i.test(message)) return "invalid";
  if (/服务端错误|server error/i.test(message)) return "server";
  return "unknown";
}

export function assistantErrorMessage(reason: unknown, locale: AppLocale): string {
  const t = (zh: string, en: string) => translate(locale, zh, en);
  const detail = reason instanceof Error ? reason.message : String(reason);
  switch (classifyAssistantError(reason)) {
    case "network":
      return t("无法连接 AI 服务，请检查网络后从失败条目重试。", "Cannot reach the AI service. Check your connection, then retry from the failed entry.");
    case "timeout":
      // K9 超时文案本身已本地化并带恢复动作,原样透传。
      return detail;
    case "auth":
      return t("AI 提供方鉴权失败：请在系统设置的 AI 服务里检查密钥配置。", "AI provider authentication failed: check the key configuration under system AI settings.");
    case "quota":
      return t("AI 服务额度不足：请稍后重试，或联系管理员调整配额。", "AI service quota exhausted: retry later, or ask an administrator to adjust the quota.");
    case "rate-limit":
      return t("请求过于频繁：请稍等片刻再重试。", "Requests are being throttled: wait a moment and retry.");
    case "server":
      return t("AI 服务暂时不可用，请稍后从失败条目重试。", "The AI service is temporarily unavailable. Retry from the failed entry later.");
    case "policy":
      return t("请求被内容策略拒绝：请调整提问内容后重试。", "The request was rejected by content policy: adjust the prompt and retry.");
    case "invalid":
      return t("请求无效：请修改提问或上下文后重试。", "The request was invalid: revise the prompt or context and retry.");
    default:
      return detail || t("请求未完成，请从失败条目重试。", "The request did not complete. Retry from the failed entry.");
  }
}
