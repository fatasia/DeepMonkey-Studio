import type {
  AgentBudget,
  AgentCheckpoint,
  AgentToolDefinition,
} from "@bim-studio/industrial-agent-orchestrator";

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
}

/** 工业 Agent 的浏览器端调用集中在一个边界，避免组件自行拼接审批或项目作用域。 */
export function createIndustrialAgentApi(request: ApiRequest) {
  return {
    runAiSample: (projectId: string, kind: AiSampleKind, signal?: AbortSignal) =>
      request<AiSampleResult>(`/api/projects/${encodeURIComponent(projectId)}/ai/samples/${kind}/run`, {
        method: "POST", ...(signal ? { signal } : {}),
      }),
    listIndustrialAgentTools: (projectId: string, signal?: AbortSignal) =>
      request<{ tools: AgentToolDefinition[] }>(
        `/api/projects/${encodeURIComponent(projectId)}/ai/agent-tools`,
        signal ? { signal } : undefined,
      ),
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
}

function memoryPath(projectId: string, memoryId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/ai/memory/${encodeURIComponent(memoryId)}`;
}

function agentRunPath(projectId: string, runId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/ai/agent-runs/${encodeURIComponent(runId)}`;
}
