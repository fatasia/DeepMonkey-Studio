import { describe, expect, it, vi } from "vitest";
import { IndustrialAgentOrchestrator } from "./orchestrator.js";
import { MemoryAgentCheckpointStore } from "./memoryCheckpointStore.js";
import type { AgentCheckpoint, AgentToolGateway } from "./types.js";
import { AgentDecisionUnavailableError } from "./errors.js";
import { canRetryAgentDecision } from "./recovery.js";

const finish = { kind: "finish", rationale: "完成", summary: "已读取证据", decisionStatus: "production", evidenceIds: ["read-1"] };
const call = { kind: "call-tool", rationale: "读取数据", call: { toolId: "read", arguments: {}, resources: [{ kind: "project", id: "p" }] } };
function fixture(decide: (checkpoint: AgentCheckpoint) => unknown) {
  const execute = vi.fn(async () => ({ status: "completed" as const, evidence: [{ id: "read-1", kind: "data", label: "数据", source: "fixture" }], verificationEvidence: [] }));
  const tools: AgentToolGateway = { list: () => [{ id: "read", label: "读取", description: "只读", effect: "read", risk: "low", requiresApproval: false }], fingerprint: () => "read-fingerprint", execute };
  const checkpoints = new MemoryAgentCheckpointStore();
  const runtime = new IndustrialAgentOrchestrator({ checkpoints, tools, decisions: { decide: async ({ checkpoint }) => decide(checkpoint) } });
  return { runtime, execute, checkpoints, start: () => runtime.start({ projectId: "p", principal: "user", objective: "检查数据", allowedToolIds: ["read"] }) };
}

describe("decision checkpoint recovery", () => {
  it("resumes a provider 504 without replaying completed tools or resetting budgets", async () => {
    let requests = 0;
    const f = fixture(() => { if (++requests === 1) return call; if (requests === 2) throw new Error("大模型请求失败：HTTP 504"); return finish; });
    const failed = await f.start();
    expect(failed.status).toBe("failed");
    const completed = await f.runtime.resume(failed.id, { expectedRevision: failed.revision });
    expect(completed.status).toBe("completed");
    expect(completed.usage).toMatchObject({ steps: 2, toolCalls: 1 });
    expect(completed.budget).toEqual(failed.budget);
    expect(completed.toolRecords).toEqual(failed.toolRecords);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("waits for an explicit named choice and persists that choice in the same run", async () => {
    const f = fixture(c => c.selections?.length ? { ...finish, decisionStatus: "insufficient-data", evidenceIds: [] } : {
      kind: "request-input", rationale: "数据源有歧义", question: "选择设备数据", options: [{ id: "a", label: "产线 A" }, { id: "b", label: "产线 B" }],
    });
    const waiting = await f.start();
    expect(waiting.status).toBe("awaiting-input");
    expect((await f.runtime.resume(waiting.id)).status).toBe("awaiting-input");
    const completed = await f.runtime.resume(waiting.id, { expectedRevision: waiting.revision, selectionId: "b", selectedBy: "operator" });
    expect(completed.status).toBe("completed");
    expect(completed.selections).toMatchObject([{ option: { id: "b", label: "产线 B" }, selectedBy: "operator" }]);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("rejects stale and concurrent resumes and caps manual retries without automatic loops", async () => {
    const decide = vi.fn(() => { throw new AgentDecisionUnavailableError("Gateway timeout"); });
    const f = fixture(decide);
    let checkpoint = await f.start();
    await expect(f.runtime.resume(checkpoint.id)).rejects.toMatchObject({ code: "checkpoint-conflict" });
    for (let retry = 0; retry < 3; retry++) {
      const results = await Promise.allSettled([f.runtime.resume(checkpoint.id, { expectedRevision: checkpoint.revision }), f.runtime.resume(checkpoint.id, { expectedRevision: checkpoint.revision })]);
      expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
      expect(results.find(item => item.status === "rejected")).toMatchObject({ reason: { code: "run-busy" } });
      checkpoint = (results.find(item => item.status === "fulfilled") as PromiseFulfilledResult<AgentCheckpoint>).value;
      expect(checkpoint.decisionRecoveries).toHaveLength(retry + 1);
    }
    expect(canRetryAgentDecision(checkpoint)).toBe(false);
    expect((await f.runtime.resume(checkpoint.id, { expectedRevision: checkpoint.revision })).status).toBe("failed");
    expect(decide).toHaveBeenCalledTimes(4);
  });

  it.each(["invalid JSON", "审批绕过", "大模型请求失败：HTTP 401"])("does not recover %s", async failure => {
    const f = fixture(() => { throw new Error(failure); });
    const checkpoint = await f.start();
    expect(canRetryAgentDecision(checkpoint)).toBe(false);
    expect(await f.runtime.resume(checkpoint.id, { expectedRevision: checkpoint.revision })).toEqual(checkpoint);
  });

  it("rejects unknown choices without consuming state and keeps cancellation terminal", async () => {
    const f = fixture(() => ({ kind: "request-input", rationale: "选择", question: "选数据源", options: [{ id: "a", label: "同名" }, { id: "b", label: "同名" }] }));
    const checkpoint = await f.start();
    await expect(f.runtime.resume(checkpoint.id, { expectedRevision: checkpoint.revision, selectionId: "foreign", selectedBy: "operator" })).rejects.toMatchObject({ code: "invalid-input" });
    expect(await f.runtime.get(checkpoint.id)).toEqual(checkpoint);
    const cancelled = await f.runtime.cancel(checkpoint.id, "operator");
    expect(cancelled.pendingSelection).toBeUndefined();
    await expect(f.runtime.resume(checkpoint.id, { expectedRevision: cancelled.revision, selectionId: "a", selectedBy: "operator" })).rejects.toMatchObject({ code: "invalid-state" });
  });

  it("never recovers a failed tool even if it labels itself like a provider failure", async () => {
    const f = fixture(() => call);
    f.execute.mockImplementation(async () => ({ status: "failed", evidence: [], verificationEvidence: [], error: { code: "decision-provider-unavailable", message: "504", retryable: true } }) as never);
    const checkpoint = await f.start();
    expect(canRetryAgentDecision(checkpoint)).toBe(false);
    await f.runtime.resume(checkpoint.id, { expectedRevision: checkpoint.revision });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});
