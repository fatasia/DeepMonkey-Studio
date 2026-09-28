import { describe, expect, it } from "vitest";
import { DEFAULT_VARIANT_DENIAL_LIMIT, IndustrialAgentOrchestrator } from "./orchestrator.js";
import { MemoryAgentCheckpointStore } from "./memoryCheckpointStore.js";
import type {
  AgentDecision,
  AgentDecisionProvider,
  AgentGuardHooks,
  AgentToolCall,
  AgentToolDefinition,
  AgentToolGateway,
} from "./types.js";

const READ_TOOL: AgentToolDefinition = {
  id: "data.read",
  label: "只读查询",
  description: "读取数据",
  effect: "read",
  risk: "low",
  requiresApproval: false,
};

const ALL_TOOLS = [READ_TOOL];

function fixture(options: {
  decisions: AgentDecision[];
  guards?: AgentGuardHooks;
  variantDenialLimit?: number;
  execute?: (call: AgentToolCall) => Promise<{ status: "completed"; evidence: never[]; verificationEvidence: never[] }>;
}) {
  const store = new MemoryAgentCheckpointStore();
  let step = 0;
  const executed: string[] = [];
  const orchestrator = new IndustrialAgentOrchestrator({
    checkpoints: store,
    ...(options.guards ? { guards: options.guards } : {}),
    ...(options.variantDenialLimit !== undefined ? { variantDenialLimit: options.variantDenialLimit } : {}),
    decisions: {
      decide: async () => options.decisions[Math.min(step++, options.decisions.length - 1)]!,
    } satisfies AgentDecisionProvider,
    tools: {
      list: () => ALL_TOOLS.map((tool) => structuredClone(tool)),
      fingerprint: (call) => `fp:${call.toolId}:${JSON.stringify(call.arguments)}`,
      execute: async (call) => {
        executed.push(call.toolId);
        return options.execute?.(call) ?? { status: "completed", evidence: [] as never, verificationEvidence: [] as never };
      },
    } satisfies AgentToolGateway,
  });
  return { orchestrator, store, executed };
}

function callDecision(toolId: string, args: Record<string, unknown> = {}): AgentDecision {
  return { kind: "call-tool", rationale: "推进", call: { toolId, arguments: args, resources: [{ kind: "project", id: "project-1" }] } };
}

const finish: AgentDecision = { kind: "finish", rationale: "完成", summary: "完成", decisionStatus: "shadow", evidenceIds: [] };

function rejection(code: string, variantKey?: string) {
  return { code, message: `拒绝：${code}`, variantKey };
}

