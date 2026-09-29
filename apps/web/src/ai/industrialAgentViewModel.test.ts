import { describe, expect, it } from "vitest";
import type { AgentCheckpoint, AgentToolDefinition } from "@bim-studio/industrial-agent-orchestrator";
import { agentEvidenceViews, agentObjectiveExamples, agentProgress, agentStatusLabel, selectedToolPreview } from "./industrialAgentViewModel";

const tools: AgentToolDefinition[] = [
  { id: "read", label: "读取数据", description: "", effect: "read", risk: "low", requiresApproval: false },
  { id: "control", label: "应用控制", description: "", effect: "control", risk: "high", requiresApproval: true },
];

describe("industrial agent view model", () => {
  it("presents contract approval state as a local user confirmation", () => {
    expect(agentStatusLabel("awaiting-approval", "zh-CN")).toBe("等待确认");
  });

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

// ── T11（审计 §二 T11：固定示例与能力面脱节）──
describe("agentObjectiveExamples（T11 目标示例随工具目录生成）", () => {
  it("derives examples from the loaded tool catalog instead of fixed copy", () => {
    const catalog = [
      { id: "data.query.read", label: "数据读取", description: "", effect: "read", risk: "low", requiresApproval: false },
      { id: "simulation.debug.run", label: "虚拟调试", description: "", effect: "simulate", risk: "medium", requiresApproval: false },
    ] as AgentToolDefinition[];
    const { examples, source } = agentObjectiveExamples(catalog, "zh-CN");
    expect(source).toBe("catalog");
    expect(examples.some((item) => item.includes("数据读取"))).toBe(true);
    expect(examples.some((item) => item.includes("虚拟调试"))).toBe(true);
    // 以前会坏：固定示例"检查设备异常"在没有任何诊断能力的目录下照样展示。
    expect(examples.every((item) => !item.includes("检查设备异常"))).toBe(true);
  });
  it("never suggests approval-gated capabilities as ready examples", () => {
    const gated = [
      { id: "control", label: "应用控制", description: "", effect: "control", risk: "high", requiresApproval: true },
      { id: "sim", label: "仿真", description: "", effect: "simulate", risk: "medium", requiresApproval: true },
    ] as AgentToolDefinition[];
    const { examples, source } = agentObjectiveExamples(gated, "zh-CN");
    expect(source).toBe("fallback");
    expect(examples.join("")).not.toContain("应用控制");
    expect(examples.join("")).not.toContain("仿真");
  });
  it("falls back to a generic read-only objective when the catalog is empty (load failure)", () => {
    const { examples, source } = agentObjectiveExamples([], "zh-CN");
    expect(source).toBe("fallback");
    expect(examples).toHaveLength(1);
    expect(examples[0]).toContain("只读检查");
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
