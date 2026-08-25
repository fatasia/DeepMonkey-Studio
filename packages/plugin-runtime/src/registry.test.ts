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
});
