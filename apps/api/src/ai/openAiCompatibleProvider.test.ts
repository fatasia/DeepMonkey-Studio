import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleProvider } from "./openAiCompatibleProvider.js";

afterEach(() => vi.unstubAllGlobals());

const request = {
  requestId: "ai-1", principal: "operator", model: "gpt-test", instructions: "只回答事实", input: "状态",
  temperature: 0.2, maxOutputTokens: 100,
  config: { baseUrl: "https://example.test/v1", apiKey: "secret", protocol: "auto" }
};

function context() {
  const provider = createOpenAiCompatibleProvider();
  return { pluginId: "test.ai", pluginVersion: "1.0.0", descriptor: provider.descriptor, signal: new AbortController().signal };
}

describe("OpenAI compatible provider", () => {
  it.each(["responses", "chat-completions"])("retains actual 504 status when %s error bodies omit it", async protocol => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Gateway timeout" } }), { status: 504 })));
    await expect(createOpenAiCompatibleProvider().complete({ ...request, config: { ...request.config, protocol } }, context())).rejects.toMatchObject({ name: "AiProviderHttpError", status: 504, message: "Gateway timeout" });
  });
  it("falls back from Chat Completions to Responses without leaking protocol logic", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "protocol_not_supported" } }), { status: 404, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: "连接成功" }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createOpenAiCompatibleProvider().complete(request, context())).resolves.toMatchObject({ text: "连接成功", model: "gpt-test" });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://example.test/v1/chat/completions",
      "https://example.test/v1/responses"
    ]);
  });

  it("normalizes SSE from the provider into text deltas", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"工业"}}]}',
      'data: {"choices":[{"delta":{"content":"助手"}}]}',
      "data: [DONE]",
      ""
    ].join("\n\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const deltas: string[] = [];
    for await (const event of createOpenAiCompatibleProvider().stream!(request, context())) if (event.type === "delta") deltas.push(event.delta);
    expect(deltas.join("")).toBe("工业助手");
  });

  it("rejects provider URLs that could smuggle credentials or unsupported schemes", async () => {
    const provider = createOpenAiCompatibleProvider();
    await expect(provider.complete({ ...request, config: { ...request.config, baseUrl: "file:///tmp/model" } }, context())).rejects.toThrow("HTTP(S)");
    await expect(provider.complete({ ...request, config: { ...request.config, baseUrl: "https://user:pass@example.test/v1" } }, context())).rejects.toThrow("HTTP(S)");
  });

  it("returns token usage from both protocols", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: "回答", usage: { input_tokens: 9, output_tokens: 4 } }), { status: 200 })));
    await expect(createOpenAiCompatibleProvider().complete({ ...request, config: { ...request.config, protocol: "responses" } }, context())).resolves.toMatchObject({ usage: { inputTokens: 9, outputTokens: 4 } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "回答" } }], usage: { prompt_tokens: 8, completion_tokens: 3 } }), { status: 200 })));
    await expect(createOpenAiCompatibleProvider().complete({ ...request, config: { ...request.config, protocol: "chat-completions" } }, context())).resolves.toMatchObject({ usage: { inputTokens: 8, outputTokens: 3 } });
  });

  it("maps reasoning effort onto the protocol contract and preserves the legacy default when unset", async () => {
    const jsonBody = JSON.stringify({ output_text: "回答" });
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(jsonBody, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenAiCompatibleProvider();
    const call = async (config: Record<string, unknown>, model = request.model) => {
      await provider.complete({ ...request, model, config: { ...request.config, ...config } }, context());
      return JSON.parse(fetchMock.mock.lastCall![1].body as string) as Record<string, unknown>;
    };
    expect(await call({ protocol: "responses", reasoningEffort: "deep" })).toMatchObject({ reasoning: { effort: "high" } });
    expect(await call({ protocol: "responses", reasoningEffort: "standard" })).toMatchObject({ reasoning: { effort: "medium" } });
    expect(await call({ protocol: "responses", reasoningEffort: "minimal" }, "other-model")).toMatchObject({ reasoning: { effort: "minimal" } });
    expect(await call({ protocol: "responses" }, "gpt-5.5")).toMatchObject({ reasoning: { effort: "low" } });
    expect(await call({ protocol: "responses" }, "other-model")).toEqual(expect.not.objectContaining({ reasoning: expect.anything() }));

    const chatBody = JSON.stringify({ choices: [{ message: { content: "回答" } }] });
    const chatMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(chatBody, { status: 200 })));
    vi.stubGlobal("fetch", chatMock);
    const chatCall = async (config: Record<string, unknown>) => {
      await provider.complete({ ...request, config: { ...request.config, ...config } }, context());
      return JSON.parse(chatMock.mock.lastCall![1].body as string) as Record<string, unknown>;
    };
    expect(await chatCall({ protocol: "chat-completions", reasoningEffort: "deep" })).toMatchObject({ reasoning_effort: "high" });
    expect(await chatCall({ protocol: "chat-completions", reasoningEffort: "minimal" })).toMatchObject({ reasoning_effort: "low" });
    expect(await chatCall({ protocol: "chat-completions" })).toEqual(expect.not.objectContaining({ reasoning_effort: expect.anything() }));
  });
});
