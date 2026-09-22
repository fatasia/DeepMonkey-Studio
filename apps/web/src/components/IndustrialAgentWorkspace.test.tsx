import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentCheckpoint, AgentToolDefinition } from "@bim-studio/industrial-agent-orchestrator";
import { IndustrialAgentRunView } from "./IndustrialAgentWorkspace";

const tools: AgentToolDefinition[] = [{
  id: "operations.control.apply",
  label: "应用现场控制",
  description: "受控写入",
  effect: "control",
  risk: "high",
  requiresApproval: true,
}];

describe("IndustrialAgentRunView", () => {
  it("shows provider execution per decision while old checkpoints remain readable", () => {
    const checkpoint = fixture();
    checkpoint.decisions = [{ step: 1, decidedAt: checkpoint.createdAt,
      decision: { kind: "stop", rationale: "done", code: "done", message: "done" },
      execution: { protocol: "responses", requestedModel: "alias", reportedModel: "served-snapshot", reasoningEffortSent: "high", servedBy: "fallback", failoverCategory: "rate-limit" } }];
    const html = render(checkpoint);
    expect(html).toContain("served-snapshot");
    expect(html).toContain("备用模型接管");
    expect(html).toContain("主模型限流");
    expect(html).toContain("未返回");
    delete checkpoint.decisions[0]!.execution;
    expect(render(checkpoint)).not.toContain("模型与思考设置");
  });
  it("offers bounded recovery only for transport decisions, never arbitrary failed tools", () => {
    const checkpoint = fixture();
    checkpoint.status = "failed";
    checkpoint.failure = { code: "decision-provider-unavailable", phase: "decision", message: "Gateway timeout", retryable: true };
    expect(render(checkpoint)).toContain("重试决策并继续");
    checkpoint.failure.code = "tool-failed";
    expect(render(checkpoint)).not.toContain("重试决策并继续");
  });

  it("renders named choices without a generic resume shortcut and escapes source names", () => {
    const checkpoint = fixture();
    checkpoint.status = "awaiting-input";
    checkpoint.pendingSelection = { step: 1, question: "选产线", options: [{ id: "a", label: "产线 A" }, { id: "b", label: "<img src=x>" }] };
    const html = render(checkpoint);
    expect(html).toContain("产线 A");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("从检查点继续");
  });
  it("shows the exact pending scope and post-action verification before confirmation", () => {
    const checkpoint = fixture();
    checkpoint.status = "awaiting-approval";
    checkpoint.pendingTool = {
      step: 1,
      fingerprint: "scope-fingerprint",
      effect: "control",
      state: "awaiting-approval",
      call: {
        toolId: "operations.control.apply",
        arguments: { target: "pump-01", value: false },
        resources: [{ kind: "object", id: "pump-01", projectId: "project-1" }],
      },
    };
    const html = render(checkpoint);
    expect(html).toContain("执行前需要你确认");
    expect(html).toContain("object:pump-01");
    expect(html).toContain("完成后必须返回独立验证证据");
    expect(html).toContain("确认并继续");
    expect(html).not.toContain("审批");
    expect(html).toContain("取消任务");
  });

  it("renders production evidence and verification without exposing implementation controls", () => {
    const checkpoint = fixture();
    checkpoint.status = "completed";
    checkpoint.completion = {
      kind: "finish",
      rationale: "验证完成",
      summary: "泵站控制已验证，反馈信号与目标一致。",
      decisionStatus: "production",
      evidenceIds: ["evidence-1"],
    };
    checkpoint.toolRecords = [{
      step: 1,
      fingerprint: "scope-fingerprint",
      effect: "control",
      call: { toolId: tools[0]!.id, arguments: {}, resources: [{ kind: "project", id: "project-1" }] },
      startedAt: checkpoint.createdAt,
      completedAt: checkpoint.updatedAt,
      outcome: {
        status: "completed",
        evidence: [{ id: "evidence-1", kind: "control-result", label: "控制反馈", source: "现场网关", fingerprint: "verified-fp" }],
        verificationEvidence: [{ id: "evidence-1", kind: "control-result", label: "控制反馈", source: "现场网关", fingerprint: "verified-fp" }],
      },
    }];
    const html = render(checkpoint);
    expect(html).toContain("证据结论");
    expect(html).toContain("泵站控制已验证");
    expect(html).toContain("控制反馈");
    expect(html).toContain("开始新任务");
    expect(html).not.toContain("shell");
  });
});

function render(checkpoint: AgentCheckpoint): string {
  return renderToStaticMarkup(
    <IndustrialAgentRunView
      locale="zh-CN"
      checkpoint={checkpoint}
      tools={tools}
      busy={false}
      onAction={vi.fn()}
      onNew={vi.fn()}
    />,
  );
}

function fixture(): AgentCheckpoint {
  return {
    schemaVersion: 1,
    id: "run-1",
    projectId: "project-1",
    principal: "editor-1",
    objective: "检查泵站并安全停机",
    context: {},
    status: "running",
    budget: { maxSteps: 10, maxDurationMs: 90_000, maxToolCalls: 6 },
    usage: { steps: 1, toolCalls: 0, activeDurationMs: 300 },
    allowedToolIds: tools.map((tool) => tool.id),
    decisions: [],
    toolRecords: [],
    seenToolFingerprints: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:01.000Z",
    revision: 2,
  };
}
