import type {
  ApplicationDocument,
  PublishedApplicationRecord,
  ServerMetaResponse
} from "@bim-studio/contracts";
import { assertPathSafeResourceId } from "@bim-studio/contracts";

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
  profile: ServerProfile;
  authStore: AuthStore;
  fetch?: typeof globalThis.fetch;
  onUnauthorized?: () => void;
}

export class ServerClient {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: ServerClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async open(path: string, init?: RequestInit): Promise<Response> {
    const url = resolveApiUrl(path, this.options.profile.baseUrl);
    const headers = new Headers(init?.headers);
    const token = await this.options.authStore.getAccessToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await this.fetchImpl(
      url,
      { ...init, headers }
    );
    if (!response.ok) {
      const body = await response.clone().json().catch(() => ({ message: response.statusText })) as { message?: string };
      if (response.status === 401) this.options.onUnauthorized?.();
      throw new Error(body.message ?? `请求失败：${response.status}`);
    }
    return response;
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.open(path, init);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  getMeta(): Promise<ServerMetaResponse> {
    return this.request("/api/meta");
  }

  listApplications(projectId: string): Promise<ApplicationDocument[]> {
    assertPathSafeResourceId(projectId, "projectId");
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/applications`);
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
