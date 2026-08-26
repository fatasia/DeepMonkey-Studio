import type { AiAssistantResponse, AiProviderSettings, ApplicationDocument, AuditLogRecord, DataConnectionRecord, DataDatasetPreview, DataDatasetRecord, DataEndpointDefinition, DataEndpointSaveResult, DataPipelineDefinition, DataPipelinePreview, DirectBindingSpec, DirectBindingTemplateValue, ModelRecord, ProjectAssetRecord, ProjectRecord, PublishedSceneRecord, RevitRuntimeInfo, RvtConversionMode, SceneSnapshot, ServiceHealthRecord, ServiceLogRecord, SystemBrandingSettings, SystemUserRecord, VisionEventRecord, VisionInferenceResponse, VisionModelManifest, VisionModelPreset, VisionModelRecord, VisionSourceRecord, VisionTaskRecord } from "@bim-studio/contracts";
import { ServerClient, type CloudRenderControlOverview, type CloudRenderScenePolicy, type RemoteRenderSessionSnapshot } from "@bim-studio/server-sdk";
import { runtimeHost } from "./adapters/runtimeHost.js";

const serverClient = new ServerClient({
  profile: () => runtimeHost.getServerProfile(),
  authStore: runtimeHost,
  onUnauthorized: () => runtimeHost.notifyUnauthorized()
});

export function getAuthToken() { return runtimeHost.getAccessToken(); }
export function setAuthToken(token?: string, remember = true) {
  if (token) runtimeHost.setAccessToken(token, remember);
  else runtimeHost.clearAccessToken();
}

export function openDirectBindingWebSocket(): WebSocket {
  const url = new URL("/api/direct-bindings/ws", runtimeHost.getServerProfile().baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const token = getAuthToken();
  return new WebSocket(url, token ? [`bim-studio-auth.${token}`] : []);
}

const request = <T>(url: string, init?: RequestInit) => serverClient.request<T>(url, init);

async function streamAssistant(mode: "bim" | "scene" | "component" | "dashboard" | "sql", question: string, context: unknown, onDelta: (delta: string) => void): Promise<AiAssistantResponse> {
  const response = await serverClient.open("/api/ai/assistant/stream", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ mode, question, context })
  });
  if (!response.body) throw new Error("浏览器不支持流式响应");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    for (const block of events) {
      const event = block.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      const payload = JSON.parse(data) as { delta?: string; message?: string } | AiAssistantResponse;
      if (event === "delta" && "delta" in payload && payload.delta) onDelta(payload.delta);
      if (event === "error") throw new Error("message" in payload ? payload.message : "AI 流式请求失败");
      if (event === "done") return payload as AiAssistantResponse;
    }
    if (done) break;
  }
  throw new Error("AI 流式响应意外结束");
}

