import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { PluginRegistry } from "@bim-studio/plugin-runtime";
import { createAssistantService, type AiRuntimeSettings } from "./assistantService.js";
import { createAiTelemetryRing } from "./aiRequestTelemetry.js";
import { registerDefaultAiPlugin } from "./registerAiPlugin.js";

/**
 * 端到端集成测试：用本地 mock OpenAI 兼容 HTTP 服务充当主/备两个模型端点，
 * 走真实 fetch 与 SSE 解析，验证主备 failover 与流式输出行为。
 */
let primaryServer: Server;
let fallbackServer: Server;
let primaryRequests = 0;
let fallbackRequests = 0;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function requireAuth(request: import("node:http").IncomingMessage): boolean {
  return request.headers.authorization === "Bearer fallback-key";
}

beforeAll(async () => {
  primaryServer = createServer((_request, response) => {
    primaryRequests += 1;
    json(response, 429, { error: { message: "insufficient_quota: 主端点额度已用尽" } });
  });
  fallbackServer = createServer((request, response) => {
    if (!requireAuth(request)) {
      json(response, 401, { error: { message: "invalid api key" } });
      return;
    }
    const url = request.url ?? "";
    fallbackRequests += 1;
    if (url.endsWith("/models")) {
      json(response, 200, { data: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.5" }] });
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { stream?: boolean };
      if (!parsed.stream) {
        json(response, 200, { choices: [{ message: { content: "备用端点连接成功" } }], usage: { prompt_tokens: 12, completion_tokens: 5 } });
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "备用" } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "流式回答" } }], usage: { prompt_tokens: 12, completion_tokens: 5 } })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await Promise.all([listen(primaryServer), listen(fallbackServer)]);
});

afterAll(() => {
  primaryServer.close();
  fallbackServer.close();
});

async function hostRegistry() {
  const registry = new PluginRegistry({
    apiVersion: "1.0", sceneApiVersion: "1.0", host: "cloud", renderer: "webgl2",
    capabilities: ["ai.provider"], permissions: ["ai.invoke"],
    extensionPoints: ["ai.provider"], allowTrustedSceneExtensions: false
  });
  await registerDefaultAiPlugin(registry);
  return registry;
}

function settings(primaryPort: number, fallbackPort: number): AiRuntimeSettings {
  return {
    providerId: "ai.openai-compatible",
    baseUrl: `http://127.0.0.1:${primaryPort}/v1`,
    model: "gpt-5.5",
    protocol: "chat-completions",
    apiKey: "primary-key",
    temperature: 0.2,
    failover: {
      enabled: true,
      providerId: "ai.openai-compatible",
      baseUrl: `http://127.0.0.1:${fallbackPort}/v1`,
      model: "gpt-5.6-sol",
      protocol: "chat-completions",
      apiKey: "fallback-key",
    },
  };
}

describe("assistant failover over local mock OpenAI-compatible endpoints", () => {
  it("completes through the fallback endpoint when the primary returns 429, with usage telemetry", async () => {
    primaryRequests = 0;
    fallbackRequests = 0;
    const registry = await hostRegistry();
    const ring = createAiTelemetryRing(10);
    const service = createAssistantService(registry, { telemetry: ring.sink });
    const [primaryPort, fallbackPort] = await Promise.all([listenPort(primaryServer), listenPort(fallbackServer)]);
    const result = await service.complete({
      mode: "scene", question: "只回复：连接成功", context: {}, settings: settings(primaryPort, fallbackPort), principal: "integration",
    });
    expect(result.text).toBe("备用端点连接成功");
    expect(result.model).toBe("gpt-5.6-sol");
    expect(result.reliability).toMatchObject({ servedProvider: "fallback" });
    const summary = ring.summary();
    expect(summary.records[0]).toMatchObject({ servedBy: "fallback", status: "completed", inputTokens: 12, outputTokens: 5, source: "assistant" });
    expect(primaryRequests).toBe(1);
    expect(fallbackRequests).toBe(1);
  });

  it("streams the fallback endpoint content after a primary quota failure", async () => {
    primaryRequests = 0;
    fallbackRequests = 0;
    const registry = await hostRegistry();
    const [primaryPort, fallbackPort] = await Promise.all([listenPort(primaryServer), listenPort(fallbackServer)]);
    const deltas: string[] = [];
    for await (const event of createAssistantService(registry).stream({
      mode: "scene", question: "解释场景", context: {}, settings: settings(primaryPort, fallbackPort), principal: "integration",
    })) {
      if (event.type === "delta") deltas.push(event.delta);
      if (event.type === "done") expect(event.result.reliability).toMatchObject({ servedProvider: "fallback" });
    }
    expect(deltas.join("")).toBe("备用流式回答");
    expect(primaryRequests).toBe(1);
    expect(fallbackRequests).toBe(1);
  });

  it("lists models from the fallback endpoint catalog endpoint", async () => {
    const port = await listenPort(fallbackServer);
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: "Bearer fallback-key" } });
    const body = await response.json() as { data: Array<{ id: string }> };
    expect(body.data.map((item) => item.id).sort()).toEqual(["gpt-5.5", "gpt-5.6-sol"]);
  });
});

function listenPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const address = server.address();
    if (address && typeof address === "object") resolve(address.port);
    else reject(new Error("mock server 未监听"));
  });
}
