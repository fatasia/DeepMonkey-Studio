import type { AiProvider, AiProviderRequest, AiProviderStreamEvent } from "@bim-studio/plugin-runtime";

type Protocol = "auto" | "responses" | "chat-completions";
type ReasoningEffort = "minimal" | "standard" | "deep";
interface ProviderConfig { baseUrl: string; apiKey: string; protocol: Protocol; reasoningEffort?: ReasoningEffort }
const MAX_PROVIDER_OUTPUT_CHARS = 1_000_000;
const MAX_SSE_EVENT_CHARS = 256_000;

export class AiProviderHttpError extends Error {
  constructor(readonly status: number, message?: string) {
    super(message ?? `大模型请求失败：HTTP ${status}`);
    this.name = "AiProviderHttpError";
  }
}

/** OpenAI 兼容协议插件；厂商选择、密钥和模型均由宿主请求注入。 */
export function createOpenAiCompatibleProvider(): AiProvider {
  return {
    descriptor: {
      id: "ai.openai-compatible",
      version: "1.0.0",
      label: "OpenAI 兼容模型",
      execution: "in-process",
      permissions: ["ai.invoke"],
      streaming: true,
      timeoutMs: 90_000
    },
    async complete(request, context) {
      const config = providerConfig(request);
      const content = config.protocol === "responses"
        ? await completeResponses(request, config, context.signal)
        : await completeChatWithFallback(request, config, context.signal);
      return { text: content.text, model: request.model, ...(content.usage ? { usage: content.usage } : {}) };
    },
    async *stream(request, context) {
      const config = providerConfig(request);
      let useResponses = config.protocol === "responses";
      let response = await sendStreamRequest(request, config, useResponses, context.signal);
      if (!response.ok && config.protocol === "auto") {
        const failure = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
        if (shouldUseResponses(response.status, failure?.error)) {
          useResponses = true;
          response = await sendStreamRequest(request, config, true, context.signal);
        } else {
          throw new AiProviderHttpError(response.status, failure?.error?.message);
        }
      }
      if (!response.ok) throw new AiProviderHttpError(response.status, await responseError(response));
      if (!response.body) throw new Error("大模型未返回流式响应");
      for await (const data of sseData(response.body)) {
        if (data === "[DONE]") continue;
        const parsed = JSON.parse(data) as { type?: string; delta?: string; choices?: Array<{ delta?: { content?: string } }>; usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number } };
        const delta = parsed.type === "response.output_text.delta" ? parsed.delta : parsed.choices?.[0]?.delta?.content;
        if (delta) yield { type: "delta", delta } satisfies AiProviderStreamEvent;
        if (parsed.usage) {
          const inputTokens = parsed.usage.input_tokens ?? parsed.usage.prompt_tokens;
          const outputTokens = parsed.usage.output_tokens ?? parsed.usage.completion_tokens;
          yield {
            type: "usage",
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {})
          } satisfies AiProviderStreamEvent;
        }
      }
    }
  };
}

interface CompletionContent { text: string; usage?: { inputTokens?: number; outputTokens?: number } }

async function completeChatWithFallback(request: AiProviderRequest, config: ProviderConfig, signal: AbortSignal): Promise<CompletionContent> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(config.apiKey),
    body: JSON.stringify(chatCompletionsBody(request, false)),
    signal
  });
  const body = await response.json().catch(() => undefined) as {
    choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { code?: string; message?: string };
  } | undefined;
  if (!response.ok && config.protocol === "auto" && shouldUseResponses(response.status, body?.error)) return completeResponses(request, config, signal);
  if (!response.ok) throw new AiProviderHttpError(response.status, body?.error?.message);
  return {
    text: requireContent(body?.choices?.[0]?.message?.content),
    ...(body?.usage ? { usage: usageFromChat(body.usage) } : {}),
  };
}

async function completeResponses(request: AiProviderRequest, config: ProviderConfig, signal: AbortSignal): Promise<CompletionContent> {
  const response = await fetch(`${config.baseUrl}/responses`, {
    method: "POST",
    headers: headers(config.apiKey),
    body: JSON.stringify(responsesBody(request, false)),
    signal
  });
  const body = await response.json().catch(() => undefined) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  } | undefined;
  if (!response.ok) throw new AiProviderHttpError(response.status, body?.error?.message);
  return {
    text: requireContent(body?.output_text ?? body?.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text),
    ...(body?.usage ? { usage: usageFromResponses(body.usage) } : {}),
  };
}

