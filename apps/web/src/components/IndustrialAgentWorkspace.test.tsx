import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentCheckpoint, AgentToolDefinition } from "@bim-studio/industrial-agent-orchestrator";
import { AgentObjectiveExamplesRow, IndustrialAgentRunView } from "./IndustrialAgentWorkspace";

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

  it("keeps memory and provenance panels available while a run is in progress (K14, above metrics)", () => {
    const html = render(fixture(), "project-1");
    expect(html).toContain('aria-label="项目记忆"');
    expect(html).toContain('aria-label="实验档案"');
    // 折叠行默认收起，不抢运行进度视觉；面板位于 metrics 之前（运行摘要上方）。
    expect(html).not.toContain('aria-label="项目记忆" open');
    expect(html.indexOf('aria-label="项目记忆"')).toBeLessThan(html.indexOf('industrial-agent-metrics'));
  });

  it("omits the memory and provenance panels when no project scope is available", () => {
    expect(render(fixture())).not.toContain('aria-label="项目记忆"');
    expect(render(fixture())).not.toContain('aria-label="实验档案"');
  });
});

// ── T11（审计 §二 T11：示例与能力面脱节；目录加载失败只剩禁用态）──
describe("AgentObjectiveExamplesRow（T11 示例随工具目录生成）", () => {
  const catalog: AgentToolDefinition[] = [
    { id: "data.query.read", label: "数据读取", description: "", effect: "read", risk: "low", requiresApproval: false },
    { id: "simulation.debug.run", label: "虚拟调试", description: "", effect: "simulate", risk: "medium", requiresApproval: false },
  ];
  function row(tools: AgentToolDefinition[], overrides: Partial<Parameters<typeof AgentObjectiveExamplesRow>[0]> = {}): string {
    return renderToStaticMarkup(
      <AgentObjectiveExamplesRow locale="zh-CN" tools={tools} busy={false} loading={false} hasProject
        canSample={tools.some((tool) => tool.effect === "read" && !tool.requiresApproval)}
        onSample={vi.fn()} onPick={vi.fn()} {...overrides} />,
    );
  }
  it("renders catalog-derived examples and hides the disabled-sample note when read tools exist", () => {
    const html = row(catalog);
    expect(html).toContain("数据读取");
    expect(html).toContain("虚拟调试");
    // 以前会坏：固定示例"检查设备异常"与目录无关地展示。
    expect(html).not.toContain("检查设备异常");
    expect(html).not.toContain("没有可直接运行的只读能力");
  });
  it("explains the disabled sample button visibly when the catalog has no runnable read tool", () => {
    const html = row([]);
    expect(html).toContain("一键运行样例");
    expect(html).toContain("disabled");
    // 以前会坏：目录加载失败时新手只看到禁用按钮，无可见原因。
    expect(html).toContain("没有可直接运行的只读能力");
    expect(html).toContain("只读检查当前项目可用能力与数据");
  });
  it("keeps the note silent while the catalog is still loading", () => {
    expect(row([], { loading: true })).not.toContain("没有可直接运行的只读能力");
  });
});

function render(checkpoint: AgentCheckpoint, projectId?: string): string {
  return renderToStaticMarkup(
    <IndustrialAgentRunView
      locale="zh-CN"
      checkpoint={checkpoint}
      tools={tools}
      busy={false}
      {...(projectId ? { projectId } : {})}
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
