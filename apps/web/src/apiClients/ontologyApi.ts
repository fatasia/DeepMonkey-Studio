import type { OntologyGraphQuery, OntologyGraphResult, OntologyHistoryEntry, OntologyPackage, OntologyPackageSnapshot } from "@bim-studio/contracts";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

export interface OntologyVersionList {
  versions: Array<Omit<OntologyPackageSnapshot, "package">>;
  history: OntologyHistoryEntry[];
}

export interface OntologyValidationResponse {
  shapeErrors: string[];
  gate: { ok: boolean; gates: Array<{ gateId: number; label: string; passed: boolean; errors: string[] }>; errors: string[] };
}

/** 数据中心"语义与本体"工作区的 API client;与 semanticModelApi 同一构造模式。 */
export function createOntologyApi(request: ApiRequest) {
  const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/ontology-packages`;
  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return {
    listOntologyPackages: (projectId: string) => request<OntologyPackage[]>(base(projectId)),
    createOntologyPackage: (projectId: string, pkg: OntologyPackage) => request<OntologyPackage>(base(projectId), json("POST", pkg)),
    validateOntologyPackage: (projectId: string, pkg: OntologyPackage) => request<OntologyValidationResponse>(`${base(projectId)}/validate`, json("POST", pkg)),
    getOntologyPackage: (projectId: string, packageId: string) => request<OntologyPackage>(`${base(projectId)}/${encodeURIComponent(packageId)}`),
    updateOntologyPackage: (projectId: string, pkg: OntologyPackage) => request<OntologyPackage>(`${base(projectId)}/${encodeURIComponent(pkg.id)}`, json("PUT", pkg)),
    deleteOntologyPackage: (projectId: string, packageId: string) => request<void>(`${base(projectId)}/${encodeURIComponent(packageId)}`, { method: "DELETE" }),
    submitOntologyReview: (projectId: string, packageId: string) => request<OntologyPackage>(`${base(projectId)}/${encodeURIComponent(packageId)}/submit-review`, json("POST", {})),
    rejectOntologyReview: (projectId: string, packageId: string, reason?: string) => request<OntologyPackage>(`${base(projectId)}/${encodeURIComponent(packageId)}/reject`, json("POST", reason ? { reason } : {})),
    publishOntologyPackage: (projectId: string, packageId: string) => request<OntologyPackage>(`${base(projectId)}/${encodeURIComponent(packageId)}/publish`, json("POST", {})),
    retireOntologyPackage: (projectId: string, packageId: string) => request<OntologyPackage>(`${base(projectId)}/${encodeURIComponent(packageId)}/retire`, json("POST", {})),
    listOntologyVersions: (projectId: string, packageId: string) => request<OntologyVersionList>(`${base(projectId)}/${encodeURIComponent(packageId)}/versions`),
    rollbackOntologyPackage: (projectId: string, packageId: string, snapshotId: string) => request<OntologyPackage>(`${base(projectId)}/${encodeURIComponent(packageId)}/rollback`, json("POST", { snapshotId })),
    cloneOntologyDraft: (projectId: string, packageId: string) => request<OntologyPackage>(`${base(projectId)}/${encodeURIComponent(packageId)}/clone-draft`, json("POST", {})),
    /** H-C4-P1 图谱查询：1—3 跳有限 BFS 投影（POST body = OntologyGraphQuery）。 */
    queryOntologyGraph: (projectId: string, packageId: string, query: OntologyGraphQuery) => request<OntologyGraphResult>(`${base(projectId)}/${encodeURIComponent(packageId)}/graph`, json("POST", query)),
  };
}
