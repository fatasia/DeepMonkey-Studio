import { describe, expect, it } from "vitest";
import { PluginRegistry } from "@bim-studio/plugin-runtime";
import { createAlarmRcaProvider, registerAlarmRcaPlugin } from "./alarmRcaPlugin.js";
import { thermalAlarmRcaCase as thermalCase } from "./alarmRcaTestFixtures.js";

describe("alarm RCA capability plugin", () => {
  it("publishes trace evidence and confirmation-only work-order action", async () => {
    const provider = createAlarmRcaProvider();
    const result = await provider.invoke({ requestId: "rca-1", projectId: "project-1", principal: "engineer", input: thermalCase() }, {
      pluginId: "test", pluginVersion: "1.0.0", descriptor: provider.descriptor, signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "completed", decisionStatus: "research-candidate",
      evidence: [expect.objectContaining({ kind: "trace", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })],
      suggestedActions: [expect.objectContaining({ commandType: "maintenance.work-order.create-draft", risk: "medium", requiresConfirmation: true })],
    });
    expect(result.suggestedActions?.map((item) => item.commandType)).not.toContain(expect.stringContaining("close"));
  });

  it("registers as an optional deterministic capability without an AI provider", async () => {
    const registry = new PluginRegistry({
      apiVersion: "1.0", sceneApiVersion: "1.0", host: "cloud", renderer: "webgl2",
      capabilities: ["industrial.ai.alarm-rca"], permissions: ["operations.read"], extensionPoints: ["capability.provider"], allowTrustedSceneExtensions: false,
    });
    await registerAlarmRcaPlugin(registry);
    expect(registry.getCapability("industrial.ai.alarm-rca.compose")).toMatchObject({ kind: "analysis", permissions: ["operations.read"] });
    const result = await registry.invokeCapability("industrial.ai.alarm-rca.compose", {
      requestId: "rca-registry", projectId: "project-1", principal: "engineer", input: thermalCase(),
    });
    expect(result).toMatchObject({ status: "completed", output: { generatedBy: "deterministic-alarm-rca" } });
  });
});
