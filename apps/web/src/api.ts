import type { ModelRecord, ProjectRecord, PublishedSceneRecord, RvtConversionMode, SceneSnapshot } from "@bim-studio/contracts";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ message: response.statusText }))) as { message?: string };
    throw new Error(body.message ?? `请求失败：${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  listProjects: () => request<ProjectRecord[]>("/api/projects"),
  createProject: (name: string, description = "") => request<ProjectRecord>("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, description })
  }),
  updateProject: (projectId: string, name: string, description = "") => request<ProjectRecord>(`/api/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, description })
  }),
  deleteProject: (projectId: string) => request<void>(`/api/projects/${projectId}`, { method: "DELETE" }),
  getProject: (projectId: string) => request<ProjectRecord>(`/api/projects/${projectId}`),
  uploadModel: async (projectId: string, file: File, rvtConversionMode: RvtConversionMode = "native-glb") => {
    const data = new FormData();
    data.append("file", file);
    return request<ModelRecord>(`/api/projects/${projectId}/models?rvtConversionMode=${encodeURIComponent(rvtConversionMode)}`, { method: "POST", body: data });
  },
  uploadEnvironmentMap: async (projectId: string, file: File) => {
    const data = new FormData();
    data.append("file", file);
    return request<{ name: string; url: string }>(`/api/projects/${projectId}/environment-maps`, { method: "POST", body: data });
  },
  deleteModel: (projectId: string, modelId: string) =>
    request<void>(`/api/projects/${projectId}/models/${modelId}`, { method: "DELETE" }),
  listScenes: (projectId: string) => request<SceneSnapshot[]>(`/api/projects/${projectId}/scenes`),
  saveScene: (scene: SceneSnapshot) =>
    request<SceneSnapshot>(`/api/projects/${scene.projectId}/scenes/${scene.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scene)
    }),
  importScene: (projectId: string, scene: SceneSnapshot) =>
    request<SceneSnapshot>(`/api/projects/${projectId}/scenes/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scene)
    }),
  copyScene: (projectId: string, sceneId: string, name?: string) =>
    request<SceneSnapshot>(`/api/projects/${projectId}/scenes/${sceneId}/copy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(name ? { name } : {})
    }),
  renameScene: (projectId: string, sceneId: string, name: string) =>
    request<SceneSnapshot>(`/api/projects/${projectId}/scenes/${sceneId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name })
    }),
  publishScene: (projectId: string, sceneId: string) =>
    request<PublishedSceneRecord>(`/api/projects/${projectId}/scenes/${sceneId}/publish`, { method: "POST" }),
  unpublishScene: (projectId: string, sceneId: string) =>
    request<void>(`/api/projects/${projectId}/scenes/${sceneId}/publish`, { method: "DELETE" }),
  getPublishedScene: (sceneId: string) => request<PublishedSceneRecord>(`/api/public/scenes/${sceneId}`),
  getSceneForBrowse: (sceneId: string) => request<{ scene: SceneSnapshot; project: ProjectRecord }>(`/api/scenes/${sceneId}/browse`),
  deleteScene: (projectId: string, sceneId: string) =>
    request<void>(`/api/projects/${projectId}/scenes/${sceneId}`, { method: "DELETE" })
};
