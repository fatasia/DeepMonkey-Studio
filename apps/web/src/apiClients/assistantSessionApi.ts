import type { AiSessionList, AiSessionMessage, AiSessionMessageInput, AiSessionMessages, AiSessionSummary } from "@bim-studio/contracts";

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
const segment = encodeURIComponent;
const base = (project: string) => `/api/projects/${segment(project)}/ai/assistant-sessions`;
const page = (after?: string) => `?limit=50${after ? `&after=${segment(after)}` : ""}`;
const put = (body: unknown): RequestInit => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function createAssistantSessionApi(request: Request) {
  return {
    listAssistantSessions: (project: string, after?: string) => request<AiSessionList>(base(project) + page(after)),
    createAssistantSession: (project: string, id: string, title: string) => request<AiSessionSummary>(`${base(project)}/${segment(id)}`, put({ title })),
    getAssistantSessionMessages: (project: string, id: string, after?: string) => request<AiSessionMessages>(`${base(project)}/${segment(id)}/messages${page(after)}`),
    saveAssistantSessionMessage: (project: string, session: string, id: string, input: AiSessionMessageInput) =>
      request<AiSessionMessage>(`${base(project)}/${segment(session)}/messages/${segment(id)}`, put(input)),
  };
}
