import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentCheckpoint } from "@bim-studio/industrial-agent-orchestrator";
import type { AiVerificationEnvelope } from "@bim-studio/contracts";
import { AiHypothesisVerdictCard } from "./AiHypothesisVerdictCard";
import { IndustrialAgentRunView, IndustrialAgentWorkspace } from "./IndustrialAgentWorkspace";
import { agentVerdictEnvelopes } from "../ai/industrialAgentViewModel";

const ENVELOPE: AiVerificationEnvelope = {
  proposalFingerprint: "0123456789abcdef",
  inputFingerprint: "123456789abcdef0",
  resultFingerprint: "23456789abcdef01",
  verdict: "confirmed",
  tolerance: { absolute: 0.05 },
  reasonCode: "prediction-within-tolerance",
  rationale: "观测值低于阈值且越过容差带",
  observed: { metric: "resource-utilization", resourceId: "sensor-unit", value: 0.095238 },
  engineId: "plant-lite-des",
  goldenHash: "cf20cfbd6e97a617",
  goldenMatch: true,
  generatedAt: "2026-09-28T10:00:00.000Z",
  evidence: [
    { id: "23456789abcdef01", kind: "simulation", label: "校准基准 DES 运行指标指纹", source: "model:t23-conveyor-sensor-agv", fingerprint: "23456789abcdef01" },
    { id: "cf20cfbd6e97a617", kind: "trace", label: "校准 golden 基准对照一致", source: "golden:t23-conveyor-sensor-agv", fingerprint: "cf20cfbd6e97a617" },
  ],
};

describe("AiHypothesisVerdictCard（M4 结构化卡片，三重编码）", () => {
  it("confirmed：色徽章文字三重齐备，三指纹露前 4 位且 title 含全文", () => {
    const html = renderCard(ENVELOPE);
    expect(html).toContain("已证实");
    expect(html).toContain("ai-card-verdict verdict-confirmed");
    expect(html).toContain("badge-confirmed");
    expect(html).toContain("lucide-circle-check");
    expect(html).toContain("0123…");
    expect(html).toContain("2345…");
    expect(html).toContain('title="0123456789abcdef"');
    expect(html).toContain("cf20…");
    expect(html).toContain("sensor-unit");
    expect(html).not.toContain("0123456789abcdef</");
  });

  it("refuted：红系徽章 + 反驳说明行", () => {
    const html = renderCard({ ...ENVELOPE, verdict: "refuted", reasonCode: "prediction-outside-tolerance" });
    expect(html).toContain("已反驳");
    expect(html).toContain("badge-refuted");
    expect(html).toContain("lucide-ban");
    expect(html).toContain("被确定性内核反驳");
  });

  it("inconclusive：中性徽章 + 不可当证据的诚实说明", () => {
    const html = renderCard({ ...ENVELOPE, verdict: "inconclusive", reasonCode: "prediction-in-tolerance-band" });
    expect(html).toContain("无法判定");
    expect(html).toContain("badge-inconclusive");
    expect(html).toContain("lucide-file-clock");
    expect(html).toContain("不要把该结论当作支持或反驳的证据");
  });

  it("二级折叠默认收起，证据行在 footer 且带证据数", () => {
    const html = renderCard(ENVELOPE);
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("2 条指纹化证据");
  });
});

describe("agentVerdictEnvelopes（RunView 数据源）", () => {
  it("从 golden.verify 工具记录提取信封；非该工具或损坏输出跳过", () => {
    const checkpoint = fixture();
    checkpoint.toolRecords = [
      {
        step: 1,
        fingerprint: "fp-1",
        effect: "analyze",
        call: { toolId: "simulation.golden.verify", arguments: {}, resources: [{ kind: "project", id: "project-1" }] },
        startedAt: checkpoint.createdAt,
        completedAt: checkpoint.updatedAt,
        outcome: { status: "completed", evidence: [], verificationEvidence: [], output: ENVELOPE },
      },
      {
        step: 2,
        fingerprint: "fp-2",
        effect: "analyze",
        call: { toolId: "operations.energy.analyze", arguments: {}, resources: [{ kind: "project", id: "project-1" }] },
        startedAt: checkpoint.createdAt,
        completedAt: checkpoint.updatedAt,
        outcome: { status: "completed", evidence: [], verificationEvidence: [], output: { verdict: "confirmed" } },
      },
      {
        step: 3,
        fingerprint: "fp-3",
        effect: "analyze",
        call: { toolId: "simulation.golden.verify", arguments: {}, resources: [{ kind: "project", id: "project-1" }] },
        startedAt: checkpoint.createdAt,
        completedAt: checkpoint.updatedAt,
        outcome: { status: "completed", evidence: [], verificationEvidence: [], output: { broken: true } },
      },
    ];
    const verdicts = agentVerdictEnvelopes(checkpoint);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.envelope.verdict).toBe("confirmed");
  });
});

describe("H-C1 用户可感知接线", () => {
  it("RunView 把工具记录中的 verdict 渲染为 M4 结论卡片", () => {
    const checkpoint = fixture();
    checkpoint.status = "completed";
    checkpoint.toolRecords = [{
      step: 1,
      fingerprint: "fp-1",
      effect: "analyze",
      call: { toolId: "simulation.golden.verify", arguments: {}, resources: [{ kind: "project", id: "project-1" }] },
      startedAt: checkpoint.createdAt,
      completedAt: checkpoint.updatedAt,
      outcome: { status: "completed", evidence: [], verificationEvidence: [], output: ENVELOPE },
    }];
    const html = renderToStaticMarkup(
      <IndustrialAgentRunView locale="zh-CN" checkpoint={checkpoint} tools={[]} busy={false} onAction={vi.fn()} onNew={vi.fn()} />,
    );
    expect(html).toContain("ai-card-verdict");
    expect(html).toContain("已证实");
  });

  it("RunView 计划模式 checkpoint 在状态行显示计划模式徽标", () => {
    const checkpoint = fixture();
    checkpoint.planMode = true;
    const html = renderToStaticMarkup(
      <IndustrialAgentRunView locale="zh-CN" checkpoint={checkpoint} tools={[]} busy={false} onAction={vi.fn()} onNew={vi.fn()} />,
    );
    expect(html).toContain("计划模式");
  });

  it("输入区渲染计划模式 chip（aria-pressed 关闭态、无障碍 label），关闭时无 M7 状态行", () => {
    const html = renderToStaticMarkup(<IndustrialAgentWorkspace locale="zh-CN" context={{}} />);
    expect(html).toContain("ai-plan-chip");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("计划模式：只读探索并输出实施计划");
    expect(html).not.toContain("ai-notice-plan");
    expect(html).not.toContain("计划模式已开启");
  });
});

function renderCard(envelope: AiVerificationEnvelope): string {
  return renderToStaticMarkup(<AiHypothesisVerdictCard locale="zh-CN" envelope={envelope} toolLabel="校准基准假设验证" />);
}

function fixture(): AgentCheckpoint {
  return {
    schemaVersion: 1,
    id: "run-1",
    projectId: "project-1",
    principal: "editor-1",
    objective: "验证假设回路",
    context: {},
    status: "running",
    budget: { maxSteps: 10, maxDurationMs: 90_000, maxToolCalls: 6 },
    usage: { steps: 1, toolCalls: 0, activeDurationMs: 300 },
    allowedToolIds: ["simulation.golden.verify"],
    decisions: [],
    toolRecords: [],
    seenToolFingerprints: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:01.000Z",
    revision: 1,
  };
}
