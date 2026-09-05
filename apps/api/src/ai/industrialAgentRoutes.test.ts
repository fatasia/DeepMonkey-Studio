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
  it("resumes a failed decision over HTTP in the same durable run", async () => {
    const runtime = testRuntime([]);
    let attempts = 0;
    runtime.orchestrator = new IndustrialAgentOrchestrator({ checkpoints: runtime.checkpoints, tools: runtime.tools, decisions: { decide: async () => {
      if (++attempts === 1) throw new AgentDecisionUnavailableError("HTTP 504");
      return { kind: "finish", rationale: "已恢复", summary: "等待真实采样", decisionStatus: "insufficient-data", evidenceIds: [] };
    } } });
    const app = createApiServer(); closeTasks.push(() => app.close());
    await registerIndustrialAgentRoutes(app, { store: { getProject: () => ({ id: "project-1" } as never) }, runtime });
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
    await registerIndustrialAgentRoutes(app, { store: { getProject: () => ({ id: "project-1" } as never) }, runtime });
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
    await registerIndustrialAgentRoutes(app, { store: { getProject: () => ({ id: "project-1" } as never) }, runtime });
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
    await registerIndustrialAgentRoutes(app, { store: { getProject: () => ({ id: "project-1" } as never) }, runtime });
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
    await registerIndustrialAgentRoutes(app, { store: { getProject: (id) => id === "project-1" ? ({ id } as never) : undefined }, runtime });
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
