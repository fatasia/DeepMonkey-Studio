import type {
  AgentBudget,
  AgentCheckpoint,
  AgentToolDefinition,
} from "@bim-studio/industrial-agent-orchestrator";
import type { AgentAutonomySettings } from "@bim-studio/contracts";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;
import type { AiSampleKind, AiSampleResult } from "@bim-studio/contracts";

export interface StartIndustrialAgentRunInput {
  objective: string;
  context: unknown;
  allowedToolIds: string[];
  budget?: Partial<AgentBudget>;
  modelOptions?: import("./aiApi").AssistantSessionOptions;
  /** H-C1 计划模式：只读探索并输出实施计划，不执行 simulate/write/control。 */
  planMode?: boolean;
  /** H-autonomy：本次运行的执行模式覆盖；缺省回落服务端持久化默认。 */
  executionMode?: "confirm" | "autonomous";
  /** H-autonomy：自主模式免逐条审批白名单覆盖；缺省回落服务端持久化授权面。 */
  autoApproveToolIds?: string[];
  /** H-autonomy：工具发现面；general 需服务端开关开启（关闭时 400 fail-closed）。 */
  discovery?: "curated" | "general";
}

/** H-autonomy：agent-tools 发现面响应（含通用开发开关读回，UI 据此决定是否展示发现面切换）。 */
export interface AgentToolsView {
  tools: AgentToolDefinition[];
  discovery: "curated" | "general";
  generalAvailable: boolean;
}

/** H-autonomy：授权范围/执行模式设置读回（无秘密字段）。 */
export interface AgentSettingsView {
  settings: AgentAutonomySettings;
  curatedToolCount: number;
}

/** 工业 Agent 的浏览器端调用集中在一个边界，避免组件自行拼接审批或项目作用域。 */
export function createIndustrialAgentApi(request: ApiRequest) {
  return {
    runAiSample: (projectId: string, kind: AiSampleKind, signal?: AbortSignal) =>
      request<AiSampleResult>(`/api/projects/${encodeURIComponent(projectId)}/ai/samples/${kind}/run`, {
        method: "POST", ...(signal ? { signal } : {}),
      }),
    listIndustrialAgentTools: (projectId: string, signal?: AbortSignal, discovery?: "curated" | "general") =>
      request<AgentToolsView>(
        `/api/projects/${encodeURIComponent(projectId)}/ai/agent-tools${discovery ? `?discovery=${discovery}` : ""}`,
        signal ? { signal } : undefined,
      ),
    // H-autonomy 要素①：授权范围/执行模式配置面（挂既有设置结构，读回即生效）。
    getAgentAutonomySettings: (projectId: string, signal?: AbortSignal) =>
      request<AgentSettingsView>(
        `/api/projects/${encodeURIComponent(projectId)}/ai/agent-settings`,
        signal ? { signal } : undefined,
      ),
    updateAgentAutonomySettings: (projectId: string, draft: Partial<AgentAutonomySettings>) =>
      request<AgentSettingsView>(`/api/projects/${encodeURIComponent(projectId)}/ai/agent-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      }),
    startIndustrialAgentRun: (
      projectId: string,
      input: StartIndustrialAgentRunInput,
      signal?: AbortSignal,
    ) => request<AgentCheckpoint>(
      `/api/projects/${encodeURIComponent(projectId)}/ai/agent-runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, execution: "background" }),
        ...(signal ? { signal } : {}),
      },
    ),
    getIndustrialAgentRun: (projectId: string, runId: string, signal?: AbortSignal) =>
      request<AgentCheckpoint>(agentRunPath(projectId, runId), signal ? { signal } : undefined),
    approveIndustrialAgentRun: (projectId: string, runId: string, scopeFingerprint: string) =>
      request<AgentCheckpoint>(`${agentRunPath(projectId, runId)}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopeFingerprint, execution: "background" }),
      }),
    resumeIndustrialAgentRun: (projectId: string, runId: string, expectedRevision?: number, selectionId?: string) =>
      request<AgentCheckpoint>(`${agentRunPath(projectId, runId)}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ execution: "background", expectedRevision, selectionId }),
      }),
    cancelIndustrialAgentRun: (projectId: string, runId: string) =>
      request<AgentCheckpoint>(agentRunPath(projectId, runId), { method: "DELETE" }),
    // H-C2 记忆面板：列表/确认/启停编辑/删除；RULES.md 只读（编辑走文件系统）。
    listAgentMemory: (projectId: string, signal?: AbortSignal) =>
      request<AgentMemoryView>(
        `/api/projects/${encodeURIComponent(projectId)}/ai/memory`,
        signal ? { signal } : undefined,
      ),
    confirmAgentMemory: (projectId: string, memoryId: string) =>
      request<AgentMemoryRecord>(
        `${memoryPath(projectId, memoryId)}/confirm`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      ),
    updateAgentMemory: (projectId: string, memoryId: string, patch: { content?: string; enabled?: boolean }) =>
      request<AgentMemoryRecord>(memoryPath(projectId, memoryId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    deleteAgentMemory: (projectId: string, memoryId: string) =>
      request<{ deleted: string }>(memoryPath(projectId, memoryId), { method: "DELETE" }),
  };
}

export interface AgentMemoryRecord {
  id: string;
  content: string;
  status: "pending" | "active" | "disabled";
  origin: { kind: "agent-proposal"; runId?: string; step?: number; proposalFingerprint?: string };
  createdAt: string;
  updatedAt: string;
  confirmedBy?: string;
  confirmedAt?: string;
}

export interface AgentMemoryView {
  rules: { configured: boolean; chars: number; truncated: boolean; fingerprint?: string; excerpt?: string };
  memories: AgentMemoryRecord[];
  /** H-C6-S2：服务端提炼经验与运行终态归档（形状镜像 apps/api/src/ai/agentMemory.ts 的 AgentRunArchive）。 */
  lessons?: unknown[];
  runArchives?: AgentRunArchiveView[];
  runArchiveCount?: number;
}

/** 服务端 run 终态归档的浏览器端视图：历史运行面板据此补终态语义。 */
export interface AgentRunArchiveView {
  runId: string;
  status: "completed" | "blocked" | "failed" | "cancelled" | "budget-exhausted";
  objective: string;
  outcomeSummary: string;
  failureCode?: string;
  steps: number;
  toolCalls: number;
  toolIds: string[];
  endedAt: string;
}

function memoryPath(projectId: string, memoryId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/ai/memory/${encodeURIComponent(memoryId)}`;
}

function agentRunPath(projectId: string, runId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/ai/agent-runs/${encodeURIComponent(runId)}`;
}
