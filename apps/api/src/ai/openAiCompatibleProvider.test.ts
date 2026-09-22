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
  it.each([
    { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "upstream failed" } } },
    { type: "response.incomplete", response: { status: "incomplete" } },
    { error: { message: "upstream failed" } },
    { choices: [{ finish_reason: "length" }] },
  ])("rejects failure after partial text instead of completing %j", async failure => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response([
      { choices: [{ delta: { content: "部分回答" } }] }, failure,
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n")));
    const deltas: string[] = [];
    const consume = async () => { for await (const event of createOpenAiCompatibleProvider().stream!(request, context())) if (event.type === "delta") deltas.push(event.delta); };
    await expect(consume()).rejects.toThrow();
    expect(deltas).toEqual(["部分回答"]);
  });
  it("rejects a truncated stream and cancels the reader at a terminal marker", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')));
    const consume = async () => { for await (const _event of createOpenAiCompatibleProvider().stream!(request, context())) { /* consume */ } };
    await expect(consume()).rejects.toThrow("提前结束");
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); }, cancel });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    await consume();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it.each(["responses", "chat-completions"])("rejects HTTP 200 failure and truncation in %s completions", async protocol => {
    const failed = { status: "incomplete", output_text: "partial", choices: [{ message: { content: "partial" }, finish_reason: "length" }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(failed))));
    await expect(createOpenAiCompatibleProvider().complete({ ...request, config: { ...request.config, protocol } }, context())).rejects.toThrow();
  });
  it("retains Responses completion usage from the nested response envelope", async () => {
    const payload = { type: "response.completed", response: { model: "served-snapshot", usage: { input_tokens: 32, output_tokens: 12 } } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`data: ${JSON.stringify(payload)}\n\n`)));
    const events = [];
    for await (const event of createOpenAiCompatibleProvider().stream!({ ...request, config: { ...request.config, protocol: "responses" } }, context())) events.push(event);
    expect(events.filter(event => event.type === "usage")).toEqual([{ type: "usage", inputTokens: 32, outputTokens: 12 }]);
  });
  it.each(["responses", "chat-completions"])("retains the model reported by %s instead of the request alias", async protocol => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: "served-snapshot", output_text: "回答", choices: [{ message: { content: "回答" } }] }))));
    await expect(createOpenAiCompatibleProvider().complete({ ...request, config: { ...request.config, protocol } }, context())).resolves.toMatchObject({ model: "served-snapshot" });
  });
  it.each(["responses", "chat-completions"])("reads %s stream model metadata without duplicating content", async protocol => {
    const metadata = protocol === "responses" ? { type: "response.created", response: { model: "served-snapshot" } } : { model: "served-snapshot" };
    const delta = protocol === "responses" ? { type: "response.output_text.delta", delta: "回答" } : { model: "served-snapshot", choices: [{ delta: { content: "回答" } }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response([metadata, delta].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n")));
    const events = [];
    for await (const event of createOpenAiCompatibleProvider().stream!({ ...request, config: { ...request.config, protocol } }, context())) events.push(event);
    expect(events.filter(event => event.type !== "execution")).toEqual([{ type: "model", model: "served-snapshot" }, { type: "delta", delta: "回答" }]);
    expect(events.filter(event => event.type === "execution").at(-1)).toMatchObject({ execution: { requestedModel: "gpt-test", reportedModel: "served-snapshot" } });
  });
  it("separates sent effort from the provider receipt without inventing acknowledgement", async () => {
    const provider = createOpenAiCompatibleProvider();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ output_text: "回答", reasoning: { effort: "medium" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: "回答" }))));
    const input = { ...request, config: { ...request.config, protocol: "responses", reasoningEffort: "deep" } };
    expect((await provider.complete(input, context())).execution).toMatchObject({ reasoningEffortSent: "high", reasoningEffortReported: "medium" });
    expect((await provider.complete(input, context())).execution).not.toHaveProperty("reasoningEffortReported");
  });
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
