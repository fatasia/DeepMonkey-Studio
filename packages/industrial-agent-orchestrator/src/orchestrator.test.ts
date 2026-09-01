import { describe, expect, it, vi } from "vitest";
import { IndustrialAgentOrchestrator } from "./orchestrator.js";
import { MemoryAgentCheckpointStore } from "./memoryCheckpointStore.js";
import type {
  AgentApproval,
  AgentDecision,
  AgentDecisionProvider,
  AgentToolCall,
  AgentToolDefinition,
  AgentToolExecutionContext,
  AgentToolGateway,
  AgentToolOutcome,
} from "./types.js";

const ANALYZE_TOOL: AgentToolDefinition = {
  id: "industrial.analyze",
  label: "工业分析",
  description: "读取证据并分析",
  effect: "analyze",
  risk: "medium",
  requiresApproval: false,
};
const CONTROL_TOOL: AgentToolDefinition = {
  id: "industrial.control",
  label: "设备控制",
  description: "写入控制设定",
  effect: "control",
  risk: "high",
  requiresApproval: true,
};

describe("IndustrialAgentOrchestrator", () => {
  it("blocks an identical tool call instead of looping until the budget is exhausted", async () => {
    const call = toolDecision("industrial.analyze", { assetId: "motor-1" });
    const runtime = fixture([call, call], async () => outcome("analysis-1"));
    const result = await runtime.orchestrator.start(startInput([ANALYZE_TOOL.id]));

    expect(result.status).toBe("blocked");
    expect(result.failure?.code).toBe("duplicate-tool-call");
    expect(result.usage).toMatchObject({ steps: 2, toolCalls: 1 });
    expect(runtime.execute).toHaveBeenCalledTimes(1);
  });

  it("enforces independent step and tool-call budgets", async () => {
    const stepLimited = fixture([
      toolDecision("industrial.analyze", { assetId: "motor-1" }),
      toolDecision("industrial.analyze", { assetId: "motor-2" }),
    ], async () => outcome("analysis"));
    const stepResult = await stepLimited.orchestrator.start({ ...startInput([ANALYZE_TOOL.id]), budget: { maxSteps: 1 } });
    expect(stepResult).toMatchObject({ status: "budget-exhausted", failure: { code: "step-budget" }, usage: { steps: 1, toolCalls: 1 } });

    const toolLimited = fixture([toolDecision("industrial.analyze", { assetId: "motor-1" })], async () => outcome("unused"));
    const toolResult = await toolLimited.orchestrator.start({ ...startInput([ANALYZE_TOOL.id]), budget: { maxToolCalls: 0 } });
    expect(toolResult).toMatchObject({ status: "budget-exhausted", failure: { code: "tool-budget" }, usage: { steps: 1, toolCalls: 0 } });
    expect(toolLimited.execute).not.toHaveBeenCalled();
  });

  it("persists an approval checkpoint and resumes the exact write scope after approval", async () => {
    const decisions: AgentDecision[] = [
      toolDecision("industrial.control", { target: "pump-1", enabled: true }),
      {
        kind: "finish",
        rationale: "控制结果已经过回读验证",
        summary: "泵已启动并完成状态回读",
        decisionStatus: "production",
        evidenceIds: ["control-evidence", "verification-evidence"],
      },
    ];
    const store = new MemoryAgentCheckpointStore();
    const runtime = fixture(decisions, async (_call, context) => {
      expect(context.approval?.scopeFingerprint).toBe("fp:industrial.control:{\"target\":\"pump-1\",\"enabled\":true}");
      return {
        ...outcome("control-evidence"),
        verificationEvidence: [{ id: "verification-evidence", kind: "trace", label: "设备状态回读", source: "plc:pump-1", fingerprint: "verified" }],
      };
    }, store);

    const waiting = await runtime.orchestrator.start(startInput([CONTROL_TOOL.id]));
    expect(waiting.status).toBe("awaiting-approval");
    expect(waiting.pendingTool).toMatchObject({ state: "awaiting-approval", effect: "control" });

    // 新实例复用同一 checkpoint store，证明审批等待不依赖原进程内存。
    const recovered = fixture(decisions.slice(1), runtime.execute, store).orchestrator;
    const approval: AgentApproval = {
      approvedBy: "operator-1",
      approvedAt: new Date().toISOString(),
      scopeFingerprint: waiting.pendingTool!.fingerprint,
    };
    const completed = await recovered.resume(waiting.id, { approval });
    expect(completed.status).toBe("completed");
    expect(completed.toolRecords[0]?.outcome.verificationEvidence).toHaveLength(1);
    expect(completed.completion?.evidenceIds).toEqual(["control-evidence", "verification-evidence"]);
  });

  it("fails closed when a write or control tool has no post-action verification evidence", async () => {
    const runtime = fixture(
      [toolDecision("industrial.control", { target: "pump-1" })],
      async () => outcome("control-evidence"),
    );
    const waiting = await runtime.orchestrator.start(startInput([CONTROL_TOOL.id]));
    const result = await runtime.orchestrator.resume(waiting.id, { approval: approvalFor(waiting.pendingTool!.fingerprint) });

    expect(result.status).toBe("failed");
    expect(result.failure?.message).toContain("验证证据");
  });

  it("does not replay a control call whose result became indeterminate across process recovery", async () => {
    const store = new MemoryAgentCheckpointStore();
    const first = fixture([toolDecision("industrial.control", { target: "pump-1" })], async () => outcome("unused"), store);
    const waiting = await first.orchestrator.start(startInput([CONTROL_TOOL.id]));
    waiting.status = "running";
    waiting.pendingTool!.state = "executing";
    waiting.pendingTool!.approval = approvalFor(waiting.pendingTool!.fingerprint);
    await store.save(waiting);

    const recovered = fixture([], async () => outcome("must-not-run"), store);
    const result = await recovered.orchestrator.resume(waiting.id);
    expect(result.status).toBe("blocked");
    expect(result.failure?.code).toBe("indeterminate-side-effect");
    expect(recovered.execute).not.toHaveBeenCalled();
  });

  it("cancels an in-flight tool and persists the terminal checkpoint", async () => {
    const runtime = fixture([toolDecision("industrial.analyze", { assetId: "motor-1" })], async (_call, context) =>
      new Promise((_, reject) => context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    );
    const running = runtime.orchestrator.start(startInput([ANALYZE_TOOL.id]));
    await vi.waitFor(() => expect(runtime.execute).toHaveBeenCalledTimes(1));

    const cancelled = await runtime.orchestrator.cancel("run-1", "operator-1");
    expect(cancelled.status).toBe("cancelled");
    expect((await running).status).toBe("cancelled");
    expect((await runtime.orchestrator.get("run-1"))?.failure?.code).toBe("cancelled");
  });

  it("returns a durable run id before detached execution and remains cancellable", async () => {
    const runtime = fixture([toolDecision("industrial.analyze", { assetId: "motor-1" })], async (_call, context) =>
      new Promise((_, reject) => context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    );
    const created = await runtime.orchestrator.startDetached(startInput([ANALYZE_TOOL.id]));
    expect(created).toMatchObject({ id: "run-1", status: "running", revision: 1 });
    await vi.waitFor(() => expect(runtime.execute).toHaveBeenCalledTimes(1));

    await runtime.orchestrator.cancel(created.id, "operator-1");
    await vi.waitFor(async () => expect((await runtime.orchestrator.get(created.id))?.status).toBe("cancelled"));
  });

  it("enforces time budget even when a decision provider ignores AbortSignal", async () => {
    const decisions: AgentDecisionProvider = { decide: () => new Promise(() => undefined) };
    const store = new MemoryAgentCheckpointStore();
    const toolRuntime = gateway(async () => outcome("unused"));
    const orchestrator = new IndustrialAgentOrchestrator({ decisions, tools: toolRuntime.tools, checkpoints: store });

    const result = await orchestrator.start({ ...startInput([ANALYZE_TOOL.id]), budget: { maxDurationMs: 1_000 } });
    expect(result.status).toBe("budget-exhausted");
    expect(result.failure?.message).toContain("时间预算");
    expect(result.usage.activeDurationMs).toBe(1_000);
  });
});

function fixture(
  sequence: AgentDecision[],
  implementation: (call: AgentToolCall, context: AgentToolExecutionContext) => Promise<AgentToolOutcome>,
  checkpoints = new MemoryAgentCheckpointStore(),
) {
  const decisions = [...sequence];
  const decisionProvider: AgentDecisionProvider = {
    decide: async () => decisions.shift() ?? { kind: "stop", rationale: "测试决策耗尽", code: "empty", message: "没有更多决策" },
  };
  const { tools, execute } = gateway(implementation);
  return {
    orchestrator: new IndustrialAgentOrchestrator({ decisions: decisionProvider, tools, checkpoints, createId: () => "run-1" }),
    execute,
  };
}

function gateway(implementation: (call: AgentToolCall, context: AgentToolExecutionContext) => Promise<AgentToolOutcome>) {
  const execute = vi.fn(implementation);
  const tools: AgentToolGateway = {
    list: () => [ANALYZE_TOOL, CONTROL_TOOL],
    fingerprint: (call) => `fp:${call.toolId}:${JSON.stringify(call.arguments)}`,
    execute,
  };
  return { tools, execute };
}

function toolDecision(toolId: string, argumentsValue: Record<string, unknown>): AgentDecision {
  return {
    kind: "call-tool",
    rationale: "需要调用已授权工业能力取得证据",
    call: { toolId, arguments: argumentsValue, resources: [{ kind: "project", id: "project-1", projectId: "project-1" }] },
  };
}

function outcome(evidenceId: string): AgentToolOutcome {
  return {
    status: "completed",
    output: { ok: true },
    evidence: [{ id: evidenceId, kind: "trace", label: "工具证据", source: "test", fingerprint: evidenceId }],
    verificationEvidence: [],
  };
}

function startInput(allowedToolIds: string[]) {
  return {
    projectId: "project-1",
    principal: "operator-1",
    role: "editor",
    objective: "根据现场证据完成一次受控诊断",
    allowedToolIds,
  };
}

function approvalFor(scopeFingerprint: string): AgentApproval {
  return { approvedBy: "operator-1", approvedAt: new Date().toISOString(), scopeFingerprint };
}
