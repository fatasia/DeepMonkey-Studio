import type { AiSessionList, AiSessionMessage, AiSessionMessageInput, AiSessionMessages, AiSessionSummary } from "@bim-studio/contracts";

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
const segment = encodeURIComponent;
const base = (project: string) => `/api/projects/${segment(project)}/ai/assistant-sessions`;
const page = (after?: string) => `?limit=50${after ? `&after=${segment(after)}` : ""}`;
const put = (body: unknown, ifMatch?: string): RequestInit => ({
  method: "PUT",
  headers: { "content-type": "application/json", ...(ifMatch ? { "if-match": ifMatch } : {}) },
  body: JSON.stringify(body),
});

export function createAssistantSessionApi(request: Request) {
  return {
    listAssistantSessions: (project: string, after?: string) => request<AiSessionList>(base(project) + page(after)),
    createAssistantSession: (project: string, id: string, title: string) => request<AiSessionSummary>(`${base(project)}/${segment(id)}`, put({ title })),
    getAssistantSessionMessages: (project: string, id: string, after?: string) => request<AiSessionMessages>(`${base(project)}/${segment(id)}/messages${page(after)}`),
    // K12 条件写：ifMatch 为上一轮保存成功返回的服务端版本（updatedAt），不匹配时服务端返回 409 防静默覆盖。
    saveAssistantSessionMessage: (project: string, session: string, id: string, input: AiSessionMessageInput, ifMatch?: string) =>
      request<AiSessionMessage>(`${base(project)}/${segment(session)}/messages/${segment(id)}`, put(input, ifMatch)),
  };
}
