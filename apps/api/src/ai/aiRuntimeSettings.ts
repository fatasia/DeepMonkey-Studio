import type { AiProviderSettings } from "@bim-studio/contracts";
import type { MetadataStore } from "../store.js";
import type { AiRuntimeSettings } from "./assistantService.js";

/** 合并持久化设置与环境变量；密钥只在服务端运行时出现。 */
export function resolveAiSettings(store?: Pick<MetadataStore, "getAiSettings">): AiRuntimeSettings {
  const saved = store?.getAiSettings();
  return {
    providerId: saved?.providerId || process.env.AI_PROVIDER_ID || "ai.openai-compatible",
    baseUrl: saved?.baseUrl || process.env.AI_BASE_URL || "https://api.openai.com/v1",
    model: saved?.model || process.env.AI_MODEL || "gpt-4.1-mini",
    protocol: normalizeAiProtocol(saved?.protocol || process.env.AI_PROTOCOL),
    apiKey: saved?.apiKey || process.env.AI_API_KEY || "",
    temperature: saved?.temperature ?? Number(process.env.AI_TEMPERATURE ?? 0.2),
    ...(saved?.updatedAt ? { updatedAt: saved.updatedAt } : {})
  };
}

export function publicAiSettings(settings: AiRuntimeSettings): AiProviderSettings {
  return {
    providerId: settings.providerId, baseUrl: settings.baseUrl, model: settings.model,
    protocol: settings.protocol, temperature: settings.temperature, apiKeyConfigured: Boolean(settings.apiKey),
    ...(settings.updatedAt ? { updatedAt: settings.updatedAt } : {})
  };
}

/** 合并管理页草案；测试连接可使用未保存配置，但不会把密钥写入存储。 */
export function mergeAiSettingsDraft(
  current: AiRuntimeSettings,
  draft: Partial<AiProviderSettings>,
): AiRuntimeSettings {
  const baseUrl = draft.baseUrl?.trim() || current.baseUrl;
  new URL(baseUrl);
  const providerId = draft.providerId?.trim() || current.providerId;
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const credentialContextChanged = providerId !== current.providerId || normalizedBaseUrl !== current.baseUrl;
  const temperature = Number(draft.temperature ?? current.temperature);
  return {
    providerId,
    baseUrl: normalizedBaseUrl,
    model: draft.model?.trim() || current.model,
    protocol: normalizeAiProtocol(draft.protocol ?? current.protocol),
    apiKey: draft.apiKey?.trim() || (credentialContextChanged ? "" : current.apiKey),
    temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : current.temperature,
    ...(current.updatedAt ? { updatedAt: current.updatedAt } : {}),
  };
}

export function normalizeAiProtocol(value: unknown): AiProviderSettings["protocol"] {
  return value === "responses" || value === "chat-completions" ? value : "auto";
}
