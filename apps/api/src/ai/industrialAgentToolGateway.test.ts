import { describe, expect, it, vi } from "vitest";
import type { AgentCheckpoint } from "@bim-studio/industrial-agent-orchestrator";
import type { CapabilityDescriptor, PluginRegistry } from "@bim-studio/plugin-runtime";
import { AiReliabilityAuditBuffer } from "./aiReliabilityAudit.js";
import { IndustrialAgentToolGateway } from "./industrialAgentToolGateway.js";

const descriptor: CapabilityDescriptor = {
  id: "operations.control.apply",
  version: "1.0.0",
  label: "设备控制写入",
  kind: "action",
  execution: "in-process",
  permissions: ["operations.write", "control.execute"],
  timeoutMs: 5_000,
  inputSchemaVersion: "1.0",
  outputSchemaVersion: "1.0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["target", "enabled"],
    properties: { target: { type: "string" }, enabled: { type: "boolean" } },
  },
  outputSchema: { type: "object", additionalProperties: true },
};

describe("IndustrialAgentToolGateway", () => {
  it("reuses approval fingerprint, audit and post-control verification gates", async () => {
    const persistedAnalysis: CapabilityDescriptor = {
      ...descriptor,
      id: "operations.energy.analyze",
      label: "能源分析",
      kind: "analysis",
      permissions: ["operations.read", "operations.write"],
    };
    const invokeCapability = vi.fn(async () => ({
      status: "completed" as const,
      capabilityId: descriptor.id,
      pluginId: "test.control",
      capabilityVersion: "1.0.0",
      requestId: "request-1",
      traceId: "trace-1",
      generatedAt: new Date().toISOString(),
      durationMs: 2,
      decisionStatus: "production" as const,
      output: { verificationStatus: "passed" },
      evidence: [{ id: "readback-1", kind: "trace" as const, label: "状态回读", source: "plc:pump-1", fingerprint: "verified" }],
      warnings: [],
      suggestedActions: [],
    }));
    const registry = {
      listCapabilities: () => [descriptor, persistedAnalysis],
      getCapability: (id: string) => id === descriptor.id ? descriptor : undefined,
      invokeCapability,
    } as unknown as PluginRegistry;
    const audit = new AiReliabilityAuditBuffer();
    const gateway = new IndustrialAgentToolGateway(registry, audit.sink);
    expect(gateway.list().find((tool) => tool.id === persistedAnalysis.id)).toMatchObject({ effect: "write", risk: "high", requiresApproval: true });
    const call = {
      toolId: descriptor.id,
      arguments: { target: "pump-1", enabled: true },
      resources: [{ kind: "project", id: "project-1", projectId: "project-1" }],
    };
    const checkpoint = checkpointFixture();

    const denied = await gateway.execute(call, { checkpoint, signal: new AbortController().signal });
    expect(denied).toMatchObject({ status: "blocked", error: { code: "tool-policy" } });
    expect(invokeCapability).not.toHaveBeenCalled();

    const scopeFingerprint = gateway.fingerprint(call);
    const completed = await gateway.execute(call, {
      checkpoint,
      approval: { approvedBy: "operator-1", approvedAt: new Date().toISOString(), scopeFingerprint },
      signal: new AbortController().signal,
    });
    expect(completed).toMatchObject({ status: "completed", verificationEvidence: [{ id: "readback-1" }] });
    expect(invokeCapability).toHaveBeenCalledTimes(1);
    expect(audit.list().map((event) => [event.stage, event.outcome])).toEqual([
      ["tool-decision", "denied"],
      ["tool-decision", "allowed"],
      ["tool-result", "completed"],
    ]);
  });
});

function checkpointFixture(): AgentCheckpoint {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, id: "run-1", projectId: "project-1", principal: "operator-1", role: "editor",
    objective: "启动泵并验证", context: {}, status: "running",
    budget: { maxSteps: 8, maxDurationMs: 120_000, maxToolCalls: 6 }, usage: { steps: 1, toolCalls: 1, activeDurationMs: 1 },
    allowedToolIds: [descriptor.id], decisions: [], toolRecords: [], seenToolFingerprints: [],
    createdAt: now, updatedAt: now, revision: 1,
  };
}
