import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type {
  CapabilityInvocationResult,
  CapabilityRequest,
} from "@bim-studio/plugin-runtime";
import {
  capabilityInvocationHttpStatus,
  invokeReliableHttpCapability,
} from "./capabilityInvocationReliability.js";

const request: CapabilityRequest = {
  requestId: "request-1",
  projectId: "project-1",
  principal: "operator-1",
  input: { assetId: "pump-1", apiKey: "must-not-be-audited" },
};

describe("HTTP capability reliability", () => {
  it("persists trace and evidence fingerprints without raw capability input", async () => {
    const client = new EventEmitter();
    const addAuditLog = vi.fn(async () => undefined);
    const result = await invokeReliableHttpCapability({
      capabilityId: "alarm.rca.analyze",
      request,
      client,
      addAuditLog,
      invoke: async () => completedResult(),
    });

    expect(result.status).toBe("completed");
    const record = addAuditLog.mock.calls[0]?.[0];
    expect(record).toMatchObject({
      username: "operator-1",
      action: "capability.invoke.completed",
      method: "CAPABILITY",
      statusCode: 200,
    });
    expect(record?.detail).toContain("trace-alarm-1");
    expect(record?.detail).toContain("sha256:alarm-input");
    expect(record?.detail).not.toContain("must-not-be-audited");
  });

  it("propagates a disconnected client and removes the abort listener", async () => {
    const client = new EventEmitter();
    const invoke = vi.fn(async (_id: string, invocation: CapabilityRequest) => {
      await new Promise<void>((resolve) => {
        invocation.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return failedResult("aborted");
    });
    const pending = invokeReliableHttpCapability({
      capabilityId: "alarm.rca.analyze",
      request,
      client,
      invoke,
    });

    client.emit("aborted");
    await expect(pending).resolves.toMatchObject({
      status: "failed",
      error: { code: "aborted", retryable: true },
    });
    expect(invoke.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(client.listenerCount("aborted")).toBe(0);
  });

  it("honours a client that disconnected before the route attached its listener", async () => {
    const client = Object.assign(new EventEmitter(), { aborted: true });
    const invoke = vi.fn(async (_id: string, invocation: CapabilityRequest) => {
      expect(invocation.signal?.aborted).toBe(true);
      return failedResult("aborted");
    });

    await expect(invokeReliableHttpCapability({
      capabilityId: "alarm.rca.analyze",
      request,
      client,
      invoke,
    })).resolves.toMatchObject({ error: { code: "aborted" } });
    expect(client.listenerCount("aborted")).toBe(0);
  });

  it("exposes an audit persistence gap instead of claiming complete evidence", async () => {
    const result = await invokeReliableHttpCapability({
      capabilityId: "alarm.rca.analyze",
      request,
      client: new EventEmitter(),
      invoke: async () => completedResult(),
      addAuditLog: async () => {
        throw new Error("audit store unavailable");
      },
    });

    expect(result.warnings).toContain("能力执行审计未能持久化，请勿将本次结果视为完整审计证据");
  });

  it("does not persist provider error text that may contain secrets", async () => {
    const addAuditLog = vi.fn(async () => undefined);
    const failure = failedResult("provider-failed");
    failure.error!.message = "upstream rejected apiKey=provider-secret";

    await invokeReliableHttpCapability({
      capabilityId: "alarm.rca.analyze",
      request,
      client: new EventEmitter(),
      invoke: async () => failure,
      addAuditLog,
    });

    expect(addAuditLog.mock.calls[0]?.[0].detail).toContain("provider-failed");
    expect(addAuditLog.mock.calls[0]?.[0].detail).not.toContain("provider-secret");
  });

  it("maps retry-relevant failures to distinct HTTP statuses", () => {
    expect(capabilityInvocationHttpStatus(failedResult("aborted"))).toBe(499);
    expect(capabilityInvocationHttpStatus(failedResult("timeout"))).toBe(504);
    expect(capabilityInvocationHttpStatus(failedResult("provider-failed"))).toBe(502);
    expect(capabilityInvocationHttpStatus(failedResult("invalid-input"))).toBe(422);
  });
});

function completedResult(): CapabilityInvocationResult {
  return {
    status: "completed",
    capabilityId: "alarm.rca.analyze",
    pluginId: "bim.ai.alarm-rca",
    capabilityVersion: "1.0.0",
    requestId: "request-1",
    traceId: "trace-alarm-1",
    generatedAt: "2026-08-30T12:00:00.000Z",
    durationMs: 8,
    decisionStatus: "production",
    evidence: [{ id: "alarm-input", kind: "data", label: "告警输入", source: "request", fingerprint: "sha256:alarm-input" }],
    warnings: [],
    suggestedActions: [],
  };
}

function failedResult(
  code: "aborted" | "timeout" | "provider-failed" | "invalid-input",
): CapabilityInvocationResult {
  return {
    ...completedResult(),
    status: code === "invalid-input" ? "blocked" : "failed",
    decisionStatus: "insufficient-data",
    evidence: [],
    error: { code, message: code, retryable: code !== "invalid-input" },
  };
}
