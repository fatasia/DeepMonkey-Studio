import type { AiProviderSettings, AiTelemetrySummary } from "@bim-studio/contracts";

export type AiReasoningEffortChoice = "" | "minimal" | "standard" | "deep";

/** 管理页 AI 设置草案 → 保存/测试请求体；密钥仅在用户输入时携带，空白与未选择项绝不写入。 */
export function buildAiSettingsPayload(input: {
  current: { providerId: string; baseUrl: string; model: string; protocol: AiProviderSettings["protocol"]; temperature: number; apiKey: string };
  initial: AiProviderSettings;
  reasoningEffort: AiReasoningEffortChoice;
  failover: { enabled: boolean; baseUrl: string; model: string; apiKey: string };
}): Partial<AiProviderSettings> & { failover: { enabled: boolean; baseUrl: string; model: string; apiKey?: string } } {
  const apiKey = input.current.apiKey.trim();
  const failoverApiKey = input.failover.apiKey.trim();
  return {
    providerId: input.current.providerId,
    baseUrl: input.current.baseUrl,
    model: input.current.model,
    protocol: input.current.protocol,
    temperature: input.current.temperature,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    failover: {
      enabled: input.failover.enabled,
      baseUrl: input.failover.baseUrl.trim(),
      model: input.failover.model.trim(),
      ...(failoverApiKey ? { apiKey: failoverApiKey } : {}),
    },
    ...(apiKey ? { apiKey } : {}),
  };
}

const MODEL_CATALOG_LABELS: Record<string, { zh: string; en: string }> = {
  auth: { zh: "鉴权失败", en: "Authentication" },
  network: { zh: "网络错误", en: "Network" },
  unsupported: { zh: "服务不支持模型列表", en: "Model catalog not supported" },
  server: { zh: "服务端错误", en: "Server error" },
  invalid: { zh: "配置无效", en: "Invalid configuration" },
};

/** 模型目录拉取失败分档文案；服务端 message 为中文细节，标签按界面语言渲染。 */
export function describeModelCatalogFailure(category: string, message: string, t: (zh: string, en: string) => string): string {
  const label = MODEL_CATALOG_LABELS[category] ?? { zh: "未知错误", en: "Unknown error" };
  return `${t("拉取模型列表失败", "Failed to list models")}（${t(label.zh, label.en)}）：${message}`;
}

/** 遥测：当前生效提供方一行摘要（无记录时返回 undefined，界面保持安静）。 */
export function describeServedSummary(telemetry: AiTelemetrySummary, fallbackModel: string | undefined, t: (zh: string, en: string) => string): string | undefined {
  const latest = telemetry.records.at(-1);
  if (!latest) return undefined;
  if (latest.servedBy === "fallback") {
    return t(`最近请求由备用模型 ${latest.model} 服务`, `Latest request served by fallback model ${latest.model}`);
  }
  return t(
    `当前生效：主模型 ${latest.model}${fallbackModel ? `（备用 ${fallbackModel} 待命）` : ""}`,
    `Active: primary ${latest.model}${fallbackModel ? ` (fallback ${fallbackModel} on standby)` : ""}`,
  );
}

export function describeFailoverCategory(category: string, t: (zh: string, en: string) => string): string {
  const label = AI_FAILOVER_CATEGORY_LABELS[category] ?? { zh: "未知错误", en: "unknown" };
  return `${label.zh} (${label.en})`;
}

export const AI_FAILOVER_CATEGORY_LABELS: Record<string, { zh: string; en: string }> = {
  auth: { zh: "鉴权失败", en: "authentication" },
  quota: { zh: "额度不足", en: "quota exhausted" },
  "rate-limit": { zh: "请求限流", en: "rate limited" },
  server: { zh: "服务端错误", en: "server error" },
  timeout: { zh: "请求超时", en: "timeout" },
  network: { zh: "网络错误", en: "network error" },
  policy: { zh: "内容策略", en: "content policy" },
  invalid: { zh: "请求无效", en: "invalid request" },
  cancelled: { zh: "已取消", en: "cancelled" },
  unknown: { zh: "未知错误", en: "unknown" },
};
