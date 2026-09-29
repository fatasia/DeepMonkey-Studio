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
  /** H-C4-P3：数据目录——本体行动路径用它构造逐请求新鲜的本体包读取器（只读）。 */
  dataDir: string;
  resolveModelOptions?: (options: AssistantSessionOptions) => Promise<AssistantSessionOptions>;
}

// K4：chat 助手侧读取项目记忆走同一 runtime 实例（同一 dataDir 唯一 memory store）。
// 生产装配时序由 index.ts 保证：先 createIndustrialAgentRuntime，后 createAssistantService。
// 测试直注 options.memory，不依赖此共享槽位。
let sharedRuntime: IndustrialAgentRuntime | undefined;

/** 最近一次成功装配的工业 Agent runtime；未装配时返回 undefined（chat 记忆注入随之零开销跳过）。 */
export function industrialAgentRuntimeIfReady(): IndustrialAgentRuntime | undefined {
  return sharedRuntime;
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
  const runtime: IndustrialAgentRuntime = {
    resolveModelOptions: async options => {
      const settings = await resolveAssistantSessionOptions(input.settings(), options);
      return { model: settings.model, ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}) };
    },
    checkpoints,
    tools,
    memory,
    dataDir: input.dataDir,
    orchestrator: new IndustrialAgentOrchestrator({
      decisions,
      tools,
      checkpoints,
      guards,
      ...(input.variantDenialLimit !== undefined ? { variantDenialLimit: input.variantDenialLimit } : {}),
    }),
  };
  sharedRuntime = runtime;
  return runtime;
}
