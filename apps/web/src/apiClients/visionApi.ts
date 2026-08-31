import type {
  VisionEventRecord,
  VisionInferenceResponse,
  VisionModelManifest,
  VisionModelPreset,
  VisionModelRecord,
  VisionSourceRecord,
  VisionTaskRecord,
} from "@bim-studio/contracts";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

/** 视觉中心接口保持在独立领域客户端，避免共享 API 门面继续膨胀。 */
export function createVisionApi(request: ApiRequest) {
  return {
    listVisionPresets: () =>
      request<VisionModelPreset[]>("/api/vision/presets"),
    listVisionSources: (projectId: string) =>
      request<VisionSourceRecord[]>(
        `/api/projects/${projectId}/vision/sources`,
      ),
    createVisionSource: (
      projectId: string,
      source: Partial<VisionSourceRecord>,
    ) =>
      request<VisionSourceRecord>(`/api/projects/${projectId}/vision/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(source),
      }),
    uploadVisionSource: (projectId: string, file: File, name?: string) => {
      const body = new FormData();
      body.append("file", file);
      const query = name?.trim() ? `?name=${encodeURIComponent(name.trim())}` : "";
      return request<VisionSourceRecord>(
        `/api/projects/${projectId}/vision/sources/upload${query}`,
        { method: "POST", body },
      );
    },
    deleteVisionSource: (projectId: string, sourceId: string) =>
      request<void>(`/api/projects/${projectId}/vision/sources/${sourceId}`, {
        method: "DELETE",
      }),
    listVisionModels: (projectId: string) =>
      request<VisionModelRecord[]>(`/api/projects/${projectId}/vision/models`),
    uploadVisionModel: (
      projectId: string,
      model: File,
      manifest: VisionModelManifest,
    ) => {
      const body = new FormData();
      body.append("manifest", JSON.stringify(manifest));
      body.append("model", model);
      return request<VisionModelRecord>(
        `/api/projects/${projectId}/vision/models`,
        { method: "POST", body },
      );
    },
    installVisionPreset: (projectId: string, presetId: string) =>
      request<VisionModelRecord>(
        `/api/projects/${projectId}/vision/models/install-preset`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ presetId }),
        },
      ),
    deleteVisionModel: (projectId: string, modelId: string) =>
      request<void>(`/api/projects/${projectId}/vision/models/${modelId}`, {
        method: "DELETE",
      }),
    listVisionTasks: (projectId: string) =>
      request<VisionTaskRecord[]>(`/api/projects/${projectId}/vision/tasks`),
    createVisionTask: (projectId: string, task: Partial<VisionTaskRecord>) =>
      request<VisionTaskRecord>(`/api/projects/${projectId}/vision/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(task),
      }),
    updateVisionTask: (
      projectId: string,
      taskId: string,
      patch: Partial<VisionTaskRecord>,
    ) =>
      request<VisionTaskRecord>(
        `/api/projects/${projectId}/vision/tasks/${taskId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        },
      ),
    deleteVisionTask: (projectId: string, taskId: string) =>
      request<void>(`/api/projects/${projectId}/vision/tasks/${taskId}`, {
        method: "DELETE",
      }),
    inferVisionImage: (projectId: string, taskId: string, file: File) => {
      const body = new FormData();
      body.append("file", file);
      return request<VisionInferenceResponse>(
        `/api/projects/${projectId}/vision/tasks/${taskId}/infer-image`,
        { method: "POST", body },
      );
    },
    listVisionEvents: (projectId: string, limit = 200) =>
      request<VisionEventRecord[]>(
        `/api/projects/${projectId}/vision/events?limit=${limit}`,
      ),
    updateVisionEvent: (
      projectId: string,
      eventId: string,
      patch: Pick<Partial<VisionEventRecord>, "status" | "note" | "review">,
    ) =>
      request<VisionEventRecord>(
        `/api/projects/${projectId}/vision/events/${eventId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        },
      ),
  };
}
