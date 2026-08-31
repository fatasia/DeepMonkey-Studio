import type { PluginRegistry } from "@bim-studio/plugin-runtime";
import { createOpenAiCompatibleProvider } from "./openAiCompatibleProvider.js";

/** 默认 AI 插件只是可替换实现之一；业务助手不依赖其厂商协议。 */
export async function registerDefaultAiPlugin(registry: PluginRegistry): Promise<void> {
  const manifest = {
    schemaVersion: 1 as const,
    id: "bim.ai.openai-compatible",
    name: "OpenAI compatible AI provider",
    version: "1.0.0",
    apiVersion: "1.0",
    hosts: ["cloud"] as const,
    capabilities: ["ai.provider"],
    permissions: ["ai.invoke"],
    extensionPoints: [{
      kind: "ai.provider" as const,
      id: "bim.ai-runtime",
      providerIds: ["ai.openai-compatible"],
      execution: "in-process" as const,
      limits: { timeoutMs: 90_000, maxInputBytes: 1024 * 1024, memoryMb: 256 }
    }]
  };
  const registered = registry.register(manifest, ({ registerAiProvider }) => {
    const result = registerAiProvider(createOpenAiCompatibleProvider());
    if (!result.ok) throw new Error(`默认 AI Provider 注册失败：${result.message}`);
  });
  if (!registered.ok) throw new Error(`默认 AI 插件不兼容：${registered.message}`);
  const enabled = await registry.enable(manifest.id);
  if (!enabled.ok) throw new Error(`默认 AI 插件启用失败：${enabled.message}`);
}
