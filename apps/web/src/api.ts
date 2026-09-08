import type {
  AiDataBinding,
  AiDataBindingRunRecord,
  AiAssistantResponse,
  AiProviderSettings,
  ApplicationDocument,
  ApplicationScriptDependency,
  AuditLogRecord,
  ConverterPluginDescriptor,
  DataConnectorDiagnostics,
  DataConnectionRecord,
  DataDatasetPreview,
  DataDatasetRecord,
  DataEndpointDefinition,
  DataEndpointSaveResult,
  DataPipelineDefinition,
  DataPipelinePreview,
  DirectBindingSpec,
  DirectBindingTemplateValue,
  NotificationChannel,
  NotificationCredential,
  NotificationDeliveryAudit,
  NotificationEvent,
  NotificationRecipient,
  NotificationRule,
  NotificationTemplate,
  ProjectRecord,
  SceneSnapshot,
  ScriptModule,
  ServiceHealthRecord,
  ServiceLogLevel,
  ServiceLogQueryResult,
  ServiceLogRecord,
  SystemDiagnosticSnapshot,
  SystemBrandingSettings,
  SystemUserRecord,
  UnityResourceRecord,
} from "@bim-studio/contracts";
import {
  ServerClient,
  type CloudRenderControlOverview,
  type CloudRenderScenePolicy,
  type CloudRenderWorkerHealth,
  type RemoteRenderSessionSnapshot,
} from "@bim-studio/server-sdk";
import { runtimeHost } from "./adapters/runtimeHost.js";
import { desktopLocalApiFetch, setDesktopLocalExternalModuleFetch } from "./adapters/desktopLocalApi.js";
import { isLocalDesktopMode } from "./adapters/desktopRuntimeMode.js";
import { createIndustrialApi } from "./apiClients/industrialApi.js";
import { createPprBopApi } from "./apiClients/pprBopApi.js";
import { createModelSceneApi } from "./apiClients/modelSceneApi.js";
import { createVisionApi } from "./apiClients/visionApi.js";
import { createDataWritebackApi } from "./apiClients/dataWritebackApi.js";
import { createAssetLibraryApi } from "./apiClients/assetLibraryApi.js";
import { createIndustrialAgentApi } from "./apiClients/industrialAgentApi.js";
import { createSemanticModelApi } from "./apiClients/semanticModelApi.js";
import { isRecoverableStudioRead } from "./apiClients/studioReadRecovery.js";
import { createAuthenticationRecheck } from "./apiClients/authenticationRecheck.js";
import type {
  ScriptGitCommit,
  ScriptGitCommitResult,
  ScriptGitPullResult,
  ScriptGitPushResult,
  ScriptGitStatus,
} from "./apiClients/scriptGitTypes.js";
import {
  isSceneViewerDeliveryRuntime,
  sceneViewerDeliveryFetch,
  sceneViewerDeliveryServerProfile,
} from "./delivery/sceneViewerDelivery.js";

setDesktopLocalExternalModuleFetch((input, init) => globalThis.fetch(input, init));

const desktopAwareFetch = (input: RequestInfo | URL, init?: RequestInit) =>
  isSceneViewerDeliveryRuntime()
    ? sceneViewerDeliveryFetch(input, init)
    : isLocalDesktopMode()
      ? desktopLocalApiFetch(input, init)
      : globalThis.fetch(input, init);

const STARTUP_MANIFEST_TIMEOUT_MS = 15_000;
const EXTERNAL_JSON_TIMEOUT_MS = 30_000;
const UNITY_UPLOAD_TIMEOUT_MS = 10 * 60_000;

