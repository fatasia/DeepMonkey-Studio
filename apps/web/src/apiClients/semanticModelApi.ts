import type { SemanticModelRecord } from "@bim-studio/contracts";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;
export function createSemanticModelApi(request: ApiRequest) {
  const base = (projectId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/semantic-models`;
  return {
    listSemanticModels: (projectId: string) =>
      request<SemanticModelRecord[]>(base(projectId)),
    createSemanticModel: (projectId: string, model: SemanticModelRecord) =>
      request<SemanticModelRecord>(base(projectId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(model),
      }),
    updateSemanticModel: (projectId: string, model: SemanticModelRecord) =>
      request<SemanticModelRecord>(
        `${base(projectId)}/${encodeURIComponent(model.id)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(model),
        },
      ),
    deleteSemanticModel: (projectId: string, modelId: string) =>
      request<void>(`${base(projectId)}/${encodeURIComponent(modelId)}`, {
        method: "DELETE",
      }),
  };
}
