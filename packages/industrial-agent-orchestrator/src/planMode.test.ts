import { describe, expect, it } from "vitest";
import { IndustrialAgentOrchestrator } from "./orchestrator.js";
import { MemoryAgentCheckpointStore } from "./memoryCheckpointStore.js";
import type {
  AgentDecision,
  AgentDecisionProvider,
  AgentToolCall,
  AgentToolDefinition,
  AgentToolGateway,
  AgentToolOutcome,
} from "./types.js";

const READ_TOOL: AgentToolDefinition = {
  id: "data.read",
  label: "只读查询",
  description: "读取数据",
  effect: "read",
  risk: "low",
  requiresApproval: false,
};
const ANALYZE_TOOL: AgentToolDefinition = {
  id: "analysis.run",
  label: "分析",
  description: "分析证据",
  effect: "analyze",
  risk: "low",
  requiresApproval: false,
};
const SIMULATE_TOOL: AgentToolDefinition = {
  id: "simulation.run",
  label: "仿真",
  description: "运行仿真",
  effect: "simulate",
  risk: "medium",
  requiresApproval: false,
};
const CONTROL_TOOL: AgentToolDefinition = {
  id: "control.apply",
  label: "控制",
  description: "控制写入",
  effect: "control",
  risk: "high",
  requiresApproval: true,
};

const ALL_TOOLS = [READ_TOOL, ANALYZE_TOOL, SIMULATE_TOOL, CONTROL_TOOL];

function fixture(decisions: AgentDecision[], execute?: (call: AgentToolCall) => Promise<AgentToolOutcome>) {
  const store = new MemoryAgentCheckpointStore();
  let step = 0;
  const seenAvailable: AgentToolDefinition[][] = [];
  const orchestrator = new IndustrialAgentOrchestrator({
    checkpoints: store,
    decisions: {
      decide: async (request) => {
        seenAvailable.push(request.availableTools.map((tool) => tool.id));
        return decisions[Math.min(step++, decisions.length - 1)]!;
      },
    } satisfies AgentDecisionProvider,
    tools: {
      list: () => ALL_TOOLS.map((tool) => structuredClone(tool)),
      fingerprint: (call) => `fp:${call.toolId}`,
      execute: execute ?? (async () => ({ status: "completed", evidence: [], verificationEvidence: [] })),
    } satisfies AgentToolGateway,
  });
  return { orchestrator, store, seenAvailable };
}

function toolDecision(toolId: string): AgentDecision {
  return { kind: "call-tool", rationale: "推进计划探索", call: { toolId, arguments: {}, resources: [{ kind: "project", id: "project-1" }] } };
}

function planInput(allowedToolIds: string[]) {
  return {
    projectId: "project-1",
    principal: "planner",
    objective: "只读探索并输出实施计划",
    planMode: true,
    allowedToolIds,
  };
}

describe("plan 档（H-C1 最小版：更严白名单 + finish-with-plan，无新模式系统）", () => {
  it("决策者只看得见 read/analyze 工具（simulate/write 不进入 availableTools）", async () => {
    const { orchestrator, seenAvailable } = fixture([
      { kind: "finish", rationale: "计划已成形", summary: "# 实施计划\n1. 只读盘点\n2. 仿真验证", decisionStatus: "shadow", evidenceIds: [] },
    ]);
    const result = await orchestrator.start(planInput(ALL_TOOLS.map((tool) => tool.id)));
    expect(result.status).toBe("completed");
    expect(result.planMode).toBe(true);
    expect(seenAvailable[0]).toEqual(["data.read", "analysis.run"]);
    expect(result.completion?.summary).toContain("实施计划");
  });

  it("plan 档下 finish-with-plan 不允许 production 结论（计划探索不是生产证据）", async () => {
    const { orchestrator } = fixture([
      { kind: "finish", rationale: "计划已成形", summary: "计划文档", decisionStatus: "production", evidenceIds: [] },
    ]);
    const result = await orchestrator.start(planInput([READ_TOOL.id, ANALYZE_TOOL.id]));
    expect(result.status).toBe("blocked");
    expect(result.failure?.code).toBe("plan-mode-production-verdict");
  });

  it("plan 档下 shadow 结论的计划文档正常完成（finish-with-plan 语义）", async () => {
    const { orchestrator } = fixture([
      { kind: "finish", rationale: "计划已成形", summary: "# 实施计划", decisionStatus: "insufficient-data", evidenceIds: [] },
    ]);
    const result = await orchestrator.start(planInput([READ_TOOL.id]));
    expect(result.status).toBe("completed");
    expect(result.completion?.decisionStatus).toBe("insufficient-data");
  });

  it("plan 档初始化即过滤 allowedToolIds：只保留 read/analyze", async () => {
    const { orchestrator } = fixture([{ kind: "stop", rationale: "结束", code: "done", message: "done" }]);
    const result = await orchestrator.start(planInput([READ_TOOL.id, SIMULATE_TOOL.id, CONTROL_TOOL.id]));
    expect(result.allowedToolIds).toEqual(["data.read"]);
  });

  it("plan 档全部请求工具被过滤且无剩余时 fail-closed 拒绝启动", async () => {
    const { orchestrator } = fixture([]);
    await expect(orchestrator.start(planInput([SIMULATE_TOOL.id]))).rejects.toThrowError(/至少选择一个/);
  });

  it("非 plan 模式不受影响：simulate 决策照常执行", async () => {
    const executed: string[] = [];
    const { orchestrator } = fixture([
      toolDecision("simulation.run"),
      { kind: "finish", rationale: "完成", summary: "完成", decisionStatus: "production", evidenceIds: ["ev-1"] },
    ], async (call) => {
      executed.push(call.toolId);
      return { status: "completed", evidence: [{ id: "ev-1", kind: "simulation", label: "仿真", source: "model:x" }], verificationEvidence: [] };
    });
    const result = await orchestrator.start({
      projectId: "project-1",
      principal: "operator",
      objective: "常规运行",
      allowedToolIds: [READ_TOOL.id, SIMULATE_TOOL.id],
    });
    expect(executed).toEqual(["simulation.run"]);
    expect(result.status).toBe("completed");
    expect(result.planMode).toBeUndefined();
  });
});
