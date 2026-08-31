import { describe, expect, it, vi } from "vitest";
import { AiReliabilityAuditBuffer } from "./aiReliabilityAudit.js";
import { AiToolPolicyError, aiToolScopeFingerprint, executeReliableAiTool, type AiToolCall, type AiToolPolicy } from "./aiToolReliability.js";

const readPolicy: AiToolPolicy = {
  toolId: "asset.health.read", risk: "low", allowedArgumentKeys: ["assetId"], allowedResourceKinds: ["asset"], timeoutMs: 20,
};
const baseCall: AiToolCall = {
  toolId: "asset.health.read", projectId: "project-1", arguments: { assetId: "pump-1" }, resources: [{ kind: "asset", id: "pump-1" }],
};
const baseContext = { traceId: "trace-1", principal: "engineer", projectId: "project-1" };

describe("industrial AI tool reliability", () => {
  it("executes a scoped read and emits decision/result evidence", async () => {
    const audit = new AiReliabilityAuditBuffer();
    const result = await executeReliableAiTool({ call: baseCall, policy: readPolicy, context: { ...baseContext, audit: audit.sink }, execute: async () => ({ score: 0.91 }) });
    expect(result).toMatchObject({ value: { score: 0.91 }, degraded: false });
    expect(audit.list().map((event) => [event.stage, event.outcome])).toEqual([["tool-decision", "allowed"], ["tool-result", "completed"]]);
    expect(audit.list()[0]?.tool?.resourceFingerprints[0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects cross-project and unknown argument access before execution", async () => {
    const execute = vi.fn();
    await expect(executeReliableAiTool({
      call: { ...baseCall, projectId: "project-2", arguments: { assetId: "pump-1", command: "start" } },
      policy: readPolicy, context: baseContext, execute,
    })).rejects.toBeInstanceOf(AiToolPolicyError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses an explicit fallback only for low/medium risk failures", async () => {
    const result = await executeReliableAiTool({
      call: baseCall, policy: readPolicy, context: baseContext,
      execute: async () => { throw new Error("primary unavailable token=secret-value"); },
      fallback: async () => ({ score: 0.5, source: "cached" }),
    });
    expect(result).toMatchObject({ degraded: true, value: { score: 0.5, source: "cached" } });
    expect(result.fallbackReason).not.toContain("secret-value");
  });

  it("requires a fresh scope-bound approval and durable audit for control tools", async () => {
    const now = () => new Date("2026-08-30T10:00:00.000Z");
    const policy: AiToolPolicy = { toolId: "plc.setpoint.write", risk: "critical", allowedArgumentKeys: ["value"], allowedResourceKinds: ["plc-tag"], timeoutMs: 100 };
    const callWithoutApproval: AiToolCall = { toolId: policy.toolId, projectId: "project-1", arguments: { value: 42 }, resources: [{ kind: "plc-tag", id: "line-1/speed" }] };
    const call: AiToolCall = { ...callWithoutApproval, approval: { approvedBy: "supervisor", approvedAt: now().toISOString(), scopeFingerprint: aiToolScopeFingerprint(callWithoutApproval) } };
    await expect(executeReliableAiTool({ call, policy, context: { ...baseContext, now }, execute: async () => "written" })).rejects.toThrow("缺少审计存储");
    const audit = new AiReliabilityAuditBuffer();
    await expect(executeReliableAiTool({ call, policy, context: { ...baseContext, now, audit: audit.sink }, execute: async () => "written" })).resolves.toMatchObject({ value: "written", degraded: false });
  });

  it("times out a read and returns the configured deterministic fallback", async () => {
    const result = await executeReliableAiTool({
      call: baseCall, policy: { ...readPolicy, timeoutMs: 5 }, context: baseContext,
      execute: async () => new Promise(() => undefined), fallback: () => ({ score: null }),
    });
    expect(result).toMatchObject({ degraded: true, value: { score: null } });
    expect(result.fallbackReason).toContain("超时");
  });

  it("audits a failed fallback instead of losing the terminal outcome", async () => {
    const audit = new AiReliabilityAuditBuffer();
    await expect(executeReliableAiTool({
      call: baseCall, policy: readPolicy, context: { ...baseContext, audit: audit.sink },
      execute: async () => { throw new Error("primary failed"); },
      fallback: async () => { throw new Error("cache failed"); },
    })).rejects.toThrow("cache failed");
    expect(audit.list().at(-1)).toMatchObject({ stage: "tool-result", outcome: "failed", failure: { code: "fallback-failed" } });
  });
});
