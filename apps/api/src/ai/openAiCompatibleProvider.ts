import type { AiProvider, AiProviderRequest, AiProviderStreamEvent } from "@bim-studio/plugin-runtime";

type Protocol = "auto" | "responses" | "chat-completions";
interface ProviderConfig { baseUrl: string; apiKey: string; protocol: Protocol }
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
      return { text: content, model: request.model };
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
        const parsed = JSON.parse(data) as { type?: string; delta?: string; choices?: Array<{ delta?: { content?: string } }>; usage?: { input_tokens?: number; output_tokens?: number } };
        const delta = parsed.type === "response.output_text.delta" ? parsed.delta : parsed.choices?.[0]?.delta?.content;
        if (delta) yield { type: "delta", delta } satisfies AiProviderStreamEvent;
        if (parsed.usage) yield {
          type: "usage",
          ...(parsed.usage.input_tokens !== undefined ? { inputTokens: parsed.usage.input_tokens } : {}),
          ...(parsed.usage.output_tokens !== undefined ? { outputTokens: parsed.usage.output_tokens } : {})
        } satisfies AiProviderStreamEvent;
      }
    }
  };
}

async function completeChatWithFallback(request: AiProviderRequest, config: ProviderConfig, signal: AbortSignal): Promise<string> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(config.apiKey),
    body: JSON.stringify({ model: request.model, temperature: request.temperature, messages: messages(request) }),
    signal
  });
  const body = await response.json().catch(() => undefined) as { choices?: Array<{ message?: { content?: string } }>; error?: { code?: string; message?: string } } | undefined;
  if (!response.ok && config.protocol === "auto" && shouldUseResponses(response.status, body?.error)) return completeResponses(request, config, signal);
  if (!response.ok) throw new AiProviderHttpError(response.status, body?.error?.message);
  return requireContent(body?.choices?.[0]?.message?.content);
}

async function completeResponses(request: AiProviderRequest, config: ProviderConfig, signal: AbortSignal): Promise<string> {
  const response = await fetch(`${config.baseUrl}/responses`, {
    method: "POST",
    headers: headers(config.apiKey),
    body: JSON.stringify(responsesBody(request, false)),
    signal
  });
  const body = await response.json().catch(() => undefined) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    error?: { message?: string };
  } | undefined;
  if (!response.ok) throw new AiProviderHttpError(response.status, body?.error?.message);
  return requireContent(body?.output_text ?? body?.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text);
}

function sendStreamRequest(request: AiProviderRequest, config: ProviderConfig, responses: boolean, signal: AbortSignal): Promise<Response> {
  const body = responses
    ? responsesBody(request, true)
    : { model: request.model, temperature: request.temperature, stream: true, messages: messages(request) };
  return fetch(`${config.baseUrl}/${responses ? "responses" : "chat/completions"}`, {
    method: "POST", headers: headers(config.apiKey), body: JSON.stringify(body), signal
  });
}

function responsesBody(request: AiProviderRequest, stream: boolean) {
  return {
    model: request.model,
    instructions: request.instructions,
    input: request.input,
    stream,
    max_output_tokens: request.maxOutputTokens,
    ...(request.model.toLowerCase().startsWith("gpt-5") ? { reasoning: { effort: "low" } } : {})
  };
}

function messages(request: AiProviderRequest) {
  return [{ role: "system", content: request.instructions }, { role: "user", content: request.input }];
}

function providerConfig(request: AiProviderRequest): ProviderConfig {
  const baseUrl = typeof request.config.baseUrl === "string" ? request.config.baseUrl.replace(/\/$/, "") : "";
  const apiKey = typeof request.config.apiKey === "string" ? request.config.apiKey : "";
  const protocol = request.config.protocol === "responses" || request.config.protocol === "chat-completions" ? request.config.protocol : "auto";
  if (!baseUrl || !apiKey) throw new Error("AI provider 缺少 Base URL 或 API Key");
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new Error("AI provider Base URL 无效"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("AI provider Base URL 只能使用无凭据、无查询参数的 HTTP(S) 地址");
  return { baseUrl, apiKey, protocol };
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
