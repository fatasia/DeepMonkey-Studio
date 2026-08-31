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
});
