import type {
  AgentBudget,
  AgentCheckpoint,
  AgentToolDefinition,
} from "@bim-studio/industrial-agent-orchestrator";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

export interface StartIndustrialAgentRunInput {
  objective: string;
  context: unknown;
  allowedToolIds: string[];
  budget?: Partial<AgentBudget>;
}

/** 工业 Agent 的浏览器端调用集中在一个边界，避免组件自行拼接审批或项目作用域。 */
export function createIndustrialAgentApi(request: ApiRequest) {
  return {
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
  };
}

function agentRunPath(projectId: string, runId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/ai/agent-runs/${encodeURIComponent(runId)}`;
}
