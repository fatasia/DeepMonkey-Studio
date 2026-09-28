import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../serverOptions.js";
import { registerAgentMemoryRoutes } from "./agentMemoryRoutes.js";
import { AgentMemoryStore } from "./agentMemory.js";
import { AiReliabilityAuditBuffer } from "./aiReliabilityAudit.js";

const closeTasks: Array<() => Promise<void>> = [];
const dataDirs: string[] = [];
afterEach(async () => {
  await Promise.all(closeTasks.splice(0).map((task) => task()));
  await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function memoryRoutes(user: { id: string; role: string } = { id: "chief", role: "editor" }) {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-memory-routes-"));
  dataDirs.push(dir);
  const memory = new AgentMemoryStore(dir);
  await memory.init();
  const audit = new AiReliabilityAuditBuffer();
  const app = createApiServer();
  closeTasks.push(() => app.close());
  app.addHook("preHandler", async (request) => { request.systemUser = user as never; });
  await registerAgentMemoryRoutes(app, {
    store: { getProject: (projectId: string) => projectId === "project-1" ? ({ id: "project-1" } as never) : undefined },
    memory,
    audit: audit.sink,
  });
  return { memory, audit, app };
}

describe("H-C2 记忆面板路由（用户可感知载体：列表/确认/启停/编辑/删除）", () => {
  it("列表返回守则状态与全部记忆条目（含 pending）；未配置时 rules.configured=false", async () => {
    const { memory, app } = await memoryRoutes();
    const empty = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/memory" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ rules: { configured: false }, memories: [] });
    await memory.addMemoryCandidate("project-1", { content: "候选记忆", runId: "run-1", step: 2 });
    const listed = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/memory" });
    const body = listed.json() as { memories: Array<{ status: string; content: string; origin: { runId?: string } }> };
    expect(body.memories).toHaveLength(1);
    expect(body.memories[0]).toMatchObject({ status: "pending", content: "候选记忆", origin: { runId: "run-1" } });
  });

  it("确认后条目 active；再次确认幂等；确认写入 memory-action 审计", async () => {
    const { memory, audit, app } = await memoryRoutes();
    const record = await memory.addMemoryCandidate("project-1", { content: "候选" });
    const confirmed = await app.inject({ method: "POST", url: `/api/projects/project-1/ai/memory/${record.id}/confirm`, payload: {} });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: "active", confirmedBy: "chief" });
    const again = await app.inject({ method: "POST", url: `/api/projects/project-1/ai/memory/${record.id}/confirm`, payload: {} });
    expect(again.statusCode).toBe(200);
    // 幂等确认不报错，但每次路由调用都落审计（操作面可完整追溯）。
    const actions = audit.list().filter((event) => event.stage === "memory-action");
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ principal: "chief", projectId: "project-1", outcome: "completed" });
    expect(actions[0]?.findings[0]).toMatchObject({ code: "memory:confirm", sourceId: record.id });
  });

  it("启停切换 active/disabled，编辑更新内容；disable/enable/edit 各落审计", async () => {
    const { memory, audit, app } = await memoryRoutes();
    const record = await memory.addMemoryCandidate("project-1", { content: "原始" });
    await memory.confirmMemory("project-1", record.id, "chief");
    const disabled = await app.inject({ method: "PATCH", url: `/api/projects/project-1/ai/memory/${record.id}`, payload: { enabled: false } });
    expect(disabled.json()).toMatchObject({ status: "disabled" });
    const enabled = await app.inject({ method: "PATCH", url: `/api/projects/project-1/ai/memory/${record.id}`, payload: { enabled: true } });
    expect(enabled.json()).toMatchObject({ status: "active" });
    const edited = await app.inject({ method: "PATCH", url: `/api/projects/project-1/ai/memory/${record.id}`, payload: { content: "更新后的记忆" } });
    expect(edited.json()).toMatchObject({ status: "active", content: "更新后的记忆" });
    const codes = audit.list().filter((event) => event.stage === "memory-action").map((event) => event.findings[0]?.code);
    expect(codes).toEqual(["memory:disable", "memory:enable", "memory:edit"]);
    expect((await memory.loadDelivery("project-1")).memories[0]?.content).toBe("更新后的记忆");
  });

  it("删除移除条目并落审计；删除不存在条目 404", async () => {
    const { memory, audit, app } = await memoryRoutes();
    const record = await memory.addMemoryCandidate("project-1", { content: "待删" });
    const removed = await app.inject({ method: "DELETE", url: `/api/projects/project-1/ai/memory/${record.id}` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ deleted: record.id });
    expect(await memory.listMemories("project-1")).toHaveLength(0);
    const missing = await app.inject({ method: "DELETE", url: `/api/projects/project-1/ai/memory/${record.id}` });
    expect(missing.statusCode).toBe(404);
    const actions = audit.list().filter((event) => event.stage === "memory-action" && event.findings[0]?.code === "memory:delete");
    expect(actions).toHaveLength(1);
  });

  it("浏览者只读：确认/修改/删除一律 403", async () => {
    const { memory, app } = await memoryRoutes({ id: "watcher", role: "viewer" });
    const record = await memory.addMemoryCandidate("project-1", { content: "候选" });
    expect((await app.inject({ method: "POST", url: `/api/projects/project-1/ai/memory/${record.id}/confirm`, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `/api/projects/project-1/ai/memory/${record.id}`, payload: { enabled: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/project-1/ai/memory/${record.id}` })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/projects/project-1/ai/memory" })).statusCode).toBe(200);
  });

  it("越界操作经路由透出 409：候选未确认直接启用（AgentMemoryLimitError）", async () => {
    const { memory, app } = await memoryRoutes();
    const record = await memory.addMemoryCandidate("project-1", { content: "未确认候选" });
    const response = await app.inject({ method: "PATCH", url: `/api/projects/project-1/ai/memory/${record.id}`, payload: { enabled: true } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "agent-memory-limit" });
  });

  it("不存在的项目 404；空 PATCH 400", async () => {
    const { memory, app } = await memoryRoutes();
    const record = await memory.addMemoryCandidate("project-1", { content: "候选" });
    expect((await app.inject({ method: "GET", url: "/api/projects/project-x/ai/memory" })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/api/projects/project-1/ai/memory/${record.id}`, payload: {} })).statusCode).toBe(400);
  });

  it("RULES.md 面板摘要：configured + 字符数 + 截断标记（只读，不提供写路由）", async () => {
    const { memory, app } = await memoryRoutes();
    const rulesPath = memory.rulesPath("project-1");
    await mkdir(path.dirname(rulesPath), { recursive: true });
    await writeFile(rulesPath, "# 守则\n- 只做只读分析", "utf8");
    const listed = await app.inject({ method: "GET", url: "/api/projects/project-1/ai/memory" });
    const body = listed.json() as { rules: { configured: boolean; chars: number; excerpt?: string } };
    expect(body.rules.configured).toBe(true);
    expect(body.rules.chars).toBeGreaterThan(0);
    expect(body.rules.excerpt).toContain("只做只读分析");
  });
});
