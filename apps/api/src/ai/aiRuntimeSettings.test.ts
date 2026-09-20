import { afterEach, describe, expect, it } from "vitest";
import type { AiRuntimeSettings } from "./assistantService";
import { mergeAiSettingsDraft, publicAiSettings, resolveAiSettings } from "./aiRuntimeSettings";

const current: AiRuntimeSettings = {
  providerId: "ai.openai-compatible",
  baseUrl: "https://api.example.com/v1",
  model: "model-a",
  protocol: "auto",
  apiKey: "secret",
  temperature: 0.2,
};

describe("AI runtime settings", () => {
  it("requires a fresh secret when the provider or endpoint changes", () => {
    expect(
      mergeAiSettingsDraft(current, {
        providerId: "ai.private-provider",
        baseUrl: "https://private.example.com/",
        model: "model-b",
        temperature: 4,
      }),
    ).toMatchObject({
      providerId: "ai.private-provider",
      baseUrl: "https://private.example.com",
      model: "model-b",
      apiKey: "",
      temperature: 2,
    });
  });

  it("keeps the secret when only model parameters change", () => {
    expect(mergeAiSettingsDraft(current, { model: "model-b", temperature: 0.4 })).toMatchObject({
      model: "model-b",
      apiKey: "secret",
      temperature: 0.4,
    });
  });

  it("never exposes the runtime API key", () => {
    expect(publicAiSettings(current)).toEqual(
      expect.objectContaining({ apiKeyConfigured: true }),
    );
    expect(publicAiSettings(current)).not.toHaveProperty("apiKey");
  });

  it("persists separate 3D provider profiles without exposing either secret", () => {
    const merged = mergeAiSettingsDraft(current, {
      modeling3d: {
        tripo3d: {
          providerId: "ai.tripo3d",
          baseUrl: "https://openapi.tripo3d.ai/",
          model: "tripo-3d",
          protocol: "auto",
          apiKey: "tripo-secret",
        },
        tencentHunyuan: {
          providerId: "ai.tencent-hunyuan-3d",
          baseUrl: "https://ai3d.tencentcloudapi.com",
          model: "3.1",
          protocol: "auto",
          secretId: "hunyuan-secret-id",
          apiKey: "hunyuan-secret",
        },
      },
    });
    expect(merged.modeling3d).toMatchObject({
      tripo3d: { baseUrl: "https://openapi.tripo3d.ai", apiKey: "tripo-secret" },
      tencentHunyuan: { secretId: "hunyuan-secret-id", apiKey: "hunyuan-secret" },
    });
    const publicSettings = publicAiSettings(merged);
    expect(publicSettings.modeling3d).toMatchObject({
      tripo3d: { apiKeyConfigured: true },
      tencentHunyuan: { apiKeyConfigured: true, secretIdConfigured: true },
    });
    expect(publicSettings.modeling3d?.tripo3d).not.toHaveProperty("apiKey");
    expect(publicSettings.modeling3d?.tencentHunyuan).not.toHaveProperty("apiKey");
    expect(publicSettings.modeling3d?.tencentHunyuan).not.toHaveProperty("secretId");
  });
});

describe("AI failover settings contract", () => {
  const FALLBACK_ENV = {
    AI_FALLBACK_BASE_URL: "http://localhost:46037/v1",
    AI_FALLBACK_API_KEY: "fallback-secret",
    AI_FALLBACK_MODEL: "gpt-5.6-sol",
  };

  afterEach(() => {
    for (const key of [...Object.keys(FALLBACK_ENV), "AI_FAILOVER_ENABLED", "AI_REASONING_EFFORT"]) delete process.env[key];
  });

  it("merges AI_FALLBACK_* environment variables with failover enabled by default", () => {
    Object.assign(process.env, FALLBACK_ENV);
    const resolved = resolveAiSettings();
    expect(resolved.failover).toMatchObject({
      enabled: true,
      baseUrl: "http://localhost:46037/v1",
      model: "gpt-5.6-sol",
      apiKey: "fallback-secret",
      protocol: "auto",
    });
    expect(resolved.failover?.providerId).toBe(resolved.providerId);
  });

  it("lets AI_FAILOVER_ENABLED=false turn the policy off and saved settings override env per field", () => {
    Object.assign(process.env, FALLBACK_ENV, { AI_FAILOVER_ENABLED: "false" });
    expect(resolveAiSettings().failover).toMatchObject({ enabled: false });
    delete process.env.AI_FAILOVER_ENABLED;
    const saved = {
      failover: { enabled: true, providerId: "", baseUrl: "https://saved.test/v1", model: "", protocol: "auto" as const },
    };
    const resolved = resolveAiSettings({ getAiSettings: () => saved } as never);
    expect(resolved.failover).toMatchObject({
      enabled: true,
      baseUrl: "https://saved.test/v1",
      model: "gpt-5.6-sol",
      apiKey: "fallback-secret",
    });
  });

  it("never exposes the failover API key in public settings", () => {
    const settings: AiRuntimeSettings = {
      ...current,
      failover: { enabled: true, providerId: "ai.test", baseUrl: "https://fallback.test/v1", model: "m", protocol: "auto", apiKey: "fallback-secret" },
    };
    const publicSettings = publicAiSettings(settings);
    expect(publicSettings.failover).toMatchObject({ enabled: true, apiKeyConfigured: true });
    expect(publicSettings.failover).not.toHaveProperty("apiKey");
    expect(JSON.stringify(publicSettings)).not.toContain("fallback-secret");
  });

  it("keeps a disabled failover draft from erasing the stored key and rejects invalid URLs", () => {
    const withFailover: AiRuntimeSettings = {
      ...current,
      failover: { enabled: true, providerId: "ai.test", baseUrl: "https://fallback.test/v1", model: "m", protocol: "auto", apiKey: "stored-key" },
    };
    expect(mergeAiSettingsDraft(withFailover, { failover: { enabled: false } })).toMatchObject({
      failover: { enabled: false, baseUrl: "https://fallback.test/v1", apiKey: "stored-key" },
    });
    expect(() => mergeAiSettingsDraft(withFailover, { failover: { baseUrl: "not-a-url" } })).toThrow();
  });

  it("normalizes reasoning effort from saved settings and environment, rejecting other values", () => {
    expect(mergeAiSettingsDraft(current, { reasoningEffort: "deep" })).toMatchObject({ reasoningEffort: "deep" });
    expect(mergeAiSettingsDraft(current, { reasoningEffort: "extreme" as never }).reasoningEffort).toBeUndefined();
    process.env.AI_REASONING_EFFORT = "minimal";
    expect(resolveAiSettings()).toMatchObject({ reasoningEffort: "minimal" });
    process.env.AI_REASONING_EFFORT = "bogus";
    expect(resolveAiSettings().reasoningEffort).toBeUndefined();
  });
});
