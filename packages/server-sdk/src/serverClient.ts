import type {
  ApplicationDocument,
  PublishedApplicationRecord,
  ServerMetaResponse
} from "@bim-studio/contracts";

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
    const headers = new Headers(init?.headers);
    const token = await this.options.authStore.getAccessToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await this.fetchImpl(
      new URL(path, normalizedBase(this.options.profile.baseUrl)),
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
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/applications`);
  }

  getApplication(projectId: string, applicationId: string): Promise<ApplicationDocument> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/applications/${encodeURIComponent(applicationId)}`);
  }

  createApplication(document: ApplicationDocument): Promise<ApplicationDocument> {
    return this.request(
      `/api/projects/${encodeURIComponent(document.metadata.projectId)}/applications`,
      json("POST", document)
    );
  }

  saveApplication(document: ApplicationDocument): Promise<ApplicationDocument> {
    return this.request(
      `/api/projects/${encodeURIComponent(document.metadata.projectId)}/applications/${encodeURIComponent(document.metadata.id)}`,
      json("PUT", document)
    );
  }

  deleteApplication(projectId: string, applicationId: string): Promise<void> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/applications/${encodeURIComponent(applicationId)}`,
      { method: "DELETE" }
    );
  }

  publishApplication(projectId: string, applicationId: string): Promise<PublishedApplicationRecord> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/applications/${encodeURIComponent(applicationId)}/publish`,
      { method: "POST" }
    );
  }

  unpublishApplication(projectId: string, applicationId: string): Promise<void> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/applications/${encodeURIComponent(applicationId)}/publish`,
      { method: "DELETE" }
    );
  }
}

function normalizedBase(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/`;
}

function json(method: "POST" | "PUT", body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}
