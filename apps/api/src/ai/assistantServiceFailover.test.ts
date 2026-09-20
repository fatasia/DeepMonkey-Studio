import { describe, expect, it } from "vitest";
import { PluginRegistry, type AiProvider, type AiProviderRequest } from "@bim-studio/plugin-runtime";
import { AiProviderHttpError } from "./openAiCompatibleProvider.js";
import { AiReliabilityAuditBuffer } from "./aiReliabilityAudit.js";
import { createAssistantService, type AiRuntimeSettings } from "./assistantService.js";
import { createAiTelemetryRing } from "./aiRequestTelemetry.js";

type CompleteFn = NonNullable<AiProvider["complete"]>;

async function host(options: { primary?: CompleteFn } = {}) {
  const registry = new PluginRegistry({
    apiVersion: "1.0", sceneApiVersion: "1.0", host: "cloud", renderer: "webgl2",
    capabilities: ["ai.provider"], permissions: ["ai.invoke"],
    extensionPoints: ["ai.provider"], allowTrustedSceneExtensions: false
  });
  let observedRequest: AiProviderRequest | undefined;
  registry.register({
    schemaVersion: 1, id: "test.ai-plugin", name: "Test AI", version: "1.0.0", apiVersion: "1.0", hosts: ["cloud"],
    capabilities: ["ai.provider"], permissions: ["ai.invoke"],
    extensionPoints: [
      { kind: "ai.provider", id: "test.ai", providerIds: ["ai.test"], execution: "in-process", limits: { timeoutMs: 1_000, maxInputBytes: 1_000_000, memoryMb: 64 } }
    ]
  }, ({ registerAiProvider }) => {
    registerAiProvider({
      descriptor: { id: "ai.test", version: "1.0.0", label: "测试 AI", execution: "in-process", permissions: ["ai.invoke"], streaming: true, timeoutMs: 500 },
      async complete(request, context) {
        observedRequest = request;
        if (options.primary) return options.primary(request, context);
        return { text: "主模型回答", model: request.model, usage: { inputTokens: 11, outputTokens: 7 } };
      },
      async *stream(request) {
        if (options.primary) await options.primary(request, contextStub());
        yield { type: "delta", delta: "流式" };
        yield { type: "delta", delta: "回答" };
      }
    });
  });
  await registry.enable("test.ai-plugin");
  return { registry, observedRequest: () => observedRequest };
}

function contextStub() {
  return { pluginId: "test", pluginVersion: "1.0.0", descriptor: {} as AiProvider["descriptor"], signal: new AbortController().signal };
}

const primarySettings = {
  providerId: "ai.test", baseUrl: "https://primary.test/v1", model: "primary-model", protocol: "auto" as const,
  apiKey: "primary-key", temperature: 0.2,
};

function settingsWithFallback(overrides: Partial<AiRuntimeSettings["failover"]> = {}): AiRuntimeSettings {
  return {
    ...primarySettings,
    failover: {
      enabled: true, providerId: "ai.test", baseUrl: "https://fallback.test/v1",
      model: "fallback-model", protocol: "auto", apiKey: "fallback-key", ...overrides,
    },
  };
}

function quotaError() {
  return new AiProviderHttpError(429, "insufficient_quota") as unknown as Error;
}

