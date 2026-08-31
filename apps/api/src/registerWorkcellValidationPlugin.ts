import { createWorkcellAuditProvider } from "@bim-studio/workcell-validation-plugin";
import type { PluginRegistry } from "@bim-studio/plugin-runtime";

/** 将确定性工位体检作为独立插件注册，页面、API、MCP 与 AI 共用同一能力。 */
export async function registerWorkcellValidationPlugin(registry: PluginRegistry): Promise<void> {
  const manifest = {
    schemaVersion: 1 as const,
    id: "bim.manufacturing.workcell-validation",
    name: "Lightweight workcell validation",
    version: "1.1.0",
    apiVersion: "1.0",
    hosts: ["cloud"] as const,
    capabilities: ["manufacturing.validation"],
    permissions: ["manufacturing.read"],
    extensionPoints: [{
      kind: "capability.provider" as const,
      id: "bim.workcell-validation",
      capabilityIds: ["manufacturing.workcell.audit"],
      execution: "in-process" as const,
      limits: { timeoutMs: 5_000, maxInputBytes: 2 * 1024 * 1024, memoryMb: 128 },
    }],
  };
  const registered = registry.register(manifest, ({ registerCapability }) => {
    const result = registerCapability(createWorkcellAuditProvider());
    if (!result.ok) throw new Error(`工位体检能力注册失败：${result.message}`);
  });
  if (!registered.ok) throw new Error(`工位体检插件不兼容：${registered.message}`);
  const enabled = await registry.enable(manifest.id);
  if (!enabled.ok) throw new Error(`工位体检插件启用失败：${enabled.message}`);
}
