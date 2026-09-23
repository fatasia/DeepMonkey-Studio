import { describe, expect, it, vi } from "vitest";
import { hostPolicy, pluginManifest } from "./fixtures.js";
import { PluginRegistry } from "./registry.js";

describe("PluginRegistry", () => {
  it("registers, enables, disables and uninstalls an already-installed plugin factory", async () => {
    const deactivate = vi.fn();
    const activate = vi.fn(() => ({ deactivate }));
    const registry = new PluginRegistry(hostPolicy());
    expect(registry.register(pluginManifest(), activate)).toMatchObject({ ok: true, plugin: { status: "registered" } });

    const enabled = await registry.enable("acme.factory-tools");
    expect(enabled).toMatchObject({ ok: true, plugin: { status: "enabled" } });
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: "acme.factory-tools",
      pluginVersion: "2.1.0",
      grantedCapabilities: ["studio.object", "converter.execute"],
      grantedPermissions: ["scene.read", "scene.write"]
    }));

    expect(await registry.disable("acme.factory-tools")).toMatchObject({ ok: true, plugin: { status: "registered" } });
    expect(deactivate).toHaveBeenCalledOnce();
    expect(await registry.uninstall("acme.factory-tools")).toEqual({ ok: true, code: "ok" });
    expect(registry.get("acme.factory-tools")).toBeUndefined();
  });

  it("never activates an incompatible registered plugin", async () => {
    const activate = vi.fn();
    const registry = new PluginRegistry(hostPolicy({ capabilities: ["studio.object"] }));
    expect(registry.register(pluginManifest(), activate)).toMatchObject({ ok: false, code: "incompatible" });
    expect(await registry.enable("acme.factory-tools")).toMatchObject({ ok: false, code: "incompatible" });
    expect(activate).not.toHaveBeenCalled();
  });

  it("isolates activation failure so another plugin still enables", async () => {
    const registry = new PluginRegistry(hostPolicy());
    registry.register(pluginManifest({ id: "acme.failing" }), () => { throw new Error("activation exploded"); });
    registry.register(pluginManifest({ id: "acme.healthy" }), () => ({ deactivate() {} }));
    const results = await registry.enableAll();
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ ok: false, code: "activation-failed", message: "activation exploded" }),
      expect.objectContaining({ ok: true, plugin: expect.objectContaining({ status: "enabled" }) })
    ]));
    expect(registry.get("acme.failing")).toMatchObject({ status: "faulted", diagnostics: [expect.objectContaining({ operation: "enable", message: "activation exploded" })] });
    expect(registry.get("acme.healthy")).toMatchObject({ status: "enabled" });
  });

  it("aborts before deactivation and contains uninstall cleanup failures", async () => {
    let observedAbort = false;
    const registry = new PluginRegistry(hostPolicy());
    registry.register(pluginManifest(), (context) => ({
      deactivate() {
        observedAbort = context.signal.aborted;
        throw new Error("cleanup exploded");
      }
    }));
    await registry.enable("acme.factory-tools");
    const result = await registry.uninstall("acme.factory-tools");
    expect(observedAbort).toBe(true);
    expect(result).toMatchObject({ ok: true, warning: { operation: "uninstall", message: "cleanup exploded" } });
    expect(registry.get("acme.factory-tools")).toBeUndefined();
  });

  it("rejects duplicate registration and returns defensive snapshots", () => {
    const registry = new PluginRegistry(hostPolicy());
    registry.register(pluginManifest(), () => undefined);
    expect(registry.register(pluginManifest(), () => undefined)).toMatchObject({ ok: false, code: "already-registered" });
    const copy = registry.get("acme.factory-tools")!;
    copy.manifest.name = "mutated";
    copy.diagnostics.push({ operation: "enable", message: "fake", timestamp: "now" });
    expect(registry.get("acme.factory-tools")).toMatchObject({ manifest: { name: "Factory tools" }, diagnostics: [] });
  });

  it("rejects concurrent enable/disable transitions without double activation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const activate = vi.fn(async () => { await gate; return { deactivate() {} }; });
    const registry = new PluginRegistry(hostPolicy());
    registry.register(pluginManifest(), activate);
    const first = registry.enable("acme.factory-tools");
    await Promise.resolve();
    await expect(registry.enable("acme.factory-tools")).resolves.toMatchObject({ ok: false, code: "invalid-state" });
    await expect(registry.disable("acme.factory-tools")).resolves.toMatchObject({ ok: false, code: "invalid-state" });
    release();
    await expect(first).resolves.toMatchObject({ ok: true, plugin: { status: "enabled" } });
    expect(activate).toHaveBeenCalledOnce();
  });

  it("cleans failed activation and permits a later retry", async () => {
    let attempts = 0;
    const registry = new PluginRegistry(hostPolicy());
    registry.register(pluginManifest(), () => {
      attempts += 1;
      if (attempts === 1) throw new Error("first activation failed");
      return { deactivate() {} };
    });
    await expect(registry.enable("acme.factory-tools")).resolves.toMatchObject({ ok: false, code: "activation-failed" });
    expect(registry.listCapabilities()).toEqual([]);
    await expect(registry.enable("acme.factory-tools")).resolves.toMatchObject({ ok: true, plugin: { status: "enabled" } });
    expect(attempts).toBe(2);
  });

  it("fails closed before activation when a declared capability is not supported", async () => {
    const activate = vi.fn();
    const registry = new PluginRegistry(hostPolicy({ capabilities: ["scene.read"] }));
    const result = registry.register(pluginManifest({ capabilities: ["scene.read", "converter.execute"] }), activate);
    expect(result).toMatchObject({ ok: false, code: "incompatible" });
    await expect(registry.enable("acme.factory-tools")).resolves.toMatchObject({ ok: false, code: "incompatible" });
    expect(activate).not.toHaveBeenCalled();
  });


  it("registers manifest-declared capabilities and removes them on disable", async () => {
    const manifest = pluginManifest({
      permissions: ["scene.read", "scene.write", "data.read"],
      extensionPoints: [
        ...pluginManifest().extensionPoints,
        {
          kind: "capability.provider",
          id: "acme.health-provider",
          capabilityIds: ["asset.health.score"],
          execution: "worker",
          limits: { timeoutMs: 100, maxInputBytes: 1_048_576, memoryMb: 256 }
        }
      ]
    });
    const registry = new PluginRegistry(hostPolicy({ extensionPoints: [...hostPolicy().extensionPoints, "capability.provider"], permissions: ["scene.read", "scene.write", "data.read"] }));
    expect(registry.register(manifest, ({ registerCapability }) => {
      expect(registerCapability({
        descriptor: {
          id: "asset.health.score",
          version: "1.0.0",
          label: "设备健康评分",
          kind: "analysis",
          execution: "worker",
          permissions: ["data.read"],
          timeoutMs: 50,
          inputSchemaVersion: "1.0",
          outputSchemaVersion: "1.0",
          inputSchema: { type: "object", additionalProperties: true },
          outputSchema: { type: "object", additionalProperties: true }
        },
        async invoke() {
          return { status: "completed", decisionStatus: "production", output: { score: 0.95 } };
        }
      })).toMatchObject({ ok: true });
    })).toMatchObject({ ok: true });
    await registry.enable("acme.factory-tools");
    await expect(registry.invokeCapability("asset.health.score", {
      requestId: "req-1",
      projectId: "project-1",
      principal: "operator",
      input: { assetId: "asset-1" }
    })).resolves.toMatchObject({ status: "completed", output: { score: 0.95 } });
    await registry.disable("acme.factory-tools");
    expect(registry.getCapability("asset.health.score")).toBeUndefined();
  });

  it("registers manifest-declared AI providers and removes them on disable", async () => {
    const manifest = pluginManifest({
      capabilities: [...pluginManifest().capabilities, "ai.provider"],
      permissions: [...pluginManifest().permissions, "ai.invoke"],
      extensionPoints: [
        ...pluginManifest().extensionPoints,
        {
          kind: "ai.provider",
          id: "acme.ai-provider",
          providerIds: ["ai.test-provider"],
          execution: "in-process",
          limits: { timeoutMs: 1_000, maxInputBytes: 1_048_576, memoryMb: 128 }
        }
      ]
    });
    const registry = new PluginRegistry(hostPolicy({
      capabilities: [...hostPolicy().capabilities, "ai.provider"],
      permissions: [...hostPolicy().permissions, "ai.invoke"],
      extensionPoints: [...hostPolicy().extensionPoints, "ai.provider"]
    }));
    registry.register(manifest, ({ registerAiProvider }) => {
      expect(registerAiProvider({
        descriptor: { id: "ai.test-provider", version: "1.0.0", label: "测试供应商", execution: "in-process", permissions: ["ai.invoke"], streaming: false, timeoutMs: 100 },
        async complete(request) { return { text: request.input, model: request.model }; }
      })).toMatchObject({ ok: true });
    });
    await registry.enable("acme.factory-tools");
    await expect(registry.invokeAiProvider("ai.test-provider", {
      requestId: "ai-1", principal: "operator", model: "model-1", instructions: "", input: "正常", temperature: 0, maxOutputTokens: 10, config: {}
    })).resolves.toMatchObject({ text: "正常" });
    await registry.disable("acme.factory-tools");
    expect(registry.listAiProviders()).toEqual([]);
  });
});
