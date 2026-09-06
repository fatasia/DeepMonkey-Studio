import type {
  ApplicationDocument,
  ConversionTaskRecord,
  ConverterPluginDescriptor,
  PublishedApplicationRecord,
  SceneSnapshot,
  ServerMetaResponse,
  SubmitConversionTaskRequest,
} from "@bim-studio/contracts";
import { assertPathSafeResourceId } from "@bim-studio/contracts";
import { recoverReadOnce } from "./readRecovery.js";

export type Awaitable<T> = T | Promise<T>;

export interface ServerProfile {
  baseUrl: string;
}

export interface AuthStore {
  getAccessToken(): Awaitable<string | undefined>;
  setAccessToken(token: string, persistent: boolean): Awaitable<void>;
  clearAccessToken(): Awaitable<void>;
}

export interface ServerClientOptions {
  profile: ServerProfile | (() => Awaitable<ServerProfile>);
  authStore: AuthStore;
  fetch?: typeof globalThis.fetch;
  onUnauthorized?: () => void;
  /** 默认不自动重试；调用方只为已确认的只读路径开启一次有限恢复。 */
  retryRead?: (pathname: string) => boolean;
}

/** 保留 HTTP 状态和服务端结构化信息，调用方才能区分冲突、权限与暂时离线。 */
export class ServerRequestError extends Error {
  readonly name = "ServerRequestError";

  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

export class ServerClient {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: ServerClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async open(path: string, init?: RequestInit): Promise<Response> {
    init?.signal?.throwIfAborted();
    const profile = typeof this.options.profile === "function"
      ? await this.options.profile()
      : this.options.profile;
    const url = resolveApiUrl(path, profile.baseUrl);
    const baseUrl = profile.baseUrl;
    const headers = new Headers(init?.headers);
    const token = await this.options.authStore.getAccessToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    init?.signal?.throwIfAborted();
    // 固化原请求，退避期间调用方修改 RequestInit 也不能把读取变为写入。
    const requestInit = { ...init, headers };
    const attempt = () => this.fetchImpl(url, { ...requestInit });
    const canRetry = ["GET", "HEAD"].includes((requestInit.method ?? "GET").toUpperCase())
      && requestInit.body == null && this.options.retryRead?.(url.pathname) === true;
    const response = canRetry ? await recoverReadOnce(attempt, async () => {
      const current = typeof this.options.profile === "function" ? await this.options.profile() : this.options.profile;
      if (current.baseUrl !== baseUrl || (await this.options.authStore.getAccessToken()) !== token) {
        throw new DOMException("读取上下文已变化，请重新加载", "AbortError");
      }
    }, requestInit.signal) : await attempt();
    if (!response.ok) {
      const body: unknown = await response.clone().json().catch(() => ({ message: response.statusText }));
      // 只有携带了当前登录凭据的请求才可能证明会话失效；公开接口自身的 401 不能登出用户。
      if (response.status === 401 && token) this.options.onUnauthorized?.();
      throw new ServerRequestError(requestErrorMessage(body, response.status), response.status, body);
    }
    return response;
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.open(path, init);
    if (response.status === 204) return undefined as T;
    const body = await response.text();
    if (!body.trim()) {
      throw new ServerRequestError(`服务返回空响应（HTTP ${response.status}）`, response.status, null);
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new ServerRequestError(`服务返回了无法解析的数据（HTTP ${response.status}）`, response.status, {
        contentType: response.headers.get("content-type"),
      });
    }
  }

  getMeta(): Promise<ServerMetaResponse> {
    return this.request("/api/meta");
  }

  listApplications(projectId: string, options: { signal?: AbortSignal } = {}): Promise<ApplicationDocument[]> {
    assertPathSafeResourceId(projectId, "projectId");
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/applications`, options);
  }

  getApplication(projectId: string, applicationId: string): Promise<ApplicationDocument> {
    assertPathSafeResourceId(projectId, "projectId");
    assertPathSafeResourceId(applicationId, "applicationId");
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/applications/${encodeURIComponent(applicationId)}`);
  }

  createApplication(document: ApplicationDocument): Promise<ApplicationDocument> {
    assertPathSafeResourceId(document.metadata.projectId, "projectId");
    assertPathSafeResourceId(document.metadata.id, "applicationId");
    return this.request(
      `/api/projects/${encodeURIComponent(document.metadata.projectId)}/applications`,
      json("POST", document)
    );
  }

