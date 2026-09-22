import { describe, expect, it } from "vitest";
import type { AgentDecisionRecord, AgentToolRecord } from "@bim-studio/industrial-agent-orchestrator";
import { AgentContextBudgetError, compressAgentContext } from "./agentContextBudget.js";

function decisionRecord(step: number): AgentDecisionRecord {
  return { step, decidedAt: `2026-09-20T00:00:0${step % 10}.000Z`, decision: { kind: "call-tool", rationale: `第 ${step} 轮决策理由，包含较长的说明文本用于验证摘要截断行为`, call: { toolId: "data.query.read", arguments: { sql: `SELECT ${step}` }, resources: [{ kind: "project", id: "project-1", projectId: "project-1" }] } } };
}

function toolRecord(step: number, outputSize = 2_000): AgentToolRecord {
  return {
    step,
    fingerprint: `fp-${step}`,
    call: { toolId: "data.query.read", arguments: { sql: `SELECT ${step}` }, resources: [{ kind: "project", id: "project-1", projectId: "project-1" }] },
    effect: "read",
    startedAt: `2026-09-20T00:00:0${step % 10}.000Z`,
    completedAt: `2026-09-20T00:00:0${step % 10}.100Z`,
    outcome: {
      status: "completed",
      output: { rows: "x".repeat(outputSize), step },
      evidence: [{ id: `ev-${step}`, kind: "query", content: `证据内容-${step}-${"y".repeat(500)}` }],
      verificationEvidence: [],
    },
  };
}

describe("agent context budget", () => {
  it("keeps recent rounds at full fidelity without marking compression", () => {
    const decisions = [1, 2, 3].map(decisionRecord);
    const toolRecords = [1, 2, 3].map((step) => toolRecord(step));
    const context = compressAgentContext(decisions, toolRecords, { recentRounds: 6 });
    expect(context.compression).toMatchObject({ applied: false, summarizedDecisions: 0, summarizedToolResults: 0 });
    expect(context.decisions).toEqual(decisions);
    expect(context.toolResults[0]).toMatchObject({ toolId: "data.query.read", status: "completed" });
    expect(context.toolResults[0].summarized).toBeUndefined();
    expect(context.toolResults[0].output).toEqual(toolRecords[0].outcome.output);
    expect(context.compression.approxChars).toBe(JSON.stringify({ decisions: context.decisions, toolResults: context.toolResults }).length);
  });

  it("summarizes the oldest rounds instead of hard-truncating them", () => {
    const decisions = [1, 2, 3, 4, 5].map(decisionRecord);
    const toolRecords = [1, 2, 3, 4, 5].map((step) => toolRecord(step));
    const context = compressAgentContext(decisions, toolRecords, { recentRounds: 2 });
    expect(context.compression).toMatchObject({ applied: true, summarizedDecisions: 3, summarizedToolResults: 3 });
    const summarizedDecision = context.decisions[0] as { step: number; kind: string; rationale: string; summarized: boolean };
    expect(summarizedDecision).toMatchObject({ step: 1, kind: "call-tool", summarized: true });
    expect(summarizedDecision).toHaveProperty("call", toolRecords[0].call);
    expect(context.toolResults.map((result) => result.step)).toEqual(context.decisions.map((decision) => decision.step));
    expect(summarizedDecision.rationale).toContain("第 1 轮");
    expect(summarizedDecision.rationale.length).toBeLessThanOrEqual(decisionRecord(1).decision.rationale.length);
    const recent = context.decisions.at(-1);
    expect(recent).toEqual(decisions[4]);
    const summarizedTool = context.toolResults[0];
    expect(summarizedTool).toMatchObject({ toolId: "data.query.read", status: "completed", summarized: true, evidenceCount: 1 });
    expect(String(summarizedTool.output).length).toBeLessThanOrEqual(260);
    expect(summarizedTool.outputLength).toBeGreaterThan(2_000);
    expect(String((summarizedTool.evidence[0] as { content: string }).content)).toContain("已摘要压缩");
    const recentTool = context.toolResults.at(-1)!;
    expect(recentTool.summarized).toBeUndefined();
    expect(recentTool.output).toEqual(toolRecords[4].outcome.output);
  });

  it("shrinks the full-fidelity window until the serialized context fits the char budget", () => {
    const decisions = Array.from({ length: 12 }, (_, index) => decisionRecord(index + 1));
    const toolRecords = Array.from({ length: 12 }, (_, index) => toolRecord(index + 1, 2_000));
    const context = compressAgentContext(decisions, toolRecords, { recentRounds: 8, charBudget: 12_000 });
    const serialized = JSON.stringify({ decisions: context.decisions, toolResults: context.toolResults });
    expect(serialized.length).toBeLessThanOrEqual(12_000);
    expect(context.compression.applied).toBe(true);
    // 全保真窗口收缩但从不归零：最近一轮保持原始输出。
    const full = context.toolResults.filter((item) => !item.summarized);
    expect(full.length).toBeGreaterThanOrEqual(1);
    expect(full.length).toBeLessThan(8);
    expect(context.toolResults.at(-1)!.output).toEqual(toolRecords[11].outcome.output);
    expect(context.decisions.at(-1)).toEqual(decisions[11]);
    expect(context.compression.approxChars).toBe(serialized.length);
    expect(context.compression.charBudget).toBe(12_000);
  });

  it("rejects an uncompressible newest tool pair instead of silently exceeding the budget", () => {
    const decisions = Array.from({ length: 6 }, (_, index) => decisionRecord(index + 1));
    const toolRecords = Array.from({ length: 6 }, (_, index) => toolRecord(index + 1, 60_000));
    expect(() => compressAgentContext(decisions, toolRecords, { recentRounds: 6, charBudget: 1_000 })).toThrow(AgentContextBudgetError);
    expect(toolRecords[5].outcome.output).toEqual({ rows: "x".repeat(60_000), step: 6 });
  });

  it("rejects oversized historical arguments without cutting the call away from its result", () => {
    const decisions = [decisionRecord(1), decisionRecord(2)];
    if (decisions[0].decision.kind === "call-tool") decisions[0].decision.call.arguments = { rows: "x".repeat(50_000) };
    expect(() => compressAgentContext(decisions, [toolRecord(1), toolRecord(2)], { recentRounds: 1 })).toThrow(AgentContextBudgetError);
  });
});
