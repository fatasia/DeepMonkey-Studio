import { describe, expect, it, vi } from "vitest";
import { CapabilityRegistry, type CapabilityProvider } from "./capability.js";

function provider(overrides: Partial<CapabilityProvider> = {}): CapabilityProvider {
  return {
    descriptor: {
      id: "asset.health.score",
      version: "1.0.0",
      label: "设备健康评分",
      kind: "analysis",
      execution: "worker",
      permissions: ["data.read"],
      timeoutMs: 50,
      inputSchemaVersion: "1.0",
      outputSchemaVersion: "1.0",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { assetId: { type: "string", minLength: 1 } },
        required: ["assetId"]
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { score: { type: "number", minimum: 0, maximum: 1 } },
        required: ["score"]
      }
    },
    async invoke() {
      return {
        status: "completed",
        decisionStatus: "production",
        output: { score: 0.91 },
        confidence: 0.8,
        evidence: [{ id: "trend", kind: "data", label: "近 24 小时趋势", source: "dataset:asset-1" }]
      };
    },
    ...overrides
  };
}

const request = { requestId: "req-1", projectId: "project-1", principal: "operator", input: { assetId: "asset-1" } };

describe("CapabilityRegistry", () => {
  it("registers and returns an auditable result", async () => {
    const registry = new CapabilityRegistry();
    expect(registry.register(provider(), "acme.industrial", "1.0.0", ["data.read"])).toMatchObject({ ok: true });
    const result = await registry.invoke<{ score: number }>("asset.health.score", request, { traceId: "trace-fixed" });
    expect(result).toMatchObject({
      status: "completed",
      capabilityId: "asset.health.score",
      pluginId: "acme.industrial",
      requestId: "req-1",
      traceId: "trace-fixed",
      output: { score: 0.91 },
      evidence: [{ id: "trend" }]
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("enforces permissions and duplicate ids", () => {
    const registry = new CapabilityRegistry();
    expect(registry.register(provider(), "acme.industrial", "1.0.0", [])).toMatchObject({ ok: false, code: "permission-denied" });
    expect(registry.register(provider(), "acme.industrial", "1.0.0", ["data.read"])).toMatchObject({ ok: true });
    expect(registry.register(provider(), "other.plugin", "1.0.0", ["data.read"])).toMatchObject({ ok: false, code: "duplicate" });
  });

  it("rejects malformed nested schemas during registration", () => {
    const registry = new CapabilityRegistry();
    const malformed = provider({
      descriptor: {
        ...provider().descriptor,
        inputSchema: { type: "object", properties: { assetId: { type: "unsupported" } } } as never
      }
    });
    expect(registry.register(malformed, "acme.industrial", "1.0.0", ["data.read"])).toMatchObject({
      ok: false,
      code: "invalid-provider"
    });
  });

  it("returns timeout even if a provider ignores AbortSignal", async () => {
    const registry = new CapabilityRegistry();
    const invoke = vi.fn(() => new Promise(() => undefined));
    registry.register(provider({ invoke }), "acme.industrial", "1.0.0", ["data.read"]);
    const result = await registry.invoke("asset.health.score", request, { timeoutMs: 10 });
    expect(result).toMatchObject({ status: "failed", error: { code: "timeout" }, pluginId: "acme.industrial" });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("honours caller cancellation independently of provider behaviour", async () => {
    const registry = new CapabilityRegistry();
    registry.register(provider({ invoke: () => new Promise(() => undefined) }), "acme.industrial", "1.0.0", ["data.read"]);
    const controller = new AbortController();
    const pending = registry.invoke("asset.health.score", { ...request, signal: controller.signal }, { timeoutMs: 1_000 });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: "failed", error: { code: "aborted" } });
  });

  it("rejects malformed provider output", async () => {
    const registry = new CapabilityRegistry();
    registry.register(provider({ invoke: async () => ({ status: "completed", decisionStatus: "production", confidence: 2 }) }), "acme.industrial", "1.0.0", ["data.read"]);
    await expect(registry.invoke("asset.health.score", request)).resolves.toMatchObject({ status: "failed", error: { code: "invalid-result" } });
  });

  it("rejects input that does not satisfy the declared schema before invoking provider", async () => {
    const registry = new CapabilityRegistry();
    const invoke = vi.fn(provider().invoke);
    registry.register(provider({ invoke }), "acme.industrial", "1.0.0", ["data.read"]);
    const result = await registry.invoke("asset.health.score", { ...request, input: { assetId: "", unexpected: true } });
    expect(result).toMatchObject({ status: "blocked", error: { code: "invalid-input", retryable: false } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects provider output that violates its declared output schema", async () => {
    const registry = new CapabilityRegistry();
    registry.register(provider({
      invoke: async () => ({ status: "completed", decisionStatus: "production", output: { score: 2 } })
    }), "acme.industrial", "1.0.0", ["data.read"]);
    await expect(registry.invoke("asset.health.score", request)).resolves.toMatchObject({
      status: "failed",
      error: { code: "invalid-result", retryable: false }
    });
  });
});
