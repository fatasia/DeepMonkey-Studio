import type {
  AiAssistantResponse,
  AiDataBinding,
  AiDataBindingRunRecord,
  AiModelCatalogResult,
  AiProviderSettings,
  AiTelemetrySummary,
} from "@bim-studio/contracts";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;
type ApiOpen = (url: string, init?: RequestInit) => Promise<Response>;

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
  open: ApiOpen,
  mode: AssistantMode,
  question: string,
  context: unknown,
  onDelta: (delta: string) => void,
  options: { projectId?: string; signal?: AbortSignal } = {},
): Promise<AiAssistantResponse> {
  const response = await open("/api/ai/assistant/stream", {
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

/** AI 助手、模型目录与 AI 数据绑定接口保持在独立领域客户端，避免共享 API 门面继续膨胀。 */
export function createAiApi(request: ApiRequest, open: ApiOpen) {
  return {
    getAiSettings: () => request<AiProviderSettings>("/api/admin/ai-settings"),
    saveAiSettings: (settings: Partial<AiProviderSettings>) =>
      request<AiProviderSettings>("/api/admin/ai-settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      }),
    fetchAiModels: (settings: Partial<AiProviderSettings> & { refresh?: boolean } = {}) =>
      request<AiModelCatalogResult>("/api/admin/ai-settings/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      }),
    getAiTelemetry: () =>
      request<{ settings: AiProviderSettings; telemetry: AiTelemetrySummary }>("/api/admin/ai-settings/telemetry"),
    testAiSettings: (settings: Partial<AiProviderSettings> = {}) =>
      request<{ ok: boolean; model: string }>("/api/admin/ai-settings/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      }),
    askAssistant: (mode: AssistantMode, question: string, context: unknown, projectId?: string) =>
      request<AiAssistantResponse>("/api/ai/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, question, context, ...(projectId ? { projectId } : {}) }),
      }),
    streamAssistant: (
      mode: AssistantMode,
      question: string,
      context: unknown,
      onDelta: (delta: string) => void,
      options: { projectId?: string; signal?: AbortSignal } = {},
    ) => streamAssistant(open, mode, question, context, onDelta, options),
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
  };
}
