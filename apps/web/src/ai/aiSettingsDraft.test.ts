import { describe, expect, it } from "vitest";
import type { AiProviderSettings, AiTelemetrySummary } from "@bim-studio/contracts";
import {
  buildAiSettingsPayload,
  describeFailoverCategory,
  describeModelCatalogFailure,
  describeServedSummary,
} from "./aiSettingsDraft";

const t = (zh: string, en: string) => zh;

function telemetry(records: AiTelemetrySummary["records"]): AiTelemetrySummary {
  return { generatedAt: "2026-09-20T00:00:00.000Z", limit: 50, records, totals: { completed: records.length, failed: 0, cancelled: 0, fallbackServed: 0 } };
}

function record(overrides: Partial<AiTelemetrySummary["records"][number]> = {}): AiTelemetrySummary["records"][number] {
  return {
    id: "r1", occurredAt: "2026-09-20T00:00:00.000Z", source: "assistant", providerId: "ai.openai-compatible",
    model: "gpt-5.5", servedBy: "primary", status: "completed", latencyMs: 100, ...overrides,
  };
}

describe("AI settings draft payload", () => {
  const initial = {
    providerId: "ai.openai-compatible", baseUrl: "https://moacode.test/v1", model: "gpt-5.5",
    protocol: "responses" as const, apiKeyConfigured: true, temperature: 0.2,
  };

  it("always carries the failover section and only includes typed secrets", () => {
    const payload = buildAiSettingsPayload({
      current: { providerId: initial.providerId, baseUrl: initial.baseUrl, model: "gpt-5.6", protocol: "responses", temperature: 0.2, apiKey: "  " },
      initial,
      reasoningEffort: "",
      failover: { enabled: false, baseUrl: " http://localhost:46037/v1 ", model: " gpt-5.6-sol ", apiKey: "  " },
    });
    expect(payload).toEqual({
      providerId: initial.providerId, baseUrl: initial.baseUrl, model: "gpt-5.6", protocol: "responses", temperature: 0.2,
      failover: { enabled: false, baseUrl: "http://localhost:46037/v1", model: "gpt-5.6-sol" },
    });
    expect(JSON.stringify(payload)).not.toContain("apiKey");
  });

  it("includes reasoning effort and typed keys only when provided", () => {
    const payload = buildAiSettingsPayload({
      current: { ...initial, apiKey: " sk-new " },
      initial,
      reasoningEffort: "deep",
      failover: { enabled: true, baseUrl: "http://localhost:46037/v1", model: "gpt-5.6-sol", apiKey: " fk " },
    });
    expect(payload.reasoningEffort).toBe("deep");
    expect(payload.apiKey).toBe("sk-new");
    expect(payload.failover).toMatchObject({ enabled: true, apiKey: "fk" });
  });

  it("describes model catalog failures by category", () => {
    expect(describeModelCatalogFailure("auth", "HTTP 401", t)).toContain("鉴权失败");
    expect(describeModelCatalogFailure("unsupported", "没有 /models", t)).toContain("服务不支持模型列表");
    expect(describeModelCatalogFailure("network", "fetch failed", t)).toContain("网络错误");
  });

  it("summarizes the served provider and failover category for display", () => {
    expect(describeServedSummary(telemetry([record()]), "gpt-5.6-sol", t)).toContain("主模型 gpt-5.5");
    expect(describeServedSummary(telemetry([record({ servedBy: "fallback", model: "gpt-5.6-sol" })]), undefined, t)).toContain("备用模型 gpt-5.6-sol");
    expect(describeServedSummary(telemetry([]), undefined, t)).toBeUndefined();
    expect(describeFailoverCategory("rate-limit", t)).toBe("请求限流 (rate limited)");
  });
});
