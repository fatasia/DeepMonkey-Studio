import {
  IndustrialAgentOrchestrator,
  type AgentCheckpointStore,
  type AgentToolGateway,
} from "@bim-studio/industrial-agent-orchestrator";
import type { PluginRegistry } from "@bim-studio/plugin-runtime";
import type { DataQuerySource } from "@bim-studio/data-query-plugin";
import type { AiRuntimeSettings } from "./assistantService.js";
import type { AiReliabilityAuditSink } from "./aiReliabilityAudit.js";
import type { AiTelemetrySink } from "./aiRequestTelemetry.js";
import { IndustrialAgentCheckpointStore } from "./industrialAgentCheckpointStore.js";
import { createIndustrialAgentDecisionProvider } from "./industrialAgentDecisionProvider.js";
import { IndustrialAgentToolGateway } from "./industrialAgentToolGateway.js";
import { createAgentHarnessGuards } from "./agentHarnessGuards.js";
import { AgentMemoryStore } from "./agentMemory.js";
import { resolveAssistantSessionOptions, type AssistantSessionOptions } from "./assistantSessionOptions.js";

export interface IndustrialAgentRuntime {
  checkpoints: AgentCheckpointStore;
  tools: AgentToolGateway;
  orchestrator: IndustrialAgentOrchestrator;
  /** H-C2 记忆存储：面板路由与回灌共用同一实例。 */
  memory: AgentMemoryStore;
  resolveModelOptions?: (options: AssistantSessionOptions) => Promise<AssistantSessionOptions>;
}

export async function createIndustrialAgentRuntime(input: {
  dataDir: string;
  registry: PluginRegistry;
  settings: () => AiRuntimeSettings;
  dataSource: Pick<DataQuerySource, "listDatasets">;
  projectContext?: (projectId: string) => unknown | Promise<unknown>;
  audit?: AiReliabilityAuditSink;
  telemetry?: AiTelemetrySink;
  /** 同变体连续拒绝熔断阈值；缺省 3（Codex 3/50 思想，N 独立可配）。 */
  variantDenialLimit?: number;
}): Promise<IndustrialAgentRuntime> {
  const checkpoints = new IndustrialAgentCheckpointStore(input.dataDir);
  await checkpoints.init();
  const memory = new AgentMemoryStore(input.dataDir);
  await memory.init();
  const tools = new IndustrialAgentToolGateway(input.registry, input.audit);
  const guards = createAgentHarnessGuards({ ...(input.audit ? { audit: input.audit } : {}), memory });
  const decisions = createIndustrialAgentDecisionProvider({
    registry: input.registry,
    settings: input.settings,
    dataSource: input.dataSource,
    ...(input.projectContext ? { projectContext: input.projectContext } : {}),
    ...(input.audit ? { audit: input.audit } : {}),
    ...(input.telemetry ? { telemetry: input.telemetry } : {}),
    memory: (projectId) => memory.loadDelivery(projectId),
  });
  return {
    resolveModelOptions: async options => {
      const settings = await resolveAssistantSessionOptions(input.settings(), options);
      return { model: settings.model, ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}) };
    },
    checkpoints,
    tools,
    memory,
    orchestrator: new IndustrialAgentOrchestrator({
      decisions,
      tools,
      checkpoints,
      guards,
      ...(input.variantDenialLimit !== undefined ? { variantDenialLimit: input.variantDenialLimit } : {}),
    }),
  };
}
