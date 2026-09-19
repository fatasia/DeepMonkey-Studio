import type { DataEvent } from "@bim-studio/contracts";

/** 告警/回放业务 API 客户端(transport 注入,raw fetch 只在 api.ts)。 */

export type AlertIngestRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

export interface AlertStateSnapshotDto {
  ruleId: string;
  label: string;
  signalId: string;
  severity: "info" | "warning" | "alarm";
  status: "active" | "acknowledged" | "cleared";
  since: number;
  lastValue: number | null;
  acknowledgedAt: number | null;
  clearedAt: number | null;
}

export interface AlertRuleDto {
  id: string;
  label: string;
  signalId: string;
  kind: string;
  threshold: number;
}

export interface ReplaySeries {
  revision: string;
  entries: Array<{ at: number; values: Record<string, number> }>;
}

export function createAlertIngestApi(request: AlertIngestRequest) {
  return {
    fetchRules: (projectId: string) => request<AlertRuleDto[]>(`/api/projects/${encodeURIComponent(projectId)}/alert-rules`),
    fetchState: (projectId: string) => request<AlertStateSnapshotDto[]>(`/api/projects/${encodeURIComponent(projectId)}/alert-state`),
    acknowledge: (projectId: string, ruleId: string) =>
      request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/alert-rules/${encodeURIComponent(ruleId)}/acknowledge`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      }),
    removeRule: (projectId: string, ruleId: string) =>
      request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/alert-rules/${encodeURIComponent(ruleId)}`, { method: "DELETE" }),
  };
}

export function createDataReplayApi(request: AlertIngestRequest) {
  return {
    fetchReplay: (projectId: string, windowMs: number) =>
      request<ReplaySeries>(`/api/projects/${encodeURIComponent(projectId)}/data/replay?windowMs=${windowMs}`),
  };
}

export type { DataEvent };
