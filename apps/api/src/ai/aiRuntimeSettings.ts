import type { AiFailoverSettings, AiModelProviderSettings, AiProviderSettings } from "@bim-studio/contracts";
import type { MetadataStore } from "../store.js";
import type { AiRuntimeFailoverSettings, AiRuntimeSettings } from "./assistantService.js";

/** 合并持久化设置与环境变量；密钥只在服务端运行时出现。备用模型档遵循 saved > env > default。 */
export function resolveAiSettings(store?: Pick<MetadataStore, "getAiSettings">): AiRuntimeSettings {
  const saved = store?.getAiSettings();
  return {
    providerId: saved?.providerId || process.env.AI_PROVIDER_ID || "ai.openai-compatible",
    baseUrl: saved?.baseUrl || process.env.AI_BASE_URL || "https://api.openai.com/v1",
    model: saved?.model || process.env.AI_MODEL || "gpt-4.1-mini",
    protocol: normalizeAiProtocol(saved?.protocol || process.env.AI_PROTOCOL),
    apiKey: saved?.apiKey || process.env.AI_API_KEY || "",
    temperature: saved?.temperature ?? Number(process.env.AI_TEMPERATURE ?? 0.2),
    ...normalizeReasoningEffort(saved?.reasoningEffort ?? process.env.AI_REASONING_EFFORT),
    failover: resolveFailoverSettings(saved?.failover, saved?.providerId || process.env.AI_PROVIDER_ID || "ai.openai-compatible"),
    ...(saved?.modeling3d ? { modeling3d: mergeModeling3dSettings(undefined, saved.modeling3d) } : {}),
    ...(saved?.updatedAt ? { updatedAt: saved.updatedAt } : {})
  };
}

/** 思考深度：minimal/standard/deep 之外的取值一律拒绝；未配置时不输出该字段（保持历史默认行为）。 */
function normalizeReasoningEffort(value: unknown): { reasoningEffort?: "minimal" | "standard" | "deep" } {
  return value === "minimal" || value === "standard" || value === "deep" ? { reasoningEffort: value } : {};
}

/** 备用模型接入：AI_FALLBACK_BASE_URL / AI_FALLBACK_API_KEY / AI_FALLBACK_MODEL / AI_FALLBACK_PROTOCOL；saved 逐字段覆盖。 */
function resolveFailoverSettings(saved: AiFailoverSettings | undefined, primaryProviderId: string): AiRuntimeFailoverSettings {
  const envEnabled = process.env.AI_FAILOVER_ENABLED;
  const enabled = saved?.enabled ?? (envEnabled === undefined ? true : !["false", "0", "off"].includes(envEnabled.trim().toLowerCase()));
  return {
    enabled,
    providerId: saved?.providerId || process.env.AI_FALLBACK_PROVIDER_ID || primaryProviderId,
    baseUrl: (saved?.baseUrl || process.env.AI_FALLBACK_BASE_URL || "").replace(/\/$/, ""),
    model: saved?.model || process.env.AI_FALLBACK_MODEL || "",
    protocol: normalizeAiProtocol(saved?.protocol || process.env.AI_FALLBACK_PROTOCOL),
    apiKey: saved?.apiKey || process.env.AI_FALLBACK_API_KEY || "",
  };
}

export function publicAiSettings(settings: AiRuntimeSettings): AiProviderSettings {
  return {
    providerId: settings.providerId, baseUrl: settings.baseUrl, model: settings.model,
    protocol: settings.protocol, temperature: settings.temperature, apiKeyConfigured: Boolean(settings.apiKey),
    ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
    ...(settings.failover ? { failover: publicFailoverSettings(settings.failover) } : {}),
    ...(settings.modeling3d ? { modeling3d: publicModeling3dSettings(settings.modeling3d) } : {}),
    ...(settings.updatedAt ? { updatedAt: settings.updatedAt } : {})
  };
}

function publicFailoverSettings(settings: AiRuntimeFailoverSettings): AiFailoverSettings {
  const { apiKey: _apiKey, ...safe } = settings;
  return { ...safe, apiKeyConfigured: Boolean(settings.apiKey) };
}

/** 合并管理页草案；测试连接可使用未保存配置，但不会把密钥写入存储。未知字段一律拒绝（fail-closed）。 */
export function mergeAiSettingsDraft(
  current: AiRuntimeSettings,
  draft: Partial<AiProviderSettings>,
): AiRuntimeSettings {
  const baseUrl = draft.baseUrl?.trim() || current.baseUrl;
  new URL(baseUrl);
  const failoverDraft = draft.failover;
  if (failoverDraft?.baseUrl?.trim()) new URL(failoverDraft.baseUrl.trim());
  const providerId = draft.providerId?.trim() || current.providerId;
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const credentialContextChanged = providerId !== current.providerId || normalizedBaseUrl !== current.baseUrl;
  const temperature = Number(draft.temperature ?? current.temperature);
  const mergedProtocol = normalizeAiProtocol(draft.protocol ?? current.protocol);
  return {
    providerId,
    baseUrl: normalizedBaseUrl,
    model: draft.model?.trim() || current.model,
    protocol: mergedProtocol,
    apiKey: draft.apiKey?.trim() || (credentialContextChanged ? "" : current.apiKey),
    temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : current.temperature,
    ...normalizeReasoningEffort(draft.reasoningEffort !== undefined ? draft.reasoningEffort : current.reasoningEffort),
    ...(failoverDraft || current.failover ? { failover: mergeFailoverDraft(current.failover, failoverDraft, mergedProtocol) } : {}),
    ...(draft.modeling3d || current.modeling3d
      ? { modeling3d: mergeModeling3dSettings(current.modeling3d, draft.modeling3d) }
      : {}),
    ...(current.updatedAt ? { updatedAt: current.updatedAt } : {}),
  };
}

