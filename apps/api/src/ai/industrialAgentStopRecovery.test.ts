import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndustrialAgentOrchestrator, type AgentCheckpoint, type AgentToolGateway } from "@bim-studio/industrial-agent-orchestrator";
import { createApiServer } from "../serverOptions.js";
import { IndustrialAgentCheckpointStore } from "./industrialAgentCheckpointStore.js";
import { registerIndustrialAgentRoutes } from "./industrialAgentRoutes.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const task of cleanup.splice(0).reverse()) await task(); });

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-stop-recovery-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new IndustrialAgentCheckpointStore(directory);
  await store.init();
  const tools: AgentToolGateway = { list: () => [{ id: "data.read", label: "读取", description: "读取记录", effect: "read", risk: "low", requiresApproval: false }], fingerprint: () => "unused", execute: vi.fn() };
  const decisions = { decide: vi.fn(async () => ({ kind: "request-input", rationale: "选择数据", question: "选择产线", options: [{ id: "a", label: "产线A" }, { id: "b", label: "产线B" }] })) };
  async function server(checkpoints: IndustrialAgentCheckpointStore) {
    const orchestrator = new IndustrialAgentOrchestrator({ checkpoints, tools, decisions, createId: () => "run-stop" });
    const app = createApiServer();
    cleanup.push(() => app.close());
    app.addHook("preHandler", async request => { request.systemUser = { id: "operator", role: request.headers["x-test-role"] === "viewer" ? "viewer" : "editor" } as never; });
    await registerIndustrialAgentRoutes(app, { store: { getProject: () => ({ id: "p" } as never) }, runtime: { checkpoints, tools, orchestrator } });
    return { app, orchestrator };
  }
  return { directory, store, server, decisions, tools };
}

describe("durable Agent stop and recovery", () => {
  it("coalesces concurrent stops, rejects late saves, and preserves cancellation after restart", async () => {
    const f = await fixture();
    const first = await f.server(f.store);
    const created = await first.app.inject({ method: "POST", url: "/api/projects/p/ai/agent-runs", payload: { objective: "选择产线" } });
    expect(created.statusCode).toBe(201);
    const waiting = created.json<AgentCheckpoint>();
    expect(waiting.status).toBe("awaiting-input");
    const cancel = vi.spyOn(first.orchestrator, "cancel");
    const url = `/api/projects/p/ai/agent-runs/${waiting.id}`;
    const stopped = await Promise.all(Array.from({ length: 8 }, () => first.app.inject({ method: "DELETE", url })));
    expect(stopped.every((response) => response.statusCode === 200)).toBe(true);
    const cancelled = stopped[0]!.json<AgentCheckpoint>();
    for (const response of stopped) expect(response.json()).toEqual(cancelled);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancelled).toMatchObject({ status: "cancelled", revision: waiting.revision + 1 });
    expect(cancelled.pendingSelection).toBeUndefined();
    await expect(f.store.save({ ...waiting, revision: cancelled.revision, status: "running" })).rejects.toMatchObject({ code: "checkpoint-conflict" });
    await expect(f.store.save({ ...waiting, revision: cancelled.revision + 1, status: "completed" })).rejects.toMatchObject({ code: "checkpoint-conflict" });
    await f.store.save(cancelled); // Exact retry is a no-op.

    const restored = new IndustrialAgentCheckpointStore(f.directory);
    await restored.init();
    const second = await f.server(restored);
    expect((await second.app.inject({ method: "GET", url })).json()).toEqual(cancelled);
    expect((await second.app.inject({ method: "DELETE", url })).json()).toEqual(cancelled);
    expect((await second.app.inject({ method: "DELETE", url: url.replace("/p/", "/other/") })).statusCode).toBe(404);
    expect((await second.app.inject({ method: "DELETE", url, headers: { "x-test-role": "viewer" } })).statusCode).toBe(403);
    expect(await restored.get(waiting.id)).toEqual(cancelled);
    expect(f.decisions.decide).toHaveBeenCalledTimes(1);
    expect(f.tools.execute).not.toHaveBeenCalled();
  });

  it("rejects a queued stale revision without losing the newest durable checkpoint", async () => {
    const f = await fixture();
    const server = await f.server(f.store);
    const started = await server.orchestrator.start({ projectId: "p", principal: "operator", objective: "选择", allowedToolIds: ["data.read"] });
    const newest = { ...started, revision: started.revision + 1, objective: "最新目标" };
    const results = await Promise.allSettled([f.store.save(newest), f.store.save({ ...started, objective: "迟到目标" })]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    const restored = new IndustrialAgentCheckpointStore(f.directory);
    await restored.init();
    expect(await restored.get(started.id)).toEqual(newest);
  });

  it("allows a new stop attempt after persistence fails without exposing an uncommitted cancellation", async () => {
    const f = await fixture();
    const server = await f.server(f.store);
    const started = await server.orchestrator.start({ projectId: "p", principal: "operator", objective: "选择", allowedToolIds: ["data.read"] });
    const save = vi.spyOn(f.store, "save").mockRejectedValueOnce(new Error("disk unavailable"));
    const url = `/api/projects/p/ai/agent-runs/${started.id}`;
    expect((await server.app.inject({ method: "DELETE", url })).statusCode).toBe(500);
    expect(await f.store.get(started.id)).toEqual(started);
    save.mockRestore();
    expect((await server.app.inject({ method: "DELETE", url })).json()).toMatchObject({ status: "cancelled", revision: started.revision + 1 });
  });
});
