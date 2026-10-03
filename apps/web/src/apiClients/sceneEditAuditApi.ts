import type { SceneEditRecord } from "../ai/sceneEditSession";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

/** 助手场景改动闭环的审计回执(仅指纹与判定)落账到服务端审计链。 */
export function createSceneEditAuditApi(request: ApiRequest) {
  return {
    recordSceneEdit: (projectId: string, record: SceneEditRecord) =>
      request<{ eventId: string; evidenceFingerprint: string }>(`/api/projects/${encodeURIComponent(projectId)}/ai/scene-edit-records`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(record),
      }),
  };
}