describe("H-C2 受控挂载点：tool.pre-execute / tool.post-execute", () => {
  it("默认熔断阈值为 3（Codex 3/50 思想，N 独立可配）", () => {
    expect(DEFAULT_VARIANT_DENIAL_LIMIT).toBe(3);
  });

  it("pre-execute 拒绝：工具不执行、调用预算不消耗、拒绝以 blocked 工具记录回给决策者，run 继续", async () => {
    const preCalls: string[] = [];
    const { orchestrator, executed } = fixture({
      decisions: [callDecision("data.read"), callDecision("data.read", { retry: true }), finish],
      guards: {
        preExecute: async ({ call }) => {
          preCalls.push(JSON.stringify(call.arguments));
          return call.arguments.retry === true ? undefined : rejection("semantic-admission", "variant:a");
        },
      },
    });
    const result = await orchestrator.start({
      projectId: "project-1",
      principal: "operator",
      objective: "受控运行",
      allowedToolIds: [READ_TOOL.id],
      budget: { maxSteps: 8, maxToolCalls: 5, maxDurationMs: 60_000 },
    });
    expect(executed).toEqual(["data.read"]);
    expect(result.status).toBe("completed");
    expect(result.usage.toolCalls).toBe(1);
    const denied = result.toolRecords.filter((record) => record.outcome.status === "blocked");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.outcome.error).toMatchObject({ code: "semantic-admission", retryable: false });
    expect(denied[0]?.outcome.evidence).toEqual([]);
    // 拒绝记录进入决策者可见的 toolResults 序列（下一步决策基于它修正）。
    expect(result.seenToolFingerprints).toHaveLength(1);
  });

  it("同变体连续 N 次被拒：达到阈值即熔断终止本轮，熔断状态落 checkpoint", async () => {
    const { orchestrator, store, executed } = fixture({
      decisions: [callDecision("data.read"), callDecision("data.read", { a: 1 }), callDecision("data.read", { b: 2 })],
      guards: { preExecute: async () => rejection("semantic-admission", "variant:same") },
    });
    const result = await orchestrator.start({
      projectId: "project-1",
      principal: "operator",
      objective: "重试同变体",
      allowedToolIds: [READ_TOOL.id],
      budget: { maxSteps: 8, maxToolCalls: 9, maxDurationMs: 60_000 },
    });
    expect(executed).toEqual([]);
    expect(result.status).toBe("blocked");
    expect(result.failure?.code).toBe("variant-circuit-open");
    expect(result.failure?.message).toContain("variant-circuit-open".replace("variant-circuit-open", "semantic-admission"));
    expect(result.guards?.circuit).toMatchObject({ variantKey: "variant:same", reasonCode: "semantic-admission", denials: 3 });
    const persisted = await store.get(result.id);
    expect(persisted?.guards?.circuit).toBeDefined();
    expect(persisted?.guards?.variantDenials?.["variant:same"]?.count).toBe(3);
    expect(result.guards?.variantDenials?.["variant:same"]?.lastCode).toBe("semantic-admission");
  });

  it("不同变体不互相熔断；不同 variantKey 各自计数", async () => {
    let n = 0;
    const { orchestrator } = fixture({
      decisions: [callDecision("data.read"), callDecision("data.read", { a: 1 }), callDecision("data.read", { b: 2 }), finish],
      guards: { preExecute: async () => rejection("semantic-admission", `variant:${++n}`) },
    });
    const result = await orchestrator.start({
      projectId: "project-1",
      principal: "operator",
      objective: "每次都换变体",
      allowedToolIds: [READ_TOOL.id],
      budget: { maxSteps: 8, maxToolCalls: 9, maxDurationMs: 60_000 },
    });
    expect(result.status).toBe("completed");
    expect(result.guards?.circuit).toBeUndefined();
    expect(Object.keys(result.guards?.variantDenials ?? {})).toHaveLength(3);
  });

  it("N 独立可配：variantDenialLimit=2 时第 2 次即熔断", async () => {
    const { orchestrator } = fixture({
      decisions: [callDecision("data.read"), callDecision("data.read", { a: 1 })],
      guards: { preExecute: async () => rejection("semantic-admission", "variant:same") },
      variantDenialLimit: 2,
    });
    const result = await orchestrator.start({
      projectId: "project-1",
      principal: "operator",
      objective: "低阈值熔断",
      allowedToolIds: [READ_TOOL.id],
      budget: { maxSteps: 8, maxToolCalls: 9, maxDurationMs: 60_000 },
    });
    expect(result.status).toBe("blocked");
    expect(result.guards?.circuit?.denials).toBe(2);
  });

  it("熔断后 run 为终态：resume 不再推进（人工介入语义：新开 run 计数独立）", async () => {
    const { orchestrator, store } = fixture({
      decisions: [callDecision("data.read")],
      guards: { preExecute: async () => rejection("semantic-admission", "variant:same") },
      variantDenialLimit: 1,
    });
    const halted = await orchestrator.start({
      projectId: "project-1",
      principal: "operator",
      objective: "熔断恢复",
      allowedToolIds: [READ_TOOL.id],
    });
    expect(halted.status).toBe("blocked");
    const resumed = await orchestrator.resume(halted.id);
    expect(resumed.status).toBe("blocked");
    expect(resumed.guards?.circuit?.denials).toBe(1);
    expect(resumed.revision).toBe(halted.revision);
    // 新 run 从零计数：同 variantKey 再次拒绝需要重新累计。
    const fresh = new IndustrialAgentOrchestrator({
      checkpoints: store,
      guards: { preExecute: async () => rejection("semantic-admission", "variant:same") },
      variantDenialLimit: 1,
      decisions: { decide: async () => callDecision("data.read") },
      tools: {
        list: () => ALL_TOOLS.map((tool) => structuredClone(tool)),
        fingerprint: (call) => `fp:${call.toolId}:${JSON.stringify(call.arguments)}`,
        execute: async () => ({ status: "completed", evidence: [], verificationEvidence: [] }),
      },
    });
    const next = await fresh.start({
      projectId: "project-1",
      principal: "operator",
      objective: "新任务",
      allowedToolIds: [READ_TOOL.id],
    });
    expect(next.id).not.toBe(halted.id);
    expect(next.guards?.circuit?.denials).toBe(1);
    expect(next.guards?.variantDenials?.["variant:same"]?.count).toBe(1);
  });

  it("post-execute 收到执行结果；抛错不阻断执行链（增值记录不是新故障面）", async () => {
    const seen: Array<{ toolId: string; status: string }> = [];
    const { orchestrator, executed } = fixture({
      decisions: [callDecision("data.read"), finish],
      guards: {
        postExecute: async ({ call, outcome }) => {
          seen.push({ toolId: call.toolId, status: outcome.status });
          throw new Error("回灌存储暂时不可用");
        },
      },
    });
    const result = await orchestrator.start({
      projectId: "project-1",
      principal: "operator",
      objective: "回灌失败不阻断",
      allowedToolIds: [READ_TOOL.id],
    });
    expect(executed).toEqual(["data.read"]);
    expect(result.status).toBe("completed");
    expect(seen).toEqual([{ toolId: "data.read", status: "completed" }]);
  });

  it("未配置 guards 时行为与 H-C1 完全一致（零增量面）", async () => {
    const { orchestrator, executed } = fixture({ decisions: [callDecision("data.read"), finish] });
    const result = await orchestrator.start({
      projectId: "project-1",
      principal: "operator",
      objective: "无保安",
      allowedToolIds: [READ_TOOL.id],
    });
    expect(result.status).toBe("completed");
    expect(result.guards).toBeUndefined();
    expect(executed).toEqual(["data.read"]);
  });
});
