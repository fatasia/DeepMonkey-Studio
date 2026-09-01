import { describe, expect, it } from "vitest";
import type { AgentCheckpoint, AgentToolDefinition } from "@bim-studio/industrial-agent-orchestrator";
import { agentEvidenceViews, agentProgress, selectedToolPreview } from "./industrialAgentViewModel";

const tools: AgentToolDefinition[] = [
  { id: "read", label: "读取数据", description: "", effect: "read", risk: "low", requiresApproval: false },
  { id: "control", label: "应用控制", description: "", effect: "control", risk: "high", requiresApproval: true },
];

describe("industrial agent view model", () => {
  it("separates approval risk from evidence requirements", () => {
    const preview = selectedToolPreview(tools, new Set(["read", "control"]));
    expect(preview.highRiskCount).toBe(1);
    expect(preview.evidenceRequired).toBe(true);
  });

  it("deduplicates evidence and preserves verification state", () => {
    const checkpoint = fixture();
    checkpoint.toolRecords = [{
      step: 1,
      fingerprint: "scope-1",
      effect: "control",
      call: { toolId: "control", arguments: {}, resources: [{ kind: "project", id: "p-1" }] },
      startedAt: checkpoint.createdAt,
      completedAt: checkpoint.updatedAt,
      outcome: {
        status: "completed",
        evidence: [{ id: "e-1", kind: "result", label: "执行结果", source: "capability" }],
        verificationEvidence: [{ id: "e-1", kind: "result", label: "执行结果", source: "capability", fingerprint: "fp" }],
      },
    }];
    expect(agentEvidenceViews(checkpoint, tools)).toEqual([
      expect.objectContaining({ id: "e-1", verified: true, toolLabel: "应用控制" }),
    ]);
  });

  it("reports bounded progress and completes at one hundred percent", () => {
    const checkpoint = fixture();
    checkpoint.usage = { steps: 2, toolCalls: 1, activeDurationMs: 1_000 };
    expect(agentProgress(checkpoint)).toBe(20);
    checkpoint.status = "completed";
    expect(agentProgress(checkpoint)).toBe(100);
  });
});

function fixture(): AgentCheckpoint {
  return {
    schemaVersion: 1,
    id: "run-1",
    projectId: "p-1",
    principal: "user-1",
    objective: "检查现场风险",
    context: {},
    status: "running",
    budget: { maxSteps: 10, maxDurationMs: 60_000, maxToolCalls: 5 },
    usage: { steps: 0, toolCalls: 0, activeDurationMs: 0 },
    allowedToolIds: ["read", "control"],
    decisions: [],
    toolRecords: [],
    seenToolFingerprints: [],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    revision: 1,
  };
}
