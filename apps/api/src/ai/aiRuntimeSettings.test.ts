import { describe, expect, it } from "vitest";
import type { AiRuntimeSettings } from "./assistantService";
import { mergeAiSettingsDraft, publicAiSettings } from "./aiRuntimeSettings";

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
