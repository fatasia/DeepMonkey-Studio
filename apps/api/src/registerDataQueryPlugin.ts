import { createDataQueryProviders, type DataQuerySource } from "@bim-studio/data-query-plugin";
import type { PluginRegistry } from "@bim-studio/plugin-runtime";

export async function registerDataQueryPlugin(registry: PluginRegistry, source: DataQuerySource): Promise<void> {
  const manifest = {
    schemaVersion: 1 as const,
    id: "bim.data-query",
    name: "Controlled project data query",
    version: "1.0.0",
    apiVersion: "1.0",
    hosts: ["cloud"] as const,
    capabilities: ["data.query"],
    permissions: ["data.read"],
    extensionPoints: [{
      kind: "capability.provider" as const,
      id: "bim.data-query-provider",
      capabilityIds: ["data.query.plan", "data.query.read"],
      execution: "in-process" as const,
      limits: { timeoutMs: 15_000, maxInputBytes: 512 * 1024, memoryMb: 128 },
    }],
  };
  const registered = registry.register(manifest, ({ registerCapability }) => {
    for (const provider of createDataQueryProviders(source)) {
      const result = registerCapability(provider);
      if (!result.ok) throw new Error(`受控问数能力注册失败：${result.message}`);
    }
  });
  if (!registered.ok) throw new Error(`受控问数插件不兼容：${registered.message}`);
  const enabled = await registry.enable(manifest.id);
  if (!enabled.ok) throw new Error(`受控问数插件启用失败：${enabled.message}`);
}
