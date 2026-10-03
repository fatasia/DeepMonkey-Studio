import { describe, expect, it, vi } from "vitest";
import { AUTONOMY_APPROVER, IndustrialAgentOrchestrator } from "./orchestrator.js";
import { MemoryAgentCheckpointStore } from "./memoryCheckpointStore.js";
import type {
  AgentDecision,
  AgentDecisionProvider,
  AgentDiscoveryMode,
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
/** 通用开发模式面（策划环之外、注册表内）的示例能力。 */
const DRAFT_TOOL: AgentToolDefinition = {
  id: "modeling.parametric.draft",
  label: "参数化草案",
  description: "生成参数化建模草案",
  effect: "write",
  risk: "high",
  requiresApproval: true,
};

/**
 * H-autonomy 四要素的编排层闭环：
 * ② 已授权修改自主执行（策略签发审批 + 指纹不变）；
 * ③ 取消/回滚/审计继续有效（取消照常、审批来源落工具记录）；
 * ④ 通用开发模式按授权发现（discovery 面随 run 固化，curated 面行为不变）；
 * ① 的持久化默认在 API 层测试覆盖，这里覆盖 run 级覆盖与 checkpoint 固化。
 */
describe("IndustrialAgentOrchestrator autonomy", () => {
  it("auto-executes an authorized high-risk tool with a policy-signed approval in autonomous mode", async () => {
    const decisions: AgentDecision[] = [
      toolDecision("industrial.control", { target: "pump-1", enabled: true }),
      finishWith(["control-evidence", "verification-evidence"]),
    ];
    const runtime = fixture(decisions, async (_call, context) => {
      // 策略签发审批与人工审批同形：指纹必须与本调用完全一致（下游硬防线照常校验）。
      expect(context.approval?.approvedBy).toBe(AUTONOMY_APPROVER);
      expect(context.approval?.scopeFingerprint).toBe(`fp:industrial.control:${JSON.stringify({ target: "pump-1", enabled: true })}`);
      return {
        ...outcome("control-evidence"),
        verificationEvidence: [{ id: "verification-evidence", kind: "trace", label: "状态回读", source: "plc:pump-1", fingerprint: "verified" }],
      };
    });

    const result = await runtime.orchestrator.start({ ...startInput([CONTROL_TOOL.id]), executionMode: "autonomous" });
    expect(result.status).toBe("completed");
    expect(result.status).not.toBe("awaiting-approval");
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    // 审计要素③：审批来源随工具记录持久化（策略签发 vs 人工确认可回溯）。
    expect(result.toolRecords[0]).toMatchObject({
      approval: { approvedBy: AUTONOMY_APPROVER, scopeFingerprint: `fp:industrial.control:${JSON.stringify({ target: "pump-1", enabled: true })}` },
    });
    // checkpoint 固化：自治授权随恢复语义持久化（重启恢复不做二次确认）。
    expect(result.autonomy).toEqual({ mode: "autonomous" });
  });

  it("keeps confirm as the default mode and still awaits human approval", async () => {
    const runtime = fixture([toolDecision("industrial.control", { target: "pump-1" })], async () => outcome("unused"));
    const waiting = await runtime.orchestrator.start(startInput([CONTROL_TOOL.id]));
    expect(waiting.status).toBe("awaiting-approval");
    expect(waiting.pendingTool).toMatchObject({ state: "awaiting-approval" });
    expect(waiting.autonomy).toBeUndefined();
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it("honors a narrowed auto-approve allowlist and still pauses tools outside it", async () => {
    const runtime = fixture(
      [
        toolDecision("industrial.control", { target: "pump-1" }),
        finishWith(["control-evidence", "verification-evidence"]),
      ],
      async () => ({
        ...outcome("control-evidence"),
        verificationEvidence: [{ id: "verification-evidence", kind: "trace" as const, label: "状态回读", source: "plc:pump-1", fingerprint: "verified" }],
      }),
    );
    const waiting = await runtime.orchestrator.start({
      ...startInput([CONTROL_TOOL.id]),
      executionMode: "autonomous",
      autoApproveToolIds: ["industrial.other-control"],
    });
    // 白名单外的高风险工具仍逐条等人审批（授权面收口）。
    expect(waiting.status).toBe("awaiting-approval");
    expect(runtime.execute).not.toHaveBeenCalled();

    const completed = await runtime.orchestrator.resume(waiting.id, {
      approval: { approvedBy: "operator-1", approvedAt: new Date().toISOString(), scopeFingerprint: waiting.pendingTool!.fingerprint },
    });
    expect(completed.status).toBe("completed");
    expect(completed.toolRecords[0]?.approval).toMatchObject({ approvedBy: "operator-1" });
  });

  it("never auto-approves in plan mode: read-only face wins over autonomous mode", async () => {
    const runtime = fixture([toolDecision("industrial.control", { target: "pump-1" })], async () => outcome("unused"));
    const blocked = await runtime.orchestrator.start({
      ...startInput([CONTROL_TOOL.id, ANALYZE_TOOL.id]),
      planMode: true,
      executionMode: "autonomous",
    });
    // plan 档先把控制工具从授权面剔除；即便自主档在开，也不产生任何免确认写入。
    expect(blocked.status).toBe("blocked");
    expect(blocked.failure?.code).toBe("tool-not-allowed");
    expect(blocked.allowedToolIds).toEqual([ANALYZE_TOOL.id]);
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it("cancels an autonomous run mid-flight and persists the cancelled checkpoint", async () => {
    const runtime = fixture(
      [toolDecision("industrial.analyze", { assetId: "motor-1" })],
      async (_call, context) => new Promise((_, reject) => context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    );
    const running = runtime.orchestrator.start({ ...startInput([ANALYZE_TOOL.id]), executionMode: "autonomous" });
    await vi.waitFor(() => expect(runtime.execute).toHaveBeenCalledTimes(1));

    const cancelled = await runtime.orchestrator.cancel("run-1", "operator-1");
    expect(cancelled.status).toBe("cancelled");
    expect((await running).status).toBe("cancelled");
    expect((await runtime.orchestrator.get("run-1"))?.failure?.code).toBe("cancelled");
  });

  it("discovers registered general-mode tools by authorization and keeps the curated face unchanged", async () => {
    const runtime = modeAwareFixture(
      [
        toolDecision("modeling.parametric.draft", { prompt: "传送线建模草案" }),
        finishWith(["draft-evidence", "draft-verify"]),
      ],
      async () => ({
        ...outcome("draft-evidence"),
        verificationEvidence: [{ id: "draft-verify", kind: "trace", label: "草案回读", source: "modeling", fingerprint: "verified" }],
      }),
    );
    const general = await runtime.orchestrator.start({
      ...startInput([DRAFT_TOOL.id]),
      executionMode: "autonomous",
      discovery: "general",
    });
    // general 面：注册表内策划环外工具按授权可见并可执行（自主档免逐条确认）。
    expect(general.status).toBe("completed");
    expect(general.discovery).toBe("general");
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    expect(runtime.listMode).toBe("general");

    const curated = modeAwareFixture([toolDecision("modeling.parametric.draft", { prompt: "x" })], async () => outcome("unused"));
    // curated 面（默认）：同一工具不在策划清单 → 启动归一即拒绝（fail-closed，不进入运行）。
    await expect(curated.orchestrator.start(startInput([DRAFT_TOOL.id]))).rejects.toThrow("Agent 工具不存在");
    expect(curated.listMode).toBe("curated");
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
  const { tools, execute } = staticGateway(implementation);
  return {
    orchestrator: new IndustrialAgentOrchestrator({ decisions: decisionProvider, tools, checkpoints, createId: () => "run-1" }),
    execute,
  };
}

/** discovery 敏感测试台：记录 list 收到的发现面，general 面比 curated 多一个注册环外工具。 */
function modeAwareFixture(
  sequence: AgentDecision[],
  implementation: (call: AgentToolCall, context: AgentToolExecutionContext) => Promise<AgentToolOutcome>,
) {
  const decisions = [...sequence];
  const listMode: AgentDiscoveryMode | undefined = undefined;
  const seen: AgentDiscoveryMode[] = [];
  const execute = vi.fn(implementation);
  const tools: AgentToolGateway = {
    list: (mode) => {
      seen.push(mode ?? "curated");
      return mode === "general" ? [ANALYZE_TOOL, CONTROL_TOOL, DRAFT_TOOL] : [ANALYZE_TOOL, CONTROL_TOOL];
    },
    fingerprint: (call) => `fp:${call.toolId}:${JSON.stringify(call.arguments)}`,
    execute,
  };
  const orchestrator = new IndustrialAgentOrchestrator({
    decisions: { decide: async () => decisions.shift() ?? { kind: "stop", rationale: "测试决策耗尽", code: "empty", message: "没有更多决策" } },
    tools,
    checkpoints: new MemoryAgentCheckpointStore(),
    createId: () => "run-1",
  });
  return { orchestrator, execute, get listMode() { return seen.at(-1) ?? listMode; } };
}

function staticGateway(implementation: (call: AgentToolCall, context: AgentToolExecutionContext) => Promise<AgentToolOutcome>) {
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

function finishWith(evidenceIds: string[]): AgentDecision {
  return {
    kind: "finish",
    rationale: "控制结果已经过回读验证",
    summary: "设备状态已验证",
    decisionStatus: "production",
    evidenceIds,
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
