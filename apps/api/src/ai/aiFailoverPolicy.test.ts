import { describe, expect, it } from "vitest";
import { AiProviderHttpError } from "./openAiCompatibleProvider.js";
import { attemptWithFailover, classifyAiProviderError, resolveFailoverTarget, type AiFailoverTarget } from "./aiFailoverPolicy.js";

const target: AiFailoverTarget = { enabled: true, baseUrl: "https://fallback.test/v1", apiKey: "fallback-key", model: "fallback-model", protocol: "auto" };

describe("AI failover policy", () => {
  it.each([
    [401, "auth", false],
    [403, "auth", false],
    [402, "quota", true],
    [429, "rate-limit", true],
    [408, "server", true],
    [500, "server", true],
    [502, "server", true],
    [503, "server", true],
    [504, "server", true],
    [400, "invalid", false],
    [404, "invalid", false],
    [422, "invalid", false],
  ] as const)("classifies HTTP %i as %s (failover eligible: %s)", (status, category, eligible) => {
    const classification = classifyAiProviderError(new AiProviderHttpError(status, "上游消息"));
    expect(classification.category).toBe(category);
    expect(classification.failoverEligible).toBe(eligible);
  });

  it("classifies timeout and network errors as eligible, auth cancellation and policy as not", () => {
    expect(classifyAiProviderError(new Error("AI provider 调用超时"))).toMatchObject({ category: "timeout", failoverEligible: true });
    expect(classifyAiProviderError(new TypeError("fetch failed"))).toMatchObject({ category: "network", failoverEligible: true });
    expect(classifyAiProviderError(new Error("ECONNREFUSED 127.0.0.1:46037"))).toMatchObject({ category: "network", failoverEligible: true });
    expect(classifyAiProviderError(new Error("operator cancelled"))).toMatchObject({ category: "cancelled", failoverEligible: false });
    expect(classifyAiProviderError(new Error("content_policy_violation: 拒绝"))).toMatchObject({ category: "policy", failoverEligible: false });
    expect(classifyAiProviderError(new Error("奇怪故障"))).toMatchObject({ category: "unknown", failoverEligible: false });
  });

  it("resolves a failover target only when enabled and fully configured", () => {
    expect(resolveFailoverTarget(target)).toBe(target);
    expect(resolveFailoverTarget({ ...target, enabled: false })).toBeUndefined();
    expect(resolveFailoverTarget({ ...target, apiKey: "" })).toBeUndefined();
    expect(resolveFailoverTarget({ ...target, model: "" })).toBeUndefined();
    expect(resolveFailoverTarget(undefined)).toBeUndefined();
  });

  it("keeps the healthy primary path free of any fallback request", async () => {
    let fallbackCalls = 0;
    const attempt = await attemptWithFailover({
      failover: target,
      primary: async () => "primary-result",
      fallback: async () => { fallbackCalls += 1; return "fallback-result"; },
    });
    expect(attempt).toEqual({ result: "primary-result", servedBy: "primary" });
    expect(fallbackCalls).toBe(0);
  });

  it("retries once with the fallback on an eligible failure and marks the served provider", async () => {
    const attempt = await attemptWithFailover({
      failover: target,
      primary: async () => { throw new AiProviderHttpError(429, "insufficient_quota"); },
      fallback: async (used) => `fallback:${used.model}:${used.baseUrl}`,
    });
    expect(attempt.servedBy).toBe("fallback");
    expect(attempt.result).toBe("fallback:fallback-model:https://fallback.test/v1");
    expect(attempt.failover).toMatchObject({ category: "rate-limit", reason: "insufficient_quota" });
  });

  it("never switches on auth errors even when a fallback is configured", async () => {
    let fallbackCalls = 0;
    const authError = new AiProviderHttpError(401, "invalid api key");
    await expect(attemptWithFailover({
      failover: target,
      primary: async () => { throw authError; },
      fallback: async () => { fallbackCalls += 1; return "fallback"; },
    })).rejects.toBe(authError);
    expect(fallbackCalls).toBe(0);
  });

  it("rethrows the original error untouched when no usable fallback is configured", async () => {
    const quotaError = new AiProviderHttpError(402, "quota exhausted");
    await expect(attemptWithFailover({
      failover: undefined,
      primary: async () => { throw quotaError; },
      fallback: async () => "fallback",
    })).rejects.toBe(quotaError);
    await expect(attemptWithFailover({
      failover: { ...target, enabled: false },
      primary: async () => { throw quotaError; },
      fallback: async () => "fallback",
    })).rejects.toBe(quotaError);
  });

  it("reports both failures when the fallback also fails", async () => {
    await expect(attemptWithFailover({
      failover: target,
      primary: async () => { throw new AiProviderHttpError(429, "primary down"); },
      fallback: async () => { throw new AiProviderHttpError(503, "fallback down"); },
    })).rejects.toThrow("主模型与备用模型均失败：主模型（rate-limit）primary down；备用模型fallback down");
  });

  it("never switches when the caller already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("operator cancelled"));
    let fallbackCalls = 0;
    const cancelError = new Error("operator cancelled");
    await expect(attemptWithFailover({
      failover: target,
      signal: controller.signal,
      primary: async () => { throw cancelError; },
      fallback: async () => { fallbackCalls += 1; return "fallback"; },
    })).rejects.toBe(cancelError);
    expect(fallbackCalls).toBe(0);
  });
});
