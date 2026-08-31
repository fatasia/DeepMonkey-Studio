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
});