export const api = {
  getMeta: () => serverClient.getMeta(),
  listApplications: (projectId: string) => serverClient.listApplications(projectId),
  getApplication: (projectId: string, applicationId: string) => serverClient.getApplication(projectId, applicationId),
  createApplication: (document: ApplicationDocument) => serverClient.createApplication(document),
  saveApplication: (document: ApplicationDocument) => serverClient.saveApplication(document),
  saveApplicationWorkspace: (document: ApplicationDocument, scene: SceneSnapshot) => serverClient.saveApplicationWorkspace(document, scene),
  deleteApplication: (projectId: string, applicationId: string) => serverClient.deleteApplication(projectId, applicationId),
  publishApplication: (projectId: string, applicationId: string) => serverClient.publishApplication(projectId, applicationId),
  unpublishApplication: (projectId: string, applicationId: string) => serverClient.unpublishApplication(projectId, applicationId),
  getBranding: () => request<SystemBrandingSettings>("/api/public/branding"),
  saveBranding: (settings: Partial<SystemBrandingSettings>) => request<SystemBrandingSettings>("/api/admin/branding", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) }),
  uploadBrandingAsset: (kind: "logo" | "icon", file: File) => { const body = new FormData(); body.append("file", file); return request<{ url: string; settings: SystemBrandingSettings }>(`/api/admin/branding/upload?kind=${kind}`, { method: "POST", body }); },
  login: (username: string, password: string, remember: boolean) => request<{ token: string; user: SystemUserRecord }>("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, remember }) }),
  me: () => request<SystemUserRecord>("/api/auth/me"),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  listUsers: () => request<SystemUserRecord[]>("/api/admin/users"),
  createUser: (user: Partial<SystemUserRecord> & { password: string }) => request<SystemUserRecord>("/api/admin/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(user) }),
  updateUser: (userId: string, patch: Partial<SystemUserRecord> & { password?: string }) => request<SystemUserRecord>(`/api/admin/users/${userId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }),
  deleteUser: (userId: string) => request<void>(`/api/admin/users/${userId}`, { method: "DELETE" }),
  listAuditLogs: () => request<AuditLogRecord[]>("/api/admin/audit?limit=300"),
  listServiceLogs: () => request<ServiceLogRecord[]>("/api/admin/logs"),
  getSystemHealth: () => request<ServiceHealthRecord[]>("/api/admin/health"),
  getAiSettings: () => request<AiProviderSettings>("/api/admin/ai-settings"),
  saveAiSettings: (settings: Partial<AiProviderSettings>) => request<AiProviderSettings>("/api/admin/ai-settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) }),
  testAiSettings: () => request<{ ok: boolean; model: string }>("/api/admin/ai-settings/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
  getCloudRenderOverview: () => request<CloudRenderControlOverview>("/api/admin/cloud-render"),
  setCloudRenderEnabled: (sceneId: string, enabled: boolean) => request<CloudRenderScenePolicy>(`/api/admin/cloud-render/scenes/${encodeURIComponent(sceneId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }),
  startCloudRenderSession: (sceneId: string) => request<RemoteRenderSessionSnapshot>(`/api/admin/cloud-render/scenes/${encodeURIComponent(sceneId)}/sessions`, { method: "POST" }),
  refreshCloudRenderSession: (sceneId: string) => request<RemoteRenderSessionSnapshot>(`/api/admin/cloud-render/scenes/${encodeURIComponent(sceneId)}/sessions/current`),
  stopCloudRenderSession: (sceneId: string) => request<void>(`/api/admin/cloud-render/scenes/${encodeURIComponent(sceneId)}/sessions/current`, { method: "DELETE" }),
  executeDirectBinding: (binding: DirectBindingSpec, variables: Record<string, DirectBindingTemplateValue> = {}) => request<{ ok: true; status: number; data: unknown; value: unknown }>("/api/direct-bindings/http", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ binding, variables }) }),
  askAssistant: (mode: "bim" | "scene" | "component" | "dashboard" | "sql", question: string, context: unknown) => request<AiAssistantResponse>("/api/ai/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, question, context }) }),
  streamAssistant,
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
  listDataConnections: (projectId: string) => request<DataConnectionRecord[]>(`/api/projects/${projectId}/data-connections`),
  createDataConnection: (projectId: string, connection: Partial<DataConnectionRecord>) => request<DataConnectionRecord>(`/api/projects/${projectId}/data-connections`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(connection) }),
  deleteDataConnection: (projectId: string, connectionId: string) => request<void>(`/api/projects/${projectId}/data-connections/${connectionId}`, { method: "DELETE" }),
  listDatasets: (projectId: string) => request<DataDatasetRecord[]>(`/api/projects/${projectId}/datasets`),
  createDataset: (projectId: string, dataset: Partial<DataDatasetRecord>) => request<DataDatasetRecord>(`/api/projects/${projectId}/datasets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(dataset) }),
  previewDataset: (projectId: string, datasetId: string) => request<DataDatasetPreview>(`/api/projects/${projectId}/datasets/${datasetId}/preview`),
  deleteDataset: (projectId: string, datasetId: string) => request<void>(`/api/projects/${projectId}/datasets/${datasetId}`, { method: "DELETE" }),
  listDataPipelines: (projectId: string) => request<DataPipelineDefinition[]>(`/api/projects/${projectId}/data-pipelines`),
  saveDataPipeline: (projectId: string, pipeline: Partial<DataPipelineDefinition>) => request<DataPipelineDefinition>(`/api/projects/${projectId}/data-pipelines`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pipeline) }),
  previewDataPipeline: (projectId: string, pipelineId: string) => request<DataPipelinePreview>(`/api/projects/${projectId}/data-pipelines/${pipelineId}/preview`),
  deleteDataPipeline: (projectId: string, pipelineId: string) => request<void>(`/api/projects/${projectId}/data-pipelines/${pipelineId}`, { method: "DELETE" }),
  listDataEndpoints: (projectId: string) => request<DataEndpointDefinition[]>(`/api/projects/${projectId}/data-endpoints`),
  saveDataEndpoint: (projectId: string, endpoint: Partial<DataEndpointDefinition> & { rotateKey?: boolean }) => request<DataEndpointSaveResult>(`/api/projects/${projectId}/data-endpoints`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(endpoint) }),
  testDataEndpoint: (projectId: string, endpointId: string) => request<DataPipelinePreview>(`/api/projects/${projectId}/data-endpoints/${endpointId}/test`, { method: "POST" }),
  deleteDataEndpoint: (projectId: string, endpointId: string) => request<void>(`/api/projects/${projectId}/data-endpoints/${endpointId}`, { method: "DELETE" }),
  resolveLiveMonitor: (sourceUrl: string, playback: "hls" | "webrtc") => request<{ path: string; hlsUrl: string; webRtcUrl: string }>("/api/live-monitor/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceUrl, playback }) }),
  listVisionPresets: () => request<VisionModelPreset[]>("/api/vision/presets"),
  listVisionSources: (projectId: string) => request<VisionSourceRecord[]>(`/api/projects/${projectId}/vision/sources`),
  createVisionSource: (projectId: string, source: Partial<VisionSourceRecord>) => request<VisionSourceRecord>(`/api/projects/${projectId}/vision/sources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(source) }),
  deleteVisionSource: (projectId: string, sourceId: string) => request<void>(`/api/projects/${projectId}/vision/sources/${sourceId}`, { method: "DELETE" }),
  listVisionModels: (projectId: string) => request<VisionModelRecord[]>(`/api/projects/${projectId}/vision/models`),
  uploadVisionModel: (projectId: string, model: File, manifest: VisionModelManifest) => { const body = new FormData(); body.append("manifest", JSON.stringify(manifest)); body.append("model", model); return request<VisionModelRecord>(`/api/projects/${projectId}/vision/models`, { method: "POST", body }); },
  installVisionPreset: (projectId: string, presetId: string) => request<VisionModelRecord>(`/api/projects/${projectId}/vision/models/install-preset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ presetId }) }),
  deleteVisionModel: (projectId: string, modelId: string) => request<void>(`/api/projects/${projectId}/vision/models/${modelId}`, { method: "DELETE" }),
  listVisionTasks: (projectId: string) => request<VisionTaskRecord[]>(`/api/projects/${projectId}/vision/tasks`),
  createVisionTask: (projectId: string, task: Partial<VisionTaskRecord>) => request<VisionTaskRecord>(`/api/projects/${projectId}/vision/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(task) }),
  updateVisionTask: (projectId: string, taskId: string, patch: Partial<VisionTaskRecord>) => request<VisionTaskRecord>(`/api/projects/${projectId}/vision/tasks/${taskId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }),
  deleteVisionTask: (projectId: string, taskId: string) => request<void>(`/api/projects/${projectId}/vision/tasks/${taskId}`, { method: "DELETE" }),
  inferVisionImage: (projectId: string, taskId: string, file: File) => { const body = new FormData(); body.append("file", file); return request<VisionInferenceResponse>(`/api/projects/${projectId}/vision/tasks/${taskId}/infer-image`, { method: "POST", body }); },
  listVisionEvents: (projectId: string, limit = 200) => request<VisionEventRecord[]>(`/api/projects/${projectId}/vision/events?limit=${limit}`),
  updateVisionEvent: (projectId: string, eventId: string, patch: Pick<Partial<VisionEventRecord>, "status" | "note">) => request<VisionEventRecord>(`/api/projects/${projectId}/vision/events/${eventId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }),
  listRevitInstallations: () => request<RevitRuntimeInfo>("/api/revit/installations"),
  uploadModel: async (projectId: string, file: File, rvtConversionMode: RvtConversionMode = "native-glb", rvtRevitVersion = "auto") => {
    const data = new FormData();
    data.append("file", file);
    return request<ModelRecord>(`/api/projects/${projectId}/models?rvtConversionMode=${encodeURIComponent(rvtConversionMode)}&rvtRevitVersion=${encodeURIComponent(rvtRevitVersion)}`, { method: "POST", body: data });
  },
  renameModel: (projectId: string, modelId: string, name: string) => request<ModelRecord>(`/api/projects/${projectId}/models/${modelId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }),
  listAssets: (projectId: string) => request<ProjectAssetRecord[]>(`/api/projects/${projectId}/assets`),
  uploadImageAsset: async (projectId: string, file: File) => {
    const data = new FormData();
    data.append("file", file);
    return request<ProjectAssetRecord>(`/api/projects/${projectId}/assets/images`, { method: "POST", body: data });
  },
  uploadVideoAsset: async (projectId: string, file: File) => {
    const data = new FormData();
    data.append("file", file);
    return request<ProjectAssetRecord>(`/api/projects/${projectId}/assets/videos`, { method: "POST", body: data });
  },
  renameAsset: (projectId: string, assetId: string, name: string) => request<ProjectAssetRecord>(`/api/projects/${projectId}/assets/${assetId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }),
  deleteAsset: (projectId: string, assetId: string) => request<void>(`/api/projects/${projectId}/assets/${assetId}`, { method: "DELETE" }),
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