describe("assistant service failover", () => {
  it("completes via the fallback once when the primary hits a quota error and marks the served provider", async () => {
    const runtime = await host({
      primary: async (request) => {
        if (request.config.baseUrl === "https://primary.test/v1") throw quotaError();
        return { text: "备用回答", model: request.model };
      },
    });
    const audit = new AiReliabilityAuditBuffer();
    const ring = createAiTelemetryRing(10);
    const result = await createAssistantService(runtime.registry, { audit: audit.sink, telemetry: ring.sink }).complete({
      mode: "platform", question: "设备状态", context: {}, settings: settingsWithFallback(), principal: "operator",
    });
    expect(result.text).toBe("备用回答");
    expect(result.model).toBe("fallback-model");
    expect(result.reliability).toMatchObject({ servedProvider: "fallback" });
    expect(result.reliability?.failoverReason).toContain("rate-limit");
    expect(result.reliability.warnings.some((line) => line.includes("备用模型"))).toBe(true);
    expect(result.reliability.warnings.join("\n")).not.toContain("fallback-key");
    const summary = ring.summary();
    expect(summary.totals).toMatchObject({ completed: 1, fallbackServed: 1 });
    expect(summary.lastFailover).toMatchObject({ servedBy: "fallback", model: "fallback-model", status: "completed" });
    expect(audit.list().at(-1)).toMatchObject({ stage: "model-completion", outcome: "degraded" });
    expect(runtime.observedRequest()?.config.baseUrl).toBe("https://fallback.test/v1");
    expect(runtime.observedRequest()?.model).toBe("fallback-model");
  });

  it("keeps the healthy primary path byte-identical: single invocation, primary marking", async () => {
    const runtime = await host();
    const audit = new AiReliabilityAuditBuffer();
    const ring = createAiTelemetryRing(10);
    const result = await createAssistantService(runtime.registry, { audit: audit.sink, telemetry: ring.sink }).complete({
      mode: "platform", question: "设备状态", context: {}, settings: settingsWithFallback(), principal: "operator",
    });
    expect(result.text).toBe("主模型回答");
    expect(result.reliability).toMatchObject({ servedProvider: "primary" });
    expect(result.reliability.warnings.some((line) => line.includes("备用模型"))).toBe(false);
    expect(audit.list().map((event) => event.outcome)).toEqual(["allowed", "completed"]);
    const summary = ring.summary();
    expect(summary.records).toHaveLength(1);
    expect(summary.records[0]).toMatchObject({ servedBy: "primary", status: "completed", inputTokens: 11, outputTokens: 7 });
  });

  it("reports auth errors precisely without switching", async () => {
    const runtime = await host({
      primary: async () => { throw new AiProviderHttpError(401, "invalid api key") as unknown as Error; },
    });
    const ring = createAiTelemetryRing(10);
    await expect(createAssistantService(runtime.registry, { telemetry: ring.sink }).complete({
      mode: "platform", question: "设备状态", context: {}, settings: settingsWithFallback(), principal: "operator",
    })).rejects.toThrow("invalid api key");
    expect(ring.summary().records[0]).toMatchObject({ status: "failed", errorCategory: "auth" });
  });

  it("rethrows the original error when no usable fallback is configured", async () => {
    const runtime = await host({ primary: async () => { throw quotaError(); } });
    await expect(createAssistantService(runtime.registry).complete({
      mode: "platform", question: "设备状态", context: {}, settings: primarySettings, principal: "operator",
    })).rejects.toThrow("insufficient_quota");
    await expect(createAssistantService(runtime.registry).complete({
      mode: "platform", question: "设备状态", context: {}, settings: settingsWithFallback({ enabled: false }), principal: "operator",
    })).rejects.toThrow("insufficient_quota");
  });

  it("switches the whole stream before the first delta and reports the fallback provider", async () => {
    const runtime = await host({
      primary: async (request) => {
        if (request.config.baseUrl === "https://primary.test/v1") throw quotaError();
        return { text: "", model: request.model };
      },
    });
    const ring = createAiTelemetryRing(10);
    const events = [];
    for await (const event of createAssistantService(runtime.registry, { telemetry: ring.sink }).stream({
      mode: "scene", question: "解释场景", context: {}, settings: settingsWithFallback(), principal: "operator",
    })) events.push(event);
    expect(events.filter((event) => event.type === "delta").map((event) => (event as { delta: string }).delta)).toEqual(["流式", "回答"]);
    const done = events.at(-1) as { result: { reliability: { servedProvider?: string; failoverReason?: string } } };
    expect(done.result.reliability).toMatchObject({ servedProvider: "fallback" });
    expect(ring.summary().lastFailover).toMatchObject({ servedBy: "fallback", status: "completed" });
  });

  it("keeps partial streamed content visible and aborts switching once deltas were emitted", async () => {
    let calls = 0;
    const registry = new PluginRegistry({
      apiVersion: "1.0", sceneApiVersion: "1.0", host: "cloud", renderer: "webgl2",
      capabilities: ["ai.provider"], permissions: ["ai.invoke"],
      extensionPoints: ["ai.provider"], allowTrustedSceneExtensions: false
    });
    registry.register({
      schemaVersion: 1, id: "test.ai-plugin", name: "Test AI", version: "1.0.0", apiVersion: "1.0", hosts: ["cloud"],
      capabilities: ["ai.provider"], permissions: ["ai.invoke"],
      extensionPoints: [
        { kind: "ai.provider", id: "test.ai", providerIds: ["ai.test"], execution: "in-process", limits: { timeoutMs: 1_000, maxInputBytes: 1_000_000, memoryMb: 64 } }
      ]
    }, ({ registerAiProvider }) => {
      registerAiProvider({
        descriptor: { id: "ai.test", version: "1.0.0", label: "测试 AI", execution: "in-process", permissions: ["ai.invoke"], streaming: true, timeoutMs: 500 },
        async complete() { return { text: "x", model: "m" }; },
        async *stream() {
          calls += 1;
          yield { type: "delta", delta: "已输出一半" };
          throw quotaError();
        }
      });
    });
    await registry.enable("test.ai-plugin");
    const events: string[] = [];
    await expect(async () => {
      for await (const event of createAssistantService(registry).stream({
        mode: "scene", question: "解释场景", context: {}, settings: settingsWithFallback(), principal: "operator",
      })) {
        if (event.type === "delta") events.push(event.delta);
      }
    }).rejects.toThrow("insufficient_quota");
    expect(events).toEqual(["已输出一半"]);
    expect(calls).toBe(1);
  });
});
