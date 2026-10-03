import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IndustrialAgentOrchestrator,
  AgentDecisionUnavailableError,
  MemoryAgentCheckpointStore,
  type AgentDecision,
  type AgentToolCall,
  type AgentToolGateway,
} from "@bim-studio/industrial-agent-orchestrator";
import { createApiServer } from "../serverOptions.js";
import { registerIndustrialAgentRoutes } from "./industrialAgentRoutes.js";
import type { IndustrialAgentRuntime } from "./industrialAgentRuntime.js";

const closeTasks: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(closeTasks.splice(0).map((task) => task())));

describe("industrial Agent HTTP lifecycle", () => {
  it("validates and stores non-sensitive per-run model options before starting", async () => {
    const runtime = testRuntime([]);
    runtime.resolveModelOptions = vi.fn(async () => ({ model: "selected", reasoningEffort: "deep" }));
    const app = createApiServer(); closeTasks.push(() => app.close());
    await registerIndustrialAgentRoutes(app, { store: testStore(), runtime });
    const result = await app.inject({ method: "POST", url: "/api/projects/project-1/ai/agent-runs",
      payload: { objective: "检查", allowedToolIds: ["industrial.control"], modelOptions: { model: "selected", reasoningEffort: "deep" } } });
    expect(result.statusCode).toBe(201);
    expect(result.json().modelOptions).toEqual({ model: "selected", reasoningEffort: "deep" });
    expect((await runtime.checkpoints.get(result.json().id))?.modelOptions).toEqual(result.json().modelOptions);
    const invalid = await app.inject({ method: "POST", url: "/api/projects/project-1/ai/agent-runs", payload: { objective: "检查", modelOptions: [] } });
    expect(invalid.statusCode).toBe(400);
  });
  it("resumes a failed decision over HTTP in the same durable run", async () => {
    const runtime = testRuntime([]);
    let attempts = 0;
    runtime.orchestrator = new IndustrialAgentOrchestrator({ checkpoints: runtime.checkpoints, tools: runtime.tools, decisions: { decide: async () => {
      if (++attempts === 1) throw new AgentDecisionUnavailableError("HTTP 504");
      return { kind: "finish", rationale: "已恢复", summary: "等待真实采样", decisionStatus: "insufficient-data", evidenceIds: [] };
    } } });
    const app = createApiServer(); closeTasks.push(() => app.close());
    await registerIndustrialAgentRoutes(app, { store: testStore(), runtime });
    const origin = await app.listen({ port: 0, host: "127.0.0.1" });
    const created = await fetch(`${origin}/api/projects/project-1/ai/agent-runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "检查温度", allowedToolIds: ["industrial.control"] }) });
    const failed = await created.json() as { id: string; revision: number; status: string };
    expect(failed.status).toBe("failed");
    const resumed = await fetch(`${origin}/api/projects/project-1/ai/agent-runs/${failed.id}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: failed.revision, execution: "background" }) });
    expect(resumed.status).toBe(200);
    await vi.waitFor(async () => {
      const response = await fetch(`${origin}/api/projects/project-1/ai/agent-runs/${failed.id}`);
      expect(await response.json()).toMatchObject({ id: failed.id, status: "completed", decisionRecoveries: [{ revision: failed.revision }], usage: { steps: 1, toolCalls: 0 } });
    });
    expect(attempts).toBe(2);
    expect(runtime.tools.execute).not.toHaveBeenCalled();
  });
  it("binds choices to the authenticated actor and revision, rejecting foreign project and stale requests", async () => {
    const runtime = testRuntime([
      { kind: "request-input", rationale: "两个产线", question: "请选择", options: [{ id: "a", label: "产线 A" }, { id: "b", label: "产线 B" }] },
      { kind: "finish", rationale: "已选择", summary: "等待采样", decisionStatus: "insufficient-data", evidenceIds: [] },
    ]);
    const app = createApiServer(); closeTasks.push(() => app.close());
    app.addHook("preHandler", async request => { request.systemUser = { id: "server-actor", role: "editor" } as never; });
    await registerIndustrialAgentRoutes(app, { store: testStore(), runtime });
    const start = await app.inject({ method: "POST", url: "/api/projects/project-1/ai/agent-runs", payload: { objective: "查询温度", allowedToolIds: ["industrial.control"] } });
    const waiting = start.json();
    expect(waiting.status).toBe("awaiting-input");
    const path = `/api/projects/project-1/ai/agent-runs/${waiting.id}/resume`;
    const foreign = await app.inject({ method: "POST", url: path.replace("project-1", "foreign"), payload: { selectionId: "b", expectedRevision: waiting.revision } });
    expect(foreign.statusCode).toBe(404);
    const stale = await app.inject({ method: "POST", url: path, payload: { selectionId: "b", expectedRevision: waiting.revision - 1 } });
    expect(stale.statusCode).toBe(409);
    const selected = await app.inject({ method: "POST", url: path, payload: { selectionId: "b", expectedRevision: waiting.revision, selectedBy: "forged-user" } });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({ status: "completed", selections: [{ selectedBy: "server-actor", option: { id: "b" } }] });
  });

  it("refuses recovery and selection for a viewer before changing the checkpoint", async () => {
    const runtime = testRuntime([]);
    const app = createApiServer(); closeTasks.push(() => app.close());
    app.addHook("preHandler", async request => { request.systemUser = { id: "viewer", role: "viewer" } as never; });
    await registerIndustrialAgentRoutes(app, { store: testStore(), runtime });
    const response = await app.inject({ method: "POST", url: "/api/projects/project-1/ai/agent-runs/run-http-1/resume", payload: { selectionId: "a", expectedRevision: 2 } });
    expect(response.statusCode).toBe(403);
    expect(await runtime.checkpoints.get("run-http-1")).toBeUndefined();
  });
  it("returns background checkpoint immediately and exposes later approval progress", async () => {
    const runtime = testRuntime([{
      kind: "call-tool",
      rationale: "写入前等待审批",
      call: {
        toolId: "industrial.control",
        arguments: { target: "pump-1" },
        resources: [{ kind: "project", id: "project-1", projectId: "project-1" }],
      },
    }]);
    const app = createApiServer();
    await registerIndustrialAgentRoutes(app, { store: testStore(), runtime });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    closeTasks.push(() => app.close());

    const response = await fetch(`${address}/api/projects/project-1/ai/agent-runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "检查并受控操作泵", allowedToolIds: ["industrial.control"], execution: "background" }),
    });
    expect(response.status).toBe(202);
    const created = await response.json() as { id: string; status: string };
    expect(created.status).toBe("running");

    await vi.waitFor(async () => {
      const progress = await fetch(`${address}/api/projects/project-1/ai/agent-runs/${created.id}`);
      expect(await progress.json()).toMatchObject({ status: "awaiting-approval", pendingTool: { state: "awaiting-approval" } });
    });
  });

  it("starts a real HTTP server, waits for approval, resumes and exposes the durable result", async () => {
    const decisions: AgentDecision[] = [
      {
        kind: "call-tool",
        rationale: "控制前需要审批",
        call: {
          toolId: "industrial.control",
          arguments: { target: "pump-1", enabled: true },
          resources: [{ kind: "project", id: "project-1", projectId: "project-1" }],
        },
      },
      {
        kind: "finish",
        rationale: "控制和回读证据完整",
        summary: "泵状态已验证",
        decisionStatus: "production",
        evidenceIds: ["command-trace", "state-readback"],
      },
    ];
    const runtime = testRuntime(decisions);
    const app = createApiServer();
    await registerIndustrialAgentRoutes(app, { store: { getProject: (id) => id === "project-1" ? ({ id } as never) : undefined, getAgentSettings: () => undefined, saveAgentSettings: async (settings: unknown) => settings }, runtime });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    closeTasks.push(() => app.close());

    const catalog = await fetch(`${address}/api/projects/project-1/ai/agent-tools`);
    expect(await catalog.json()).toMatchObject({ tools: [{ id: "industrial.control", requiresApproval: true }] });

    const started = await fetch(`${address}/api/projects/project-1/ai/agent-runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "启动泵并验证回读", allowedToolIds: ["industrial.control"] }),
    });
    expect(started.status).toBe(201);
    const waiting = await started.json() as { id: string; status: string; pendingTool: { fingerprint: string } };
    expect(waiting.status).toBe("awaiting-approval");

    const approved = await fetch(`${address}/api/projects/project-1/ai/agent-runs/${waiting.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopeFingerprint: waiting.pendingTool.fingerprint }),
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: "completed", completion: { decisionStatus: "production" } });

    const restored = await fetch(`${address}/api/projects/project-1/ai/agent-runs/${waiting.id}`);
    expect(await restored.json()).toMatchObject({ status: "completed", usage: { steps: 2, toolCalls: 1 } });
    expect(runtime.tools.execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ approval: expect.objectContaining({ scopeFingerprint: waiting.pendingTool.fingerprint }) }));
  });
});


// ---------------------------------------------------------------------------
// H-autonomy：授权范围/执行模式配置面与自主执行 HTTP 闭环
// ---------------------------------------------------------------------------

describe("industrial Agent autonomy settings", () => {
  it("round-trips execution mode and general-development switch with fail-closed validation", async () => {
    const saved: unknown[] = [];
    const runtime = testRuntime([]);
    const app = createApiServer(); closeTasks.push(() => app.close());
    app.addHook("preHandler", async request => { request.systemUser = { id: "admin-1", role: "admin" } as never; });
    await registerIndustrialAgentRoutes(app, {
      store: {
        getProject: () => ({ id: "project-1" } as never),
        getAgentSettings: () => saved.at(-1) as never,
        saveAgentSettings: async (settings: unknown) => { saved.push(structuredClone(settings)); return settings; },
      },
      runtime,
    });

    const initial = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/agent-settings" });
    expect(initial.json()).toMatchObject({ settings: { mode: "confirm", generalDevelopment: false } });

    // 开关未开启：general 发现面的启动请求 fail-closed 400（理由码透传，先于任何工具解析）。
    const disabledStart = await app.inject({ method: "POST", url: "/api/projects/project-1/ai/agent-runs",
      payload: { objective: "检查", allowedToolIds: ["industrial.control"], discovery: "general" } });
    expect(disabledStart.statusCode).toBe(400);
    expect(disabledStart.json()).toMatchObject({ code: "invalid-flag" });

    const updated = await app.inject({ method: "PUT", url: "/api/projects/project-1/ai/agent-settings",
      payload: { mode: "autonomous", generalDevelopment: true, autoApproveToolIds: [" operations.control.apply ", "operations.control.apply"] } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ settings: { mode: "autonomous", generalDevelopment: true, autoApproveToolIds: ["operations.control.apply"], updatedBy: "admin-1" } });

    const readBack = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/agent-settings" });
    expect(readBack.json().settings.mode).toBe("autonomous");

    const invalid = await app.inject({ method: "PUT", url: "/api/projects/project-1/ai/agent-settings", payload: { mode: "run-wild" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "invalid-mode" });
    const unknownField = await app.inject({ method: "PUT", url: "/api/projects/project-1/ai/agent-settings", payload: { secret: true } });
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.json()).toMatchObject({ code: "unknown-field" });
    // 自主白名单垃圾输入 fail-closed 400（不得 500，更不得静默放大自主面）。
    const garbage = await app.inject({ method: "POST", url: "/api/projects/project-1/ai/agent-runs",
      payload: { objective: "检查", allowedToolIds: ["industrial.control"], executionMode: "autonomous", autoApproveToolIds: [42] } });
    expect(garbage.statusCode).toBe(400);
    expect(garbage.json()).toMatchObject({ code: "invalid-tool-list" });
  });

  it("refuses settings writes and general discovery for viewers and disabled switches", async () => {
    const runtime = testRuntime([]);
    const app = createApiServer(); closeTasks.push(() => app.close());
    app.addHook("preHandler", async request => { request.systemUser = { id: "viewer", role: "viewer" } as never; });
    await registerIndustrialAgentRoutes(app, { store: testStore(), runtime });

    const denied = await app.inject({ method: "PUT", url: "/api/projects/project-1/ai/agent-settings", payload: { mode: "autonomous" } });
    expect(denied.statusCode).toBe(403);
    // 开关未开启：general 发现面目录请求 fail-closed 400（理由码透传）。
    const tools = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/agent-tools?discovery=general" });
    expect(tools.statusCode).toBe(400);
    expect(tools.json()).toMatchObject({ code: "general-development-disabled" });
  });

  it("runs an authorized high-risk tool without per-action approval in autonomous mode", async () => {
    const decisions: AgentDecision[] = [
      { kind: "call-tool", rationale: "受控操作", call: { toolId: "industrial.control", arguments: { target: "pump-1", enabled: true }, resources: [{ kind: "project", id: "project-1", projectId: "project-1" }] } },
      { kind: "finish", rationale: "证据完整", summary: "泵已验证", decisionStatus: "production", evidenceIds: ["command-trace", "state-readback"] },
    ];
    const runtime = testRuntime(decisions);
    const app = createApiServer(); closeTasks.push(() => app.close());
    await registerIndustrialAgentRoutes(app, { store: testStore(), runtime });

    const started = await app.inject({ method: "POST", url: "/api/projects/project-1/ai/agent-runs",
      payload: { objective: "自主控制泵", allowedToolIds: ["industrial.control"], executionMode: "autonomous", execution: "background" } });
    expect(started.statusCode).toBe(202);
    const checkpoint = started.json();
    expect(checkpoint.autonomy).toEqual({ mode: "autonomous" });
    await vi.waitFor(async () => {
      const view = await app.inject({ method: "GET", url: `/api/projects/project-1/ai/agent-runs/${checkpoint.id}` });
      expect(view.json()).toMatchObject({ status: "completed" });
    });
    // 自主执行不逐条等人审批；审批以策略身份随调用进入执行链（审计留痕）。
    const persisted = await runtime.checkpoints.get(checkpoint.id);
    expect(runtime.tools.execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      approval: expect.objectContaining({ approvedBy: "autonomy-policy", scopeFingerprint: persisted?.toolRecords[0]?.fingerprint }),
    }));
    expect(persisted?.toolRecords[0]?.approval).toMatchObject({ approvedBy: "autonomy-policy" });
  });

  it("discovers registered capabilities by authorization and clamps the deny list", async () => {
    const draftTool = { id: "modeling.parametric.draft", label: "参数化草案", description: "注册环外能力", effect: "write" as const, risk: "high" as const, requiresApproval: true };
    const decisions: AgentDecision[] = [
      { kind: "call-tool", rationale: "草案", call: { toolId: "modeling.parametric.draft", arguments: { target: "line", enabled: true }, resources: [{ kind: "project", id: "project-1", projectId: "project-1" }] } },
      { kind: "stop", rationale: "收尾", code: "done", message: "草案已产出" },
    ];
    const runtime = testRuntime(decisions);
    const originalList = runtime.tools.list.bind(runtime.tools);
    runtime.tools.list = ((mode?: "curated" | "general") => mode === "general" ? [...originalList(), draftTool] : originalList()) as typeof runtime.tools.list;
    const app = createApiServer(); closeTasks.push(() => app.close());
    await registerIndustrialAgentRoutes(app, {
      store: {
        getProject: () => ({ id: "project-1" } as never),
        getAgentSettings: () => ({ mode: "confirm", generalDevelopment: true, generalDevelopmentDeniedToolIds: ["industrial.control"] }) as never,
        saveAgentSettings: async (settings: unknown) => settings,
      },
      runtime,
    });

    const catalog = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/agent-tools?discovery=general" });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({ discovery: "general", generalAvailable: true });
    expect(catalog.json().tools.map((tool: { id: string }) => tool.id)).toContain("modeling.parametric.draft");

    // 拒绝清单优先于注册表可见性：industrial.control 被显式排除后启动归一拒绝（fail-closed 400）。
    const deniedStart = await app.inject({ method: "POST", url: "/api/projects/project-1/ai/agent-runs",
      payload: { objective: "控制", allowedToolIds: ["industrial.control"], discovery: "general" } });
    expect(deniedStart.statusCode).toBe(400);

    const started = await app.inject({ method: "POST", url: "/api/projects/project-1/ai/agent-runs",
      payload: { objective: "生成草案", allowedToolIds: ["modeling.parametric.draft"], discovery: "general", executionMode: "autonomous", execution: "background" } });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ discovery: "general" });
    await vi.waitFor(async () => {
      const view = await app.inject({ method: "GET", url: `/api/projects/project-1/ai/agent-runs/${started.json().id}` });
      expect(view.json()).toMatchObject({ status: "blocked", failure: { code: "done" } });
    });
    expect(runtime.tools.execute).toHaveBeenCalledTimes(1);
  });
});

function testStore() {
  return {
    getProject: () => ({ id: "project-1" } as never),
    // H-autonomy：设置面依赖（未配置即默认 confirm/curated，行为与历史一致）。
    getAgentSettings: () => undefined,
    saveAgentSettings: async (settings: unknown) => settings,
  };
}

function testRuntime(sequence: AgentDecision[]): IndustrialAgentRuntime {
  const decisions = [...sequence];
  const checkpoints = new MemoryAgentCheckpointStore();
  const execute = vi.fn(async () => ({
    status: "completed" as const,
    output: { verificationStatus: "passed" },
    evidence: [{ id: "command-trace", kind: "trace", label: "控制调用", source: "plc", fingerprint: "command" }],
    verificationEvidence: [{ id: "state-readback", kind: "trace", label: "状态回读", source: "plc", fingerprint: "readback" }],
  }));
  const tools: AgentToolGateway = {
    list: () => [{ id: "industrial.control", label: "设备控制", description: "受控写入", effect: "control", risk: "high", requiresApproval: true }],
    fingerprint: (call: AgentToolCall) => `scope:${call.toolId}:${JSON.stringify(call.arguments)}`,
    execute,
  };
  return {
    checkpoints,
    tools,
    orchestrator: new IndustrialAgentOrchestrator({
      checkpoints,
      tools,
      decisions: { decide: async () => decisions.shift() },
      createId: () => "run-http-1",
    }),
  };
}
