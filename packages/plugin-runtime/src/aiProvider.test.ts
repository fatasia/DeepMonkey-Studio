import { describe, expect, it } from "vitest";
import { AiProviderRegistry, type AiProvider } from "./aiProvider.js";

function provider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    descriptor: {
      id: "ai.test-provider",
      version: "1.0.0",
      label: "测试模型供应商",
      execution: "in-process",
      permissions: ["ai.invoke"],
      streaming: true,
      timeoutMs: 100
    },
    async complete(request) {
      return { text: `完成：${request.input}`, model: request.model };
    },
    async *stream(request) {
      yield { type: "delta", delta: "流式：" };
      yield { type: "delta", delta: request.input };
    },
    ...overrides
  };
}

function request(signal?: AbortSignal) {
  return {
    requestId: "ai-1",
    principal: "operator",
    model: "model-1",
    instructions: "只回答事实",
    input: "设备状态",
    temperature: 0.2,
    maxOutputTokens: 100,
    config: {},
    ...(signal ? { signal } : {})
  };
}

describe("AiProviderRegistry", () => {
  it("registers completion and streaming providers through the same contract", async () => {
    const registry = new AiProviderRegistry();
    expect(registry.register(provider(), "plugin.ai", "1.0.0", ["ai.invoke"])).toMatchObject({ ok: true });
    await expect(registry.complete("ai.test-provider", request())).resolves.toMatchObject({ text: "完成：设备状态", model: "model-1" });
    const chunks: string[] = [];
    for await (const event of registry.stream("ai.test-provider", request())) if (event.type === "delta") chunks.push(event.delta);
    expect(chunks.join("")).toBe("流式：设备状态");
  });

  it("enforces permissions and removes providers with their plugin", () => {
    const registry = new AiProviderRegistry();
    expect(registry.register(provider(), "plugin.ai", "1.0.0", [])).toMatchObject({ ok: false, code: "permission-denied" });
    registry.register(provider(), "plugin.ai", "1.0.0", ["ai.invoke"]);
    registry.unregisterPlugin("plugin.ai");
    expect(registry.list()).toEqual([]);
  });

  it("propagates caller cancellation to the provider", async () => {
    const registry = new AiProviderRegistry();
    registry.register(provider({
      complete: (_request, context) => new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true }))
    }), "plugin.ai", "1.0.0", ["ai.invoke"]);
    const controller = new AbortController();
    const pending = registry.complete("ai.test-provider", request(controller.signal));
    controller.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toThrow("caller cancelled");
  });

  it("honours a caller signal cancelled before provider invocation", async () => {
    const registry = new AiProviderRegistry();
    registry.register(provider(), "plugin.ai", "1.0.0", ["ai.invoke"]);
    const controller = new AbortController();
    controller.abort(new Error("cancelled before invoke"));

    await expect(registry.complete(
      "ai.test-provider",
      request(controller.signal),
    )).rejects.toThrow("cancelled before invoke");
  });
});