/**
 * 备用档草案合并：providerId 不从面板持久化（运行时由 env 或主配置推导）；
 * 协议始终跟随主配置协议（UI 明示“跟随上方接口协议设置”）。
 */
function mergeFailoverDraft(
  current: AiRuntimeFailoverSettings | undefined,
  draft: Partial<AiFailoverSettings> | undefined,
  primaryProtocol: AiProviderSettings["protocol"],
): AiRuntimeFailoverSettings {
  const baseUrl = draft?.baseUrl?.trim() || current?.baseUrl || "";
  const model = draft?.model?.trim() || current?.model || "";
  const credentialContextChanged = normalized(baseUrl) !== normalized(current?.baseUrl)
    || model !== (current?.model ?? "");
  const apiKey = draft?.apiKey?.trim() || (credentialContextChanged ? "" : current?.apiKey || "");
  return {
    enabled: draft?.enabled ?? current?.enabled ?? true,
    providerId: "",
    baseUrl: normalized(baseUrl),
    model,
    protocol: normalizeAiProtocol(draft?.protocol ?? primaryProtocol),
    apiKey,
  };
}

function normalized(baseUrl: string | undefined): string {
  return (baseUrl ?? "").replace(/\/$/, "");
}

export function normalizeAiProtocol(value: unknown): AiProviderSettings["protocol"] {
  return value === "responses" || value === "chat-completions" ? value : "auto";
}

const MODELING_3D_DEFAULTS = {
  tripo3d: {
    providerId: "ai.tripo3d",
    baseUrl: "https://openapi.tripo3d.ai",
    model: "tripo-3d",
    protocol: "auto" as const,
  },
  tencentHunyuan: {
    providerId: "ai.tencent-hunyuan-3d",
    baseUrl: "https://ai3d.tencentcloudapi.com",
    model: "3.1",
    protocol: "auto" as const,
    region: "ap-guangzhou",
  },
};

function mergeModeling3dSettings(
  current: AiProviderSettings["modeling3d"] | undefined,
  draft: AiProviderSettings["modeling3d"] | undefined,
): NonNullable<AiProviderSettings["modeling3d"]> {
  return {
    tripo3d: mergeModeling3dProvider(current?.tripo3d, draft?.tripo3d, MODELING_3D_DEFAULTS.tripo3d),
    tencentHunyuan: mergeModeling3dProvider(current?.tencentHunyuan, draft?.tencentHunyuan, MODELING_3D_DEFAULTS.tencentHunyuan),
  };
}

function mergeModeling3dProvider(
  current: AiModelProviderSettings | undefined,
  draft: AiModelProviderSettings | undefined,
  defaults: Omit<AiModelProviderSettings, "apiKey" | "apiKeyConfigured">,
): AiModelProviderSettings {
  const providerId = draft?.providerId?.trim() || current?.providerId || defaults.providerId;
  const baseUrl = draft?.baseUrl?.trim() || current?.baseUrl || defaults.baseUrl;
  const model = draft?.model?.trim() || current?.model || defaults.model;
  const apiKey = draft?.apiKey?.trim() || current?.apiKey;
  const secretId = draft?.secretId?.trim() || current?.secretId;
  const region = draft?.region?.trim() || current?.region || defaults.region;
  return {
    providerId,
    baseUrl: baseUrl.replace(/\/$/, ""),
    model,
    protocol: normalizeAiProtocol(draft?.protocol ?? current?.protocol ?? defaults.protocol),
    ...(apiKey ? { apiKey } : {}),
    ...(secretId ? { secretId } : {}),
    ...(region ? { region } : {}),
  };
}

function publicModeling3dSettings(
  settings: NonNullable<AiRuntimeSettings["modeling3d"]>,
): NonNullable<AiProviderSettings["modeling3d"]> {
  return {
    tripo3d: publicModeling3dProvider(settings.tripo3d),
    tencentHunyuan: publicModeling3dProvider(settings.tencentHunyuan),
  };
}

function publicModeling3dProvider(settings: AiModelProviderSettings): AiModelProviderSettings {
  const { apiKey: _apiKey, secretId: _secretId, ...safe } = settings;
  return { ...safe, apiKeyConfigured: Boolean(settings.apiKey), secretIdConfigured: Boolean(settings.secretId) };
}