/** 启动期清单也必须经过统一 HTTP 边界，交付运行时不得自行持有网络能力。 */
export async function loadSceneViewerDeliveryManifest(url: URL): Promise<unknown> {
  const response = await globalThis.fetch(url, {
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(STARTUP_MANIFEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`只读场景清单加载失败（HTTP ${response.status}）`);
  return response.json();
}
export type {
  AiProviderDescriptor,
  BatteryReleaseGateSnapshot,
  CapabilityDescriptor,
  CapabilityInvocationResult,
  IotNbAssessmentResult,
  IotNbSyncResult,
  OperationsSnapshot,
} from "./apiClients/industrialApi.js";
export type {
  ScriptGitCommit,
  ScriptGitCommitResult,
  ScriptGitPullResult,
  ScriptGitPushResult,
  ScriptGitStatus,
} from "./apiClients/scriptGitTypes.js";

const scheduleAuthenticationRecheck = createAuthenticationRecheck(runtimeHost, desktopAwareFetch);
const serverClient = new ServerClient({
  profile: () => sceneViewerDeliveryServerProfile() ?? runtimeHost.getServerProfile(),
  authStore: runtimeHost,
  onUnauthorized: () => scheduleAuthenticationRecheck(),
  fetch: desktopAwareFetch,
  retryRead: path => !isLocalDesktopMode() && !isSceneViewerDeliveryRuntime() && isRecoverableStudioRead(path),
});

export function getAuthToken() {
  return runtimeHost.getAccessToken();
}
export function setAuthToken(token?: string, remember = true) {
  if (token) runtimeHost.setAccessToken(token, remember);
  else runtimeHost.clearAccessToken();
}

export function openDirectBindingWebSocket(): WebSocket {
  const url = new URL(
    "/api/direct-bindings/ws",
    runtimeHost.getServerProfile().baseUrl,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const token = getAuthToken();
  return new WebSocket(url, token ? [`bim-studio-auth.${token}`] : []);
}

const request = <T>(url: string, init?: RequestInit) =>
  serverClient.request<T>(url, init);

export interface UnityUploadProgress {
  phase: "uploading" | "processing";
  percent: number;
}

/** 管理端读取的是脱敏快照；端点和密钥只允许写入。 */
export interface NotificationConfigurationSnapshot {
  channels: Array<
    Omit<NotificationChannel, "endpoint" | "secretRef"> & {
      endpointConfigured: boolean;
      endpointMask?: string;
      secretConfigured: boolean;
    }
  >;
  recipients: NotificationRecipient[];
  rules: NotificationRule[];
  templates: NotificationTemplate[];
}

export interface NotificationChannelInput extends Omit<NotificationChannel, "endpoint" | "secretRef"> {
  endpoint?: string;
  credential?: NotificationCredential;
}

export interface SystemPluginSummary {
  id: string;
  name: string;
  version: string;
  status: "registered" | "enabling" | "enabled" | "disabling" | "faulted";
  configurable: boolean;
  capabilities: string[];
  capabilityIds: string[];
  providerIds: string[];
  diagnostics: Array<{
    operation: "enable" | "disable" | "uninstall";
    message: string;
    timestamp: string;
  }>;
}

function uploadUnityResource(
  projectId: string,
  file: File,
  options: {
    resourceId?: string;
    name?: string;
    onProgress?: (progress: UnityUploadProgress) => void;
  } = {},
): Promise<UnityResourceRecord> {
  const body = new FormData();
  body.append("file", file);
  const query = new URLSearchParams();
  if (options.resourceId) query.set("resourceId", options.resourceId);
  if (options.name) query.set("name", options.name);
  const endpoint = `/api/projects/${projectId}/unity-resources${query.size ? `?${query}` : ""}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      new URL(endpoint, runtimeHost.getServerProfile().baseUrl).toString(),
    );
    xhr.setRequestHeader("accept", "application/json");
    xhr.timeout = UNITY_UPLOAD_TIMEOUT_MS;
    const token = getAuthToken();
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (event) =>
      options.onProgress?.({
        phase: "uploading",
        percent:
          event.lengthComputable && event.total > 0
            ? Math.min(99, Math.round((event.loaded / event.total) * 100))
            : 0,
      });
    xhr.upload.onload = () =>
      options.onProgress?.({ phase: "processing", percent: 100 });
    xhr.onerror = () => reject(new Error("Unity ZIP 上传失败，请检查网络连接"));
    xhr.onabort = () => reject(new Error("Unity ZIP 上传已取消"));
    xhr.ontimeout = () => reject(new Error("Unity ZIP 上传超时，请检查网络后重试"));
    xhr.onload = () => {
      let payload: unknown;
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        payload = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300 && payload)
        return resolve(payload as UnityResourceRecord);
      const message =
        payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message: unknown }).message)
          : `Unity 资源导入失败（HTTP ${xhr.status}）`;
      reject(new Error(message));
    };
    options.onProgress?.({ phase: "uploading", percent: 0 });
    xhr.send(body);
  });
}

async function getExternalJson(url: string): Promise<unknown> {
  const parsed = new URL(url, runtimeHost.getServerProfile().baseUrl);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new Error("外部资源地址必须是无凭据的 HTTP(S) URL");
  const response = await fetch(parsed, {
    credentials: "omit",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(EXTERNAL_JSON_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`外部资源 HTTP ${response.status}`);
  return response.json();
}

export type AssistantMode =
  | "platform"
  | "operations"
  | "vision"
  | "bim"
  | "scene"
  | "component"
  | "dashboard"
  | "sql";

async function streamAssistant(
  mode: AssistantMode,
  question: string,
  context: unknown,
  onDelta: (delta: string) => void,
  options: { projectId?: string; signal?: AbortSignal } = {},
): Promise<AiAssistantResponse> {
  const response = await serverClient.open("/api/ai/assistant/stream", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({ mode, question, context, ...(options.projectId ? { projectId: options.projectId } : {}) }),
    ...(options.signal ? { signal: options.signal } : {}),
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
      const event = block
        .split(/\r?\n/)
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim();
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const payload = JSON.parse(data) as
        | { delta?: string; message?: string }
        | AiAssistantResponse;
      if (event === "delta" && "delta" in payload && payload.delta)
        onDelta(payload.delta);
      if (event === "error")
        throw new Error(
          "message" in payload ? payload.message : "AI 流式请求失败",
        );
      if (event === "done") return payload as AiAssistantResponse;
    }
    if (done) break;
  }
  throw new Error("AI 流式响应意外结束");
}

export const api = {
  getExternalJson,
  getUnityBuildManifest: getExternalJson,
  listUnityResources: (projectId: string) =>
    request<UnityResourceRecord[]>(
      `/api/projects/${projectId}/unity-resources`,
    ),
  uploadUnityResource,
  activateUnityResourceVersion: (
    projectId: string,
    resourceId: string,
    versionId: string,
  ) =>
    request<UnityResourceRecord>(
      `/api/projects/${projectId}/unity-resources/${resourceId}/versions/${versionId}/activate`,
      { method: "POST" },
    ),
  deleteUnityResource: (projectId: string, resourceId: string) =>
    request<void>(`/api/projects/${projectId}/unity-resources/${resourceId}`, {
      method: "DELETE",
    }),
  getMeta: () => serverClient.getMeta(),
  listApplications: (projectId: string, options: { signal?: AbortSignal } = {}) =>
    serverClient.listApplications(projectId, options),
  getApplication: (projectId: string, applicationId: string) =>
    serverClient.getApplication(projectId, applicationId),
  createApplication: (document: ApplicationDocument) =>
    serverClient.createApplication(document),
  saveApplication: (document: ApplicationDocument) =>
    serverClient.saveApplication(document),
  saveApplicationWorkspace: (
    document: ApplicationDocument,
    scene: SceneSnapshot,
  ) => serverClient.saveApplicationWorkspace(document, scene),
  deleteApplication: (projectId: string, applicationId: string) =>
    serverClient.deleteApplication(projectId, applicationId),
  publishApplication: (projectId: string, applicationId: string) =>
    serverClient.publishApplication(projectId, applicationId),
  unpublishApplication: (projectId: string, applicationId: string) =>
    serverClient.unpublishApplication(projectId, applicationId),
  installNpmScriptDependency: (projectId: string, packageName: string, version: string, specifier?: string) =>
    request<ApplicationScriptDependency>(`/api/projects/${encodeURIComponent(projectId)}/script-dependencies/npm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packageName, version, ...(specifier ? { specifier } : {}) }),
    }),
  installExternalScriptDependency: (projectId: string, url: string, specifier: string) =>
    request<ApplicationScriptDependency>(`/api/projects/${encodeURIComponent(projectId)}/script-dependencies/external`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, specifier }),
    }),
  uploadScriptDependency: (projectId: string, specifier: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<ApplicationScriptDependency>(`/api/projects/${encodeURIComponent(projectId)}/script-dependencies/upload?specifier=${encodeURIComponent(specifier)}`, { method: "POST", body });
  },
  readScriptDependency: async (projectId: string, dependencyId: string) =>
    (await serverClient.open(`/api/projects/${encodeURIComponent(projectId)}/script-dependencies/${encodeURIComponent(dependencyId)}/content`)).text(),
  downloadScriptDependency: async (projectId: string, dependencyId: string) =>
    (await serverClient.open(`/api/projects/${encodeURIComponent(projectId)}/script-dependencies/${encodeURIComponent(dependencyId)}/content?download=1`)).blob(),
  deleteScriptDependency: (projectId: string, dependencyId: string) =>
    request<void>(`/api/projects/${encodeURIComponent(projectId)}/script-dependencies/${encodeURIComponent(dependencyId)}`, { method: "DELETE" }),
  getScriptGitStatus: (projectId: string) =>
    request<ScriptGitStatus>(`/api/projects/${encodeURIComponent(projectId)}/script-git/status`),
  listScriptGitHistory: (projectId: string, limit = 20) =>
    request<ScriptGitCommit[]>(`/api/projects/${encodeURIComponent(projectId)}/script-git/history?limit=${limit}`),
  commitScriptSnapshot: (projectId: string, scripts: readonly ScriptModule[], message: string) =>
    request<ScriptGitCommitResult>(`/api/projects/${encodeURIComponent(projectId)}/script-git/commits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scripts, message }),
    }),
  configureScriptGitRemote: (projectId: string, url: string, branch: string) =>
    request<ScriptGitStatus>(`/api/projects/${encodeURIComponent(projectId)}/script-git/remote`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, branch }),
    }),
  removeScriptGitRemote: (projectId: string) =>
    request<ScriptGitStatus>(`/api/projects/${encodeURIComponent(projectId)}/script-git/remote`, { method: "DELETE" }),
  pullScriptGit: (projectId: string) =>
    request<ScriptGitPullResult>(`/api/projects/${encodeURIComponent(projectId)}/script-git/pull`, { method: "POST" }),
  pushScriptGit: (projectId: string) =>
    request<ScriptGitPushResult>(`/api/projects/${encodeURIComponent(projectId)}/script-git/push`, { method: "POST" }),
  getBranding: () => request<SystemBrandingSettings>("/api/public/branding"),
  saveBranding: (settings: Partial<SystemBrandingSettings>) =>
    request<SystemBrandingSettings>("/api/admin/branding", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    }),
  uploadBrandingAsset: (kind: "logo" | "icon", file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<{ url: string; settings: SystemBrandingSettings }>(
      `/api/admin/branding/upload?kind=${kind}`,
      { method: "POST", body },
    );
  },
  login: (username: string, password: string, remember: boolean) =>
    request<{ token: string; user: SystemUserRecord }>("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password, remember }),
    }),
  me: () => request<SystemUserRecord>("/api/auth/me"),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  listUsers: () => request<SystemUserRecord[]>("/api/admin/users"),
  createUser: (user: Partial<SystemUserRecord> & { password: string }) =>
    request<SystemUserRecord>("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(user),
    }),
  updateUser: (
    userId: string,
    patch: Partial<SystemUserRecord> & { password?: string },
  ) =>
    request<SystemUserRecord>(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  deleteUser: (userId: string) =>
    request<void>(`/api/admin/users/${userId}`, { method: "DELETE" }),
  listAuditLogs: () => request<AuditLogRecord[]>("/api/admin/audit?limit=300"),
  listServiceLogs: () => request<ServiceLogRecord[]>("/api/admin/logs"),
  queryServiceLogs: (filters: { service?: string; level?: ServiceLogLevel; from?: string; to?: string; keyword?: string; limit?: number } = {}) =>
    request<ServiceLogQueryResult>(`/api/admin/service-logs?${serviceLogQuery(filters)}`),
  exportServiceLogs: async (filters: { service?: string; level?: ServiceLogLevel; from?: string; to?: string; keyword?: string; limit?: number } = {}) =>
    (await serverClient.open(`/api/admin/service-logs/export?${serviceLogQuery(filters)}`)).blob(),
  getSystemDiagnostics: () => request<SystemDiagnosticSnapshot>("/api/admin/diagnostics"),
  downloadSystemDiagnostics: async () => (await serverClient.open("/api/admin/diagnostics/download")).blob(),
  getNotificationSnapshot: () =>
    request<NotificationConfigurationSnapshot>("/api/admin/notifications/snapshot"),
  listNotificationAudit: () =>
    request<NotificationDeliveryAudit[]>("/api/admin/notifications/audit"),
  saveNotificationChannel: (channel: NotificationChannelInput) =>
    request<{ ok: true }>(`/api/admin/notifications/channels/${encodeURIComponent(channel.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(channel),
    }),
  createNotificationChannel: (channel: NotificationChannelInput) =>
    request<{ ok: true }>("/api/admin/notifications/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(channel),
    }),
  saveNotificationRecipient: (recipient: NotificationRecipient) =>
    request<{ ok: true }>(`/api/admin/notifications/recipients/${encodeURIComponent(recipient.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(recipient),
    }),
  createNotificationRecipient: (recipient: NotificationRecipient) =>
    request<{ ok: true }>("/api/admin/notifications/recipients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(recipient),
    }),
  deleteNotificationRecipient: (recipientId: string) =>
    request<{ ok: true }>(`/api/admin/notifications/recipients/${encodeURIComponent(recipientId)}`, { method: "DELETE" }),
  saveNotificationRule: (rule: NotificationRule) =>
    request<{ ok: true }>(`/api/admin/notifications/rules/${encodeURIComponent(rule.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rule),
    }),
  createNotificationRule: (rule: NotificationRule) =>
    request<{ ok: true }>("/api/admin/notifications/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rule),
    }),
  testNotification: (event: NotificationEvent) =>
    request<{ audit: NotificationDeliveryAudit[] }>("/api/admin/notifications/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }),
  getSystemHealth: () => request<ServiceHealthRecord[]>("/api/admin/health"),
  listConverters: () =>
    serverClient.listConverters() as Promise<ConverterPluginDescriptor[]>,
  getAiSettings: () => request<AiProviderSettings>("/api/admin/ai-settings"),
  listPlugins: () =>
    request<{ plugins: SystemPluginSummary[] }>("/api/plugins"),
  setPluginEnabled: (pluginId: string, enabled: boolean) =>
    request<{ plugin?: SystemPluginSummary }>(
      `/api/admin/plugins/${encodeURIComponent(pluginId)}/status`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      },
    ),
  saveAiSettings: (settings: Partial<AiProviderSettings>) =>
    request<AiProviderSettings>("/api/admin/ai-settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    }),
  testAiSettings: (settings: Partial<AiProviderSettings> = {}) =>
    request<{ ok: boolean; model: string }>("/api/admin/ai-settings/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    }),
  getCloudRenderOverview: () =>
    request<CloudRenderControlOverview>("/api/admin/cloud-render"),
  testCloudRenderConfiguration: (configuration: {
    workerUrl: string;
    workerToken: string;
    publicOrigin: string;
  }) =>
    request<{
      ok: boolean;
      worker: CloudRenderWorkerHealth;
      publicOrigin: string;
    }>("/api/admin/cloud-render/configuration/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(configuration),
    }),
  setCloudRenderEnabled: (sceneId: string, enabled: boolean) =>
    request<CloudRenderScenePolicy>(
      `/api/admin/cloud-render/scenes/${encodeURIComponent(sceneId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      },
    ),
  startCloudRenderSession: (sceneId: string) =>
    request<RemoteRenderSessionSnapshot>(
      `/api/admin/cloud-render/scenes/${encodeURIComponent(sceneId)}/sessions`,
      { method: "POST" },
    ),
  refreshCloudRenderSession: (sceneId: string) =>
    request<RemoteRenderSessionSnapshot>(
      `/api/admin/cloud-render/scenes/${encodeURIComponent(sceneId)}/sessions/current`,
    ),
  stopCloudRenderSession: (sceneId: string) =>
    request<void>(
      `/api/admin/cloud-render/scenes/${encodeURIComponent(sceneId)}/sessions/current`,
      { method: "DELETE" },
    ),
  executeDirectBinding: (
    binding: DirectBindingSpec,
    variables: Record<string, DirectBindingTemplateValue> = {},
  ) =>
    request<{ ok: true; status: number; data: unknown; value: unknown }>(
      "/api/direct-bindings/http",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ binding, variables }),
      },
    ),
  askAssistant: (mode: AssistantMode, question: string, context: unknown, projectId?: string) =>
    request<AiAssistantResponse>("/api/ai/assistant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, question, context, ...(projectId ? { projectId } : {}) }),
    }),
  streamAssistant,
  listProjects: (options: { signal?: AbortSignal } = {}) => request<ProjectRecord[]>("/api/projects", options),
  createProject: (name: string, description = "") =>
    request<ProjectRecord>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description }),
    }),
  updateProject: (projectId: string, name: string, description = "") =>
    request<ProjectRecord>(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description }),
    }),
  deleteProject: (projectId: string) =>
    request<void>(`/api/projects/${projectId}`, { method: "DELETE" }),
  getProject: (projectId: string) =>
    request<ProjectRecord>(`/api/projects/${projectId}`),
  listDataConnections: (projectId: string) =>
    request<DataConnectionRecord[]>(
      `/api/projects/${projectId}/data-connections`,
    ),
  listDataConnectionDiagnostics: (projectId: string) =>
    request<DataConnectorDiagnostics[]>(
      `/api/projects/${projectId}/data-connections/diagnostics`,
    ),
  createDataConnection: (
    projectId: string,
    connection: Partial<DataConnectionRecord>,
  ) =>
    request<DataConnectionRecord>(
      `/api/projects/${projectId}/data-connections`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(connection),
      },
    ),
  testDataConnection: (
    projectId: string,
    connectionId: string,
    datasetId?: string,
  ) =>
    request<{
      ok: boolean;
      status: "healthy" | "offline";
      durationMs: number;
      rowCount: number;
      fieldCount: number;
      checkedAt: string;
      message?: string;
    }>(`/api/projects/${projectId}/data-connections/${connectionId}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(datasetId ? { datasetId } : {}),
    }),
  writeDataPoint: (
    projectId: string,
    connectionId: string,
    payload: {
      address: string;
      value: unknown;
      propertyId?: number;
      priority?: number;
    },
  ) =>
    request<{ address: string; value: unknown; writtenAt: string }>(
      `/api/projects/${projectId}/data-connections/${connectionId}/write`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    ),
  deleteDataConnection: (projectId: string, connectionId: string) =>
    request<void>(
      `/api/projects/${projectId}/data-connections/${connectionId}`,
      { method: "DELETE" },
    ),
  listDatasets: (projectId: string) =>
    request<DataDatasetRecord[]>(`/api/projects/${projectId}/datasets`),
  listAiDataBindings: (projectId: string) =>
    request<AiDataBinding[]>(`/api/projects/${projectId}/ai-data-bindings`),
  saveAiDataBinding: (projectId: string, binding: Partial<AiDataBinding>) =>
    request<AiDataBinding>(
      binding.id
        ? `/api/projects/${projectId}/ai-data-bindings/${encodeURIComponent(binding.id)}`
        : `/api/projects/${projectId}/ai-data-bindings`,
      {
        method: binding.id ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(binding),
      },
    ),
  deleteAiDataBinding: (projectId: string, bindingId: string) =>
    request<void>(`/api/projects/${projectId}/ai-data-bindings/${encodeURIComponent(bindingId)}`, { method: "DELETE" }),
  listAiDataBindingRuns: (projectId: string, options: { bindingId?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.bindingId) query.set("bindingId", options.bindingId);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return request<AiDataBindingRunRecord[]>(`/api/projects/${projectId}/ai-data-binding-runs${query.size ? `?${query}` : ""}`);
  },
  createDataset: (projectId: string, dataset: Omit<Partial<DataDatasetRecord>, "writeback"> & { writeback?: DataDatasetRecord["writeback"] | null }) =>
    request<DataDatasetRecord>(`/api/projects/${projectId}/datasets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dataset),
    }),
  previewDataset: (projectId: string, datasetId: string) =>
    request<DataDatasetPreview>(
      `/api/projects/${projectId}/datasets/${datasetId}/preview`,
    ),
  deleteDataset: (projectId: string, datasetId: string) =>
    request<void>(`/api/projects/${projectId}/datasets/${datasetId}`, {
      method: "DELETE",
    }),
  listDataPipelines: (projectId: string) =>
    request<DataPipelineDefinition[]>(
      `/api/projects/${projectId}/data-pipelines`,
    ),
  saveDataPipeline: (
    projectId: string,
    pipeline: Partial<DataPipelineDefinition>,
  ) =>
    request<DataPipelineDefinition>(
      `/api/projects/${projectId}/data-pipelines`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pipeline),
      },
    ),
  previewDataPipeline: (projectId: string, pipelineId: string, throughNodeId?: string) =>
    request<DataPipelinePreview>(
      `/api/projects/${projectId}/data-pipelines/${pipelineId}/preview${throughNodeId ? `?throughNodeId=${encodeURIComponent(throughNodeId)}` : ""}`,
    ),
  deleteDataPipeline: (projectId: string, pipelineId: string) =>
    request<void>(`/api/projects/${projectId}/data-pipelines/${pipelineId}`, {
      method: "DELETE",
    }),
  listDataEndpoints: (projectId: string) =>
    request<DataEndpointDefinition[]>(
      `/api/projects/${projectId}/data-endpoints`,
    ),
  saveDataEndpoint: (
    projectId: string,
    endpoint: Partial<DataEndpointDefinition> & { rotateKey?: boolean },
  ) =>
    request<DataEndpointSaveResult>(
      `/api/projects/${projectId}/data-endpoints`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(endpoint),
      },
    ),
  testDataEndpoint: (projectId: string, endpointId: string) =>
    request<DataPipelinePreview>(
      `/api/projects/${projectId}/data-endpoints/${endpointId}/test`,
      { method: "POST" },
    ),
  deleteDataEndpoint: (projectId: string, endpointId: string) =>
    request<void>(`/api/projects/${projectId}/data-endpoints/${endpointId}`, {
      method: "DELETE",
    }),
  resolveLiveMonitor: (sourceUrl: string, playback: "hls" | "webrtc") =>
    request<{ path: string; hlsUrl: string; webRtcUrl: string }>(
      "/api/live-monitor/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceUrl, playback }),
      },
    ),
  ...createVisionApi(request),
  ...createDataWritebackApi(request),
  ...createIndustrialApi(request),
  ...createPprBopApi(request),
  ...createModelSceneApi(request),
  ...createAssetLibraryApi(request),
  ...createIndustrialAgentApi(request),
  ...createSemanticModelApi(request),
};

function serviceLogQuery(filters: { service?: string; level?: ServiceLogLevel; from?: string; to?: string; keyword?: string; limit?: number }): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) if (value !== undefined && value !== "") query.set(name, String(value));
  return query.toString();
}

import type { NodeRedHealth } from "./apiNodeRed";
/** Node-RED 独立进程健康探针；离线时前端显示明确状态而不是白屏（U1-8c）。 */
export async function fetchNodeRedHealth(signal?: AbortSignal): Promise<NodeRedHealth> {
  return request<NodeRedHealth>("/api/node-red/health", signal ? { signal } : undefined);
}