function sendStreamRequest(request: AiProviderRequest, config: ProviderConfig, responses: boolean, signal: AbortSignal): Promise<Response> {
  const body = responses
    ? responsesBody(request, true)
    : chatCompletionsBody(request, true);
  return fetch(`${config.baseUrl}/${responses ? "responses" : "chat/completions"}`, {
    method: "POST", headers: headers(config.apiKey), body: JSON.stringify(body), signal
  });
}

/** 思考深度映射：responses 协议走 reasoning.effort；chat 兼容协议走 reasoning_effort。
 * 未配置时保持历史行为（gpt-5* 默认 effort low），配置后按 minimal/standard/deep 映射。 */
function responsesBody(request: AiProviderRequest, stream: boolean) {
  return {
    model: request.model,
    instructions: request.instructions,
    input: request.input,
    stream,
    max_output_tokens: request.maxOutputTokens,
    ...reasoningParam(request, "responses")
  };
}

function chatCompletionsBody(request: AiProviderRequest, stream: boolean) {
  return {
    model: request.model,
    temperature: request.temperature,
    stream,
    messages: messages(request),
    ...reasoningParam(request, "chat-completions")
  };
}

function reasoningParam(request: AiProviderRequest, protocol: Protocol): Record<string, unknown> {
  const configured = request.config.reasoningEffort;
  if (configured === "minimal" || configured === "standard" || configured === "deep") {
    return protocol === "responses"
      ? { reasoning: { effort: RESPONSES_EFFORT[configured] } }
      : { reasoning_effort: CHAT_EFFORT[configured] };
  }
  // 未配置思考深度：保留历史默认，避免存量部署行为变化。
  return protocol === "responses" && request.model.toLowerCase().startsWith("gpt-5") ? { reasoning: { effort: "low" } } : {};
}

const RESPONSES_EFFORT: Record<Exclude<ReasoningEffort, never>, string> = { minimal: "minimal", standard: "medium", deep: "high" };
const CHAT_EFFORT: Record<Exclude<ReasoningEffort, never>, string> = { minimal: "low", standard: "medium", deep: "high" };

function messages(request: AiProviderRequest) {
  return [{ role: "system", content: request.instructions }, { role: "user", content: request.input }];
}

function providerConfig(request: AiProviderRequest): ProviderConfig {
  const baseUrl = typeof request.config.baseUrl === "string" ? request.config.baseUrl.replace(/\/$/, "") : "";
  const apiKey = typeof request.config.apiKey === "string" ? request.config.apiKey : "";
  const protocol = request.config.protocol === "responses" || request.config.protocol === "chat-completions" ? request.config.protocol : "auto";
  const reasoningEffort = request.config.reasoningEffort === "minimal" || request.config.reasoningEffort === "standard" || request.config.reasoningEffort === "deep"
    ? request.config.reasoningEffort
    : undefined;
  if (!baseUrl || !apiKey) throw new Error("AI provider 缺少 Base URL 或 API Key");
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new Error("AI provider Base URL 无效"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("AI provider Base URL 只能使用无凭据、无查询参数的 HTTP(S) 地址");
  return { baseUrl, apiKey, protocol, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > MAX_SSE_EVENT_CHARS) throw new Error("大模型流式事件超过安全大小限制");
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data) yield data;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function headers(apiKey: string): Record<string, string> {
  return { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${apiKey}` };
}

function shouldUseResponses(status: number, error?: { code?: string; message?: string }): boolean {
  return error?.code === "protocol_not_supported" || status === 404 || /responses?\s*api|不支持.*chat/i.test(error?.message ?? "");
}

async function responseError(response: Response): Promise<string> {
  const failure = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
  return failure?.error?.message ?? `大模型请求失败：HTTP ${response.status}`;
}

function requireContent(value: string | undefined): string {
  const content = value?.trim();
  if (!content) throw new Error("大模型没有返回内容");
  if (content.length > MAX_PROVIDER_OUTPUT_CHARS) throw new Error("大模型返回内容超过安全大小限制");
  return content;
}

function usageFromChat(usage: { prompt_tokens?: number; completion_tokens?: number }) {
  return {
    ...(usage.prompt_tokens !== undefined ? { inputTokens: usage.prompt_tokens } : {}),
    ...(usage.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
  };
}

function usageFromResponses(usage: { input_tokens?: number; output_tokens?: number }) {
  return {
    ...(usage.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
    ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
  };
}
