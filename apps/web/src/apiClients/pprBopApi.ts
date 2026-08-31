import type { PprBopVersion, PprBopVersionDraft } from "@bim-studio/contracts";
import type { PprAnalysis, PprVersionComparison } from "@bim-studio/ppr-lite-engine";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

export function createPprBopApi(request: ApiRequest) {
  return {
    listPprBopVersions: (projectId: string) =>
      request<PprBopVersion[]>(`/api/projects/${projectId}/ppr/bop-versions`),
    createPprBopVersion: (projectId: string, draft: PprBopVersionDraft) =>
      request<PprBopVersion>(`/api/projects/${projectId}/ppr/bop-versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      }),
    analyzePprBopVersion: (projectId: string, versionId: string) =>
      request<PprAnalysis>(`/api/projects/${projectId}/ppr/bop-versions/${encodeURIComponent(versionId)}/analysis`),
    comparePprBopVersions: (projectId: string, beforeVersionId: string, afterVersionId: string) =>
      request<PprVersionComparison>(`/api/projects/${projectId}/ppr/bop-versions/compare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ beforeVersionId, afterVersionId }),
      }),
  };
}
