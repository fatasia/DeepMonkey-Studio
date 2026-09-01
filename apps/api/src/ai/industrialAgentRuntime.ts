import {
  IndustrialAgentOrchestrator,
  type AgentCheckpointStore,
  type AgentToolGateway,
} from "@bim-studio/industrial-agent-orchestrator";
import type { PluginRegistry } from "@bim-studio/plugin-runtime";
import type { AiRuntimeSettings } from "./assistantService.js";
import type { AiReliabilityAuditSink } from "./aiReliabilityAudit.js";
import { IndustrialAgentCheckpointStore } from "./industrialAgentCheckpointStore.js";
import { createIndustrialAgentDecisionProvider } from "./industrialAgentDecisionProvider.js";
import { IndustrialAgentToolGateway } from "./industrialAgentToolGateway.js";

export interface IndustrialAgentRuntime {
  checkpoints: AgentCheckpointStore;
  tools: AgentToolGateway;
  orchestrator: IndustrialAgentOrchestrator;
}

export async function createIndustrialAgentRuntime(input: {
  dataDir: string;
  registry: PluginRegistry;
  settings: () => AiRuntimeSettings;
  audit?: AiReliabilityAuditSink;
}): Promise<IndustrialAgentRuntime> {
  const checkpoints = new IndustrialAgentCheckpointStore(input.dataDir);
  await checkpoints.init();
  const tools = new IndustrialAgentToolGateway(input.registry, input.audit);
  const decisions = createIndustrialAgentDecisionProvider({
    registry: input.registry,
    settings: input.settings,
    ...(input.audit ? { audit: input.audit } : {}),
  });
  return {
    checkpoints,
    tools,
    orchestrator: new IndustrialAgentOrchestrator({ decisions, tools, checkpoints }),
  };
}
