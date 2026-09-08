import type { DataWritebackRequest, DataWritebackSnapshot } from "@bim-studio/contracts";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

/** 写回只能引用项目内已配置的数据集，客户端不提供目标 URL 或凭据。 */
export function createDataWritebackApi(request: ApiRequest) {
  const path = (projectId: string, datasetId: string, recordId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(datasetId)}/records/${encodeURIComponent(recordId)}`;
  return {
    readDatasetRecord: (projectId: string, datasetId: string, recordId: string, signal?: AbortSignal) =>
      request<DataWritebackSnapshot>(path(projectId, datasetId, recordId), { ...(signal ? { signal } : {}) }),
    writeDatasetRecord: (projectId: string, datasetId: string, recordId: string, changes: DataWritebackRequest, signal?: AbortSignal) =>
      request<DataWritebackSnapshot>(path(projectId, datasetId, recordId), {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(changes), ...(signal ? { signal } : {}),
      }),
  };
}
