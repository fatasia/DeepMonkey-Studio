import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentCheckpoint } from "@bim-studio/industrial-agent-orchestrator";
import { AiHarnessDenialCard } from "./AiHarnessDenialCard";
import { agentGuardCircuit, agentGuardDenials } from "../ai/industrialAgentViewModel";
import { IndustrialAgentRunView } from "./IndustrialAgentWorkspace";

const LOCALE = "zh-CN" as const;

describe("AiHarnessDenialCard（M6 拒绝理由气泡：理由码徽标 + 保证句 + 恢复动作）", () => {
  const denial = {
    step: 2,
    toolId: "simulation.golden.verify",
    code: "semantic-admission",
    message: "假设携带未声明字段 hypothesis.warmupMinutes；合同外字段会被静默忽略，不得进入内核域，请修正假设结构",
  };

  it("语义预检拒绝：理由码徽标、保证句（未执行未写入）、恢复动作齐备", () => {
    const html = renderToStaticMarkup(<AiHarnessDenialCard locale={LOCALE} denial={denial} onRecover={() => undefined} />);
    expect(html).toContain("ai-card-denial");
    expect(html).toContain("role=\"alert\"");
    expect(html).toContain("semantic-admission");
    expect(html).toContain("工具调用被拒绝");
    expect(html).toContain("warmupMinutes");
    expect(html).toContain("未写入任何变更");
    expect(html).toContain("刷新进度");
    expect(html).toContain("拒绝已落审计");
  });

  it("熔断拒绝：熔断标题、计数、人工介入语义与开始新任务动作", () => {
    const html = renderToStaticMarkup(
      <AiHarnessDenialCard
        locale={LOCALE}
        denial={{ ...denial, code: "variant-circuit-open", message: "同一提案变体连续 3 次被拒绝，已终止本轮等待人工介入" }}
        circuitDenials={3}
      />,
    );
    expect(html).toContain("denial-circuit");
    expect(html).toContain("variant-circuit-open");
    expect(html).toContain("变体熔断：本轮已终止");
    expect(html).toContain("同变体连续被拒 3 次");
    expect(html).toContain("不会自动继续");
    expect(html).toContain("开始新任务");
  });
});

function checkpointFixture(): AgentCheckpoint {
  return {
    schemaVersion: 1,
    id: "run-1",
    projectId: "project-1",
    principal: "operator",
    objective: "验证假设",
    context: {},
    status: "running",
    budget: { maxSteps: 8, maxToolCalls: 6, maxDurationMs: 60_000 },
    usage: { steps: 3, toolCalls: 0, activeDurationMs: 0 },
    allowedToolIds: ["simulation.golden.verify"],
    decisions: [],
    toolRecords: [],
    seenToolFingerprints: [],
    createdAt: "2026-09-28T10:00:00.000Z",
    updatedAt: "2026-09-28T10:00:00.000Z",
    revision: 4,
  };
}

function guardRecord(step: number, code: string, message: string) {
  return {
    step,
    fingerprint: `fp-${step}`,
    call: { toolId: "simulation.golden.verify", arguments: {}, resources: [{ kind: "project", id: "project-1" }] },
    effect: "analyze" as const,
    startedAt: "2026-09-28T10:00:00.000Z",
    completedAt: "2026-09-28T10:00:01.000Z",
    outcome: { status: "blocked" as const, evidence: [], verificationEvidence: [], error: { code, message, retryable: false } },
  };
}

describe("agentGuardDenials / agentGuardCircuit（M6 数据源）", () => {
  it("只提取保安拒绝（semantic-admission / variant-circuit-open），普通工具失败不进 M6", () => {
    const checkpoint = checkpointFixture();
    checkpoint.toolRecords.push(
      guardRecord(1, "semantic-admission", "未知字段"),
      guardRecord(2, "variant-circuit-open", "熔断"),
      guardRecord(3, "tool-failed", "普通失败"),
    );
    const denials = agentGuardDenials(checkpoint);
    expect(denials.map((item) => item.code)).toEqual(["semantic-admission", "variant-circuit-open"]);
    expect(agentGuardCircuit(checkpoint)?.denials).toBeUndefined();
    checkpoint.guards = { circuit: { variantKey: "k", reasonCode: "semantic-admission", message: "m", openedAt: "2026-09-28T10:00:02.000Z", denials: 3 } };
    expect(agentGuardCircuit(checkpoint)?.denials).toBe(3);
  });
});

describe("IndustrialAgentRunView 接线（M6 气泡出现在运行视图）", () => {
  it("checkpoint 带保安拒绝时渲染 M6 气泡，理由码可见", () => {
    const checkpoint = checkpointFixture();
    checkpoint.toolRecords.push(guardRecord(1, "semantic-admission", "假设携带未声明字段 hypothesis.warmupMinutes"));
    const html = renderToStaticMarkup(
      <IndustrialAgentRunView locale={LOCALE} checkpoint={checkpoint} tools={[]} busy={false} onAction={() => undefined} onNew={() => undefined} />,
    );
    expect(html).toContain("ai-card-denial");
    expect(html).toContain("semantic-admission");
    expect(html).toContain("warmupMinutes");
  });

  it("无拒绝时不渲染 M6 容器", () => {
    const html = renderToStaticMarkup(
      <IndustrialAgentRunView locale={LOCALE} checkpoint={checkpointFixture()} tools={[]} busy={false} onAction={() => undefined} onNew={() => undefined} />,
    );
    expect(html).not.toContain("ai-card-denial");
  });
});