  saveApplication(document: ApplicationDocument): Promise<ApplicationDocument> {
    assertPathSafeResourceId(document.metadata.projectId, "projectId");
    assertPathSafeResourceId(document.metadata.id, "applicationId");
    return this.request(
      `/api/projects/${encodeURIComponent(document.metadata.projectId)}/applications/${encodeURIComponent(document.metadata.id)}`,
      json("PUT", document)
    );
  }

  saveApplicationWorkspace(document: ApplicationDocument, scene: SceneSnapshot): Promise<{ application: ApplicationDocument; scene: SceneSnapshot }> {
    assertPathSafeResourceId(document.metadata.projectId, "projectId");
    assertPathSafeResourceId(document.metadata.id, "applicationId");
    return this.request(
      `/api/projects/${encodeURIComponent(document.metadata.projectId)}/applications/${encodeURIComponent(document.metadata.id)}/workspace`,
      json("PUT", { application: document, scene })
    );
  }

  deleteApplication(projectId: string, applicationId: string): Promise<void> {
    assertPathSafeResourceId(projectId, "projectId");
    assertPathSafeResourceId(applicationId, "applicationId");
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/applications/${encodeURIComponent(applicationId)}`,
      { method: "DELETE" }
    );
  }

  publishApplication(projectId: string, applicationId: string): Promise<PublishedApplicationRecord> {
    assertPathSafeResourceId(projectId, "projectId");
    assertPathSafeResourceId(applicationId, "applicationId");
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/applications/${encodeURIComponent(applicationId)}/publish`,
      { method: "POST" }
    );
  }

  unpublishApplication(projectId: string, applicationId: string): Promise<void> {
    assertPathSafeResourceId(projectId, "projectId");
    assertPathSafeResourceId(applicationId, "applicationId");
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/applications/${encodeURIComponent(applicationId)}/publish`,
      { method: "DELETE" }
    );
  }

  listConverters(): Promise<ConverterPluginDescriptor[]> {
    return this.request("/api/converters");
  }

  submitConversion(request: SubmitConversionTaskRequest): Promise<ConversionTaskRecord> {
    assertPathSafeResourceId(request.projectId, "projectId");
    const { projectId, ...body } = request;
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/conversion-tasks`,
      json("POST", body),
    );
  }

  listConversionTasks(projectId: string): Promise<ConversionTaskRecord[]> {
    assertPathSafeResourceId(projectId, "projectId");
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/conversion-tasks`);
  }

  getConversionTask(projectId: string, taskId: string): Promise<ConversionTaskRecord> {
    assertPathSafeResourceId(projectId, "projectId");
    assertPathSafeResourceId(taskId, "taskId");
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/conversion-tasks/${encodeURIComponent(taskId)}`);
  }

  cancelConversionTask(projectId: string, taskId: string): Promise<ConversionTaskRecord> {
    assertPathSafeResourceId(projectId, "projectId");
    assertPathSafeResourceId(taskId, "taskId");
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/conversion-tasks/${encodeURIComponent(taskId)}/cancel`,
      { method: "POST" },
    );
  }
}

function requestErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const { message, error } = body as { message?: unknown; error?: unknown };
    if (typeof message === "string" && message.trim()) return message;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string" && error.message.trim()) return error.message;
  }
  return `请求失败：${status}`;
}

function resolveApiUrl(path: string, baseUrl: string): URL {
  if (!path.startsWith("/api")
    || (path.length > 4 && path[4] !== "/" && path[4] !== "?")
    || path.startsWith("//")
    || path.includes("\\")
    || path.includes("#")
    || /%(?:2f|5c)/i.test(path)) {
    throw new TypeError("ServerClient accepts only a root-relative same-origin API path");
  }

  let configured: URL;
  try {
    configured = new URL(baseUrl);
  } catch {
    throw new TypeError("ServerClient profile baseUrl must be an absolute HTTP(S) URL");
  }
  if ((configured.protocol !== "http:" && configured.protocol !== "https:")
    || configured.username
    || configured.password) {
    throw new TypeError("ServerClient profile baseUrl must be an absolute HTTP(S) URL");
  }

  const origin = new URL("/", configured);
  const resolved = new URL(path, origin);
  if (resolved.origin !== origin.origin
    || (resolved.pathname !== "/api" && !resolved.pathname.startsWith("/api/"))) {
    throw new TypeError("ServerClient accepts only a root-relative same-origin API path");
  }
  return resolved;
}

function json(method: "POST" | "PUT", body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}
