import { describe, expect, it } from "vitest";
import { PluginRegistry } from "@bim-studio/plugin-runtime";
import { PARAMETRIC_CAD_TEMPLATES } from "@bim-studio/parametric-modeling-plugin";
import { registerParametricAiPlugin } from "./registerParametricAiPlugin.js";

describe("parametric AI plugin", () => {
  it("accepts only a validated DSL draft from a replaceable AI provider", async () => {
    const registry = registryHost();
    await registerFakeAi(registry, JSON.stringify(PARAMETRIC_CAD_TEMPLATES[1]!.definition));
    await registerParametricAiPlugin(registry, () => ({
      providerId: "ai.test", baseUrl: "https://example.test/v1", apiKey: "test-key", model: "test-model",
      protocol: "responses", temperature: 0.2
    }));

    const result = await registry.invokeCapability("modeling.parametric.draft", {
      requestId: "draft-1", projectId: "project-1", principal: "engineer", input: { prompt: "生成传感器 L 型支架" }
    });
    expect(result).toMatchObject({
      status: "completed", decisionStatus: "research-candidate",
      output: { definition: { name: "传感器 L 型支架" }, providerId: "ai.test", model: "test-model" },
      evidence: expect.arrayContaining([expect.objectContaining({ kind: "rule", source: "bim.parametric-modeling" })])
    });
  });

  it("returns a recoverable result when the model output fails the DSL contract", async () => {
    const registry = registryHost();
    await registerFakeAi(registry, "not-json");
    await registerParametricAiPlugin(registry, () => ({
      providerId: "ai.test", baseUrl: "https://example.test/v1", apiKey: "test-key", model: "test-model",
      protocol: "responses", temperature: 0.2
    }));
    const result = await registry.invokeCapability("modeling.parametric.draft", {
      requestId: "draft-invalid", projectId: "project-1", principal: "engineer", input: { prompt: "生成支架" }
    });
    expect(result).toMatchObject({
      status: "needs-input", decisionStatus: "insufficient-data",
      evidence: expect.arrayContaining([expect.objectContaining({ id: "ai-reliability:draft-invalid" })]),
      warnings: [expect.stringContaining("未通过受限参数化合同")],
    });
  });
});

function registryHost(): PluginRegistry {
  return new PluginRegistry({
    apiVersion: "1.0", sceneApiVersion: "1.0", host: "cloud", renderer: "webgl2",
    capabilities: ["ai.provider", "modeling.parametric.ai"], permissions: ["ai.invoke", "modeling.write"],
    extensionPoints: ["ai.provider", "capability.provider"], allowTrustedSceneExtensions: false
  });
}

async function registerFakeAi(registry: PluginRegistry, response: string): Promise<void> {
  const registered = registry.register({
    schemaVersion: 1, id: "test.ai", name: "Test AI", version: "1.0.0", apiVersion: "1.0", hosts: ["cloud"],
    capabilities: ["ai.provider"], permissions: ["ai.invoke"],
    extensionPoints: [{ kind: "ai.provider", id: "test.ai-runtime", providerIds: ["ai.test"], execution: "in-process", limits: { timeoutMs: 1_000, maxInputBytes: 100_000, memoryMb: 32 } }]
  }, ({ registerAiProvider }) => {
    registerAiProvider({
      descriptor: { id: "ai.test", version: "1.0.0", label: "Test AI", execution: "in-process", permissions: ["ai.invoke"], streaming: false, timeoutMs: 1_000 },
      async complete(request) { return { text: response, model: request.model }; }
    });
  });
  if (!registered.ok) throw new Error(registered.message);
  await registry.enable("test.ai");
}
