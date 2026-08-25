import { describe, expect, it, vi } from "vitest";
import { PluginRegistry, validatePluginManifest, type PluginHostPolicy } from "@bim-studio/plugin-runtime";
import type { AgvMotionSource } from "./agv-motion.js";
import type { FactoryFlowModel } from "./model.js";
import {
  createFactoryFlowPluginFactory,
  FACTORY_FLOW_PLUGIN_ID,
  FACTORY_FLOW_PLUGIN_MANIFEST,
  type FactoryFlowPluginService
} from "./plugin.js";

const MODEL: FactoryFlowModel = {
  id: "minimal",
  name: "Minimal",
  nodes: [
    { id: "source", name: "Source", kind: "source", interarrivalTimeMs: 100, maxItems: 1 },
    { id: "sink", name: "Sink", kind: "sink" }
  ],
  edges: [{ id: "e1", from: "source", to: "sink" }]
};

const SIMULATION_SOURCE: AgvMotionSource = {
  mode: "simulation",
  read: () => undefined,
  reset: vi.fn()
};

function hostPolicy(): PluginHostPolicy {
  return {
    apiVersion: "1.0",
    sceneApiVersion: "1.0",
    host: "browser",
    renderer: "webgpu",
    capabilities: [],
    permissions: [],
    extensionPoints: ["editor.panel"],
    allowTrustedSceneExtensions: false
  };
}

describe("Factory Flow plugin integration", () => {
  it("publishes a valid plugin-runtime manifest and stays dormant until explicitly enabled", async () => {
    expect(validatePluginManifest(FACTORY_FLOW_PLUGIN_MANIFEST)).toMatchObject({ valid: true });
    let service: FactoryFlowPluginService | undefined;
    const onActivate = vi.fn((value: FactoryFlowPluginService) => { service = value; });
    const registry = new PluginRegistry(hostPolicy());
    expect(registry.register(FACTORY_FLOW_PLUGIN_MANIFEST, createFactoryFlowPluginFactory({
      model: MODEL,
      agvMotionSources: [SIMULATION_SOURCE],
      onActivate
    }))).toMatchObject({ ok: true, plugin: { status: "registered" } });

    expect(onActivate).not.toHaveBeenCalled();
    expect(service).toBeUndefined();
    expect(await registry.enable(FACTORY_FLOW_PLUGIN_ID)).toMatchObject({ ok: true, plugin: { status: "enabled" } });
    expect(service?.disposed).toBe(false);
    service?.simulation.run();
    expect(await registry.disable(FACTORY_FLOW_PLUGIN_ID)).toMatchObject({ ok: true, plugin: { status: "registered" } });
    expect(service?.disposed).toBe(true);
    expect(service?.simulation.snapshot().status).toBe("paused");
  });

  it("contains activation faults and leaves an unrelated plugin operational", async () => {
    let failedService: FactoryFlowPluginService | undefined;
    const registry = new PluginRegistry(hostPolicy());
    registry.register(FACTORY_FLOW_PLUGIN_MANIFEST, createFactoryFlowPluginFactory({
      model: MODEL,
      agvMotionSources: [SIMULATION_SOURCE],
      onActivate(service) {
        failedService = service;
        throw new Error("factory panel failed");
      }
    }));
    const healthyManifest = structuredClone(FACTORY_FLOW_PLUGIN_MANIFEST);
    healthyManifest.id = "bim-studio.healthy-flow";
    healthyManifest.extensionPoints[0]!.id = "bim-studio.healthy-flow-panel";
    const healthyActivate = vi.fn();
    registry.register(healthyManifest, healthyActivate);

    const results = await registry.enableAll();
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ ok: false, code: "activation-failed", message: "factory panel failed" }),
      expect.objectContaining({
        ok: true,
        plugin: expect.objectContaining({
          manifest: expect.objectContaining({ id: "bim-studio.healthy-flow" }),
          status: "enabled"
        })
      })
    ]));
    expect(failedService?.disposed).toBe(true);
    expect(healthyActivate).toHaveBeenCalledOnce();
  });
});
