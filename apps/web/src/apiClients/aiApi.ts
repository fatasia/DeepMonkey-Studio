import type {
  AiAssistantResponse,
  AiDataBinding,
  AiDataBindingRunRecord,
  AiModelCatalogResult,
  AiProviderSettings,
  AiTelemetrySummary,
} from "@bim-studio/contracts";
import { readAssistantStream } from "./assistantStream";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;
type ApiOpen = (url: string, init?: RequestInit) => Promise<Response>;
export interface AssistantSessionOptions { model?: string; reasoningEffort?: "minimal" | "standard" | "deep" }
interface AssistantStreamOptions extends AssistantSessionOptions {
  projectId?: string;
  signal?: AbortSignal;
  onExecution?: (execution: AiAssistantResponse["execution"]) => void;
}
export interface AssistantSessionCatalog {
  defaultModel: string;
  models: Array<{ id: string; reasoningEfforts: Array<NonNullable<AssistantSessionOptions["reasoningEffort"]>> }>;
  catalogAvailable: boolean;
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
  open: ApiOpen,
  mode: AssistantMode,
  question: string,
  context: unknown,
  onDelta: (delta: string) => void,
  options: AssistantStreamOptions = {},
): Promise<AiAssistantResponse> {
  const response = await open("/api/ai/assistant/stream", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({ mode, question, context, ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.model ? { model: options.model } : {}), ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return readAssistantStream(response, onDelta, options.signal, options.onExecution);
}

/** AI 助手、模型目录与 AI 数据绑定接口保持在独立领域客户端，避免共享 API 门面继续膨胀。 */
export function createAiApi(request: ApiRequest, open: ApiOpen) {
  return {
    getAssistantModels: () => request<AssistantSessionCatalog>("/api/ai/assistant/models"),
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
      options: AssistantStreamOptions = {},
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
