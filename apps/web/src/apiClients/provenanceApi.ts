import type { AiProvenanceChainSummary, AiProvenanceTrace } from "@bim-studio/contracts";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

/** H-C3 档案室浏览器端调用边界：列表 + 三跳查询，避免组件自行拼接项目作用域。 */
export function createProvenanceApi(request: ApiRequest) {
  return {
    listProvenanceChains: (projectId: string, signal?: AbortSignal) =>
      request<ProvenanceChainList>(
        `/api/projects/${encodeURIComponent(projectId)}/ai/provenance`,
        signal ? { signal } : undefined,
      ),
    traceProvenance: (projectId: string, query: ProvenanceTraceQuery = {}, signal?: AbortSignal) =>
      request<AiProvenanceTrace>(provenanceTracePath(projectId, query), signal ? { signal } : undefined),
  };
}

export interface ProvenanceChainList {
  chains: AiProvenanceChainSummary[];
  integrity: { intact: boolean; brokenNodes: string[] };
}

export interface ProvenanceTraceQuery {
  resultFingerprint?: string;
  proposalFingerprint?: string;
  since?: string;
  until?: string;
  limit?: number;
}

function provenanceTracePath(projectId: string, query: ProvenanceTraceQuery): string {
  const params = new URLSearchParams();
  if (query.resultFingerprint) params.set("resultFingerprint", query.resultFingerprint);
  if (query.proposalFingerprint) params.set("proposalFingerprint", query.proposalFingerprint);
  if (query.since) params.set("since", query.since);
  if (query.until) params.set("until", query.until);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return `/api/projects/${encodeURIComponent(projectId)}/ai/provenance/trace${suffix}`;
}
