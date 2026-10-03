import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditLogRecord, SystemUserRecord } from "@bim-studio/contracts";
import { WorldSessionManager, type WorldSessionLimits } from "@bim-studio/world-runtime";
import { ServerClient, WorldApiError, WorldClient } from "@bim-studio/server-sdk";
import { OperationsService } from "./operations.js";
import { createIndustrialCapabilityHost, registerIndustrialCapabilityRoutes } from "./industrialCapabilities.js";
import { registerMcpCapabilityRoute } from "./mcpCapabilityAdapter.js";
import { createApiServer } from "./serverOptions.js";
import { registerWorldApiRoutes } from "./worldApiRoutes.js";
import { registerSystemRoutes } from "./system.js";
import { JsonStore } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

const SCENE = {
  schemaVersion: 1, id: "scene-api", models: [],
  primitives: [
    { modelId: "crate", name: "crate", kind: "box", visible: true, transform: { position: { x: 0, y: 2, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 0.25, y: 0.25, z: 0.25 } }, physics: { type: "dynamic", mass: 1, friction: 0.6, restitution: 0.2 } },
    { modelId: "ball", name: "ball", kind: "sphere", visible: true, transform: { position: { x: 0.1, y: 3, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 0.2, y: 0.2, z: 0.2 } }, physics: { type: "dynamic", mass: 1, friction: 0.5, restitution: 0.5 } },
  ],
};
const IMPULSE = { physics: [{ type: "apply-impulse", objectId: "ball", impulse: [0.3, 0, 0] }] };

async function build(options: { limits?: Partial<WorldSessionLimits>; failAudit?: boolean; user?: Partial<SystemUserRecord> } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-world-api-"));
  const operations = new OperationsService(directory);
  await operations.init();
  const sessions = new WorldSessionManager(options.limits ? { limits: options.limits } : {});
  const audits: AuditLogRecord[] = [];
  const host = await createIndustrialCapabilityHost(operations, {
    worldSessions: sessions,
    addAuditLog: async (record) => { if (options.failAudit) throw new Error("audit down"); audits.push(record); },
  });
  const app = createApiServer();
  if (options.user) {
    app.addHook("preHandler", async (request) => {
      const asHeader = request.headers["x-test-user"];
      const identity = typeof asHeader === "string" ? { id: asHeader, username: `user-${asHeader}` } : {};
      request.systemUser = { id: "u1", username: "agent", displayName: "A", role: "editor", projectIds: ["project-1"], enabled: true, createdAt: "", updatedAt: "", ...options.user, ...identity } as SystemUserRecord;
    });
  }
  const store = { getProject: (projectId: string) => projectId === "project-1" ? ({ id: "project-1" } as never) : undefined };
  await registerIndustrialCapabilityRoutes(app, { store: store as never, host });
  await registerMcpCapabilityRoute(app, { host, store: store as never });
  await registerWorldApiRoutes(app, { store: store as never, host, sessions });
  cleanups.push(async () => { sessions.dispose(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, sessions, audits };
}

type App = Awaited<ReturnType<typeof build>>["app"];

async function mcp(app: App, tool: string, input: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await app.inject({
    method: "POST", url: "/api/mcp", headers,
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `industrial.world.${tool}`, arguments: { projectId: "project-1", input } } },
  });
  expect(response.statusCode).toBe(200);
  return response.json().result as { isError: boolean; structuredContent: { status: string; output: Record<string, any>; warnings: string[]; evidence: Array<{ fingerprint?: string }> } };
}

const http = (app: App, method: "POST" | "GET" | "DELETE", suffix: string, payload?: unknown) =>
  app.inject({ method, url: `/api/projects/project-1/worlds${suffix}`, ...(payload !== undefined ? { payload: payload as never } : {}) });

describe("World API · MCP", () => {
  it("tools/list 暴露 6 个 world 工具；observe/snapshot 只读，step/reset/restore/close 非只读", async () => {
    const { app } = await build();
    const listed = await app.inject({ method: "POST", url: "/api/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const tools = (listed.json().result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>).filter((tool) => tool.name.startsWith("industrial.world."));
    expect(Object.fromEntries(tools.map((tool) => [tool.name.replace("industrial.world.", ""), tool.annotations.readOnlyHint]))).toEqual({
      reset: false, step: false, observe: true, snapshot: true, restore: false, close: false,
    });
  });

  it("reset → step → snapshot → step → restore → step：恢复后继续与不中断逐位一致", async () => {
    const { app } = await build();
    const reset = await mcp(app, "reset", { seed: 7, scene: SCENE });
    const worldId = reset.structuredContent.output.world.worldId as string;
    expect(reset.isError).toBe(false);
    expect(reset.structuredContent.output.observation.tick).toBe(0);

    await mcp(app, "step", { worldId, ticks: 20, action: IMPULSE });
    const snapshot = (await mcp(app, "snapshot", { worldId })).structuredContent.output.snapshot;
    const uninterrupted = await mcp(app, "step", { worldId, dt: 1, action: { events: [{ name: "probe" }] } });
    const restored = await mcp(app, "restore", { worldId, snapshot });
    expect(restored.structuredContent.output.world.tick).toBe(20);
    const resumed = await mcp(app, "step", { worldId, dt: 1, action: { events: [{ name: "probe" }] } });
    expect(resumed.structuredContent.output.observation).toEqual(uninterrupted.structuredContent.output.observation);
    expect(resumed.structuredContent.output.traceHash).toBe(uninterrupted.structuredContent.output.traceHash);
    expect(resumed.structuredContent.evidence[0]?.fingerprint).toBe(uninterrupted.structuredContent.output.observation.stateHash);

    const observed = await mcp(app, "observe", { worldId, channels: ["poses"], sensors: [{ id: "cam", kind: "camera-rgb" }] });
    expect(observed.structuredContent.output.observation.sensors.cam.status).toBe("unsupported");
    expect((await mcp(app, "close", { worldId })).structuredContent.output.closed).toBe(true);
  });

  it("调用方可修正的错误回 blocked（isError）并给出原因：非整倍 dt、未知世界、非法命令", async () => {
    const { app } = await build();
    const worldId = (await mcp(app, "reset", { seed: 1, scene: SCENE })).structuredContent.output.world.worldId as string;
    const badDt = await mcp(app, "step", { worldId, dt: 0.02 });
    expect(badDt.isError).toBe(true);
    expect(badDt.structuredContent.warnings[0]).toMatch(/1\/60/);
    const ghost = await mcp(app, "step", { worldId: "nope", ticks: 1 });
    expect(ghost.structuredContent.warnings[0]).toMatch(/世界不存在/);
    const badCommand = await mcp(app, "step", { worldId, ticks: 1, action: { commands: [{ id: "x", type: "object.set-parent", target: { kind: "object", sceneId: "scene-api", objectId: "crate" }, parentId: "ball" }] } });
    expect(badCommand.structuredContent.warnings[0]).toMatch(/扁平世界/);
    expect((await mcp(app, "reset", { seed: -1, scene: SCENE })).isError).toBe(true);
  });

  it("世界归属隔离：同一服务内，另一用户拿到 worldId 也访问不到；本人仍可继续", async () => {
    const { app } = await build({ user: {} });
    const worldId = (await mcp(app, "reset", { seed: 1, scene: SCENE }, { "x-test-user": "u1" })).structuredContent.output.world.worldId as string;
    const intruder = await mcp(app, "step", { worldId, ticks: 1 }, { "x-test-user": "u2" });
    expect(intruder.isError).toBe(true);
    expect(intruder.structuredContent.warnings[0]).toMatch(/世界不存在/);
    expect((await mcp(app, "step", { worldId, ticks: 1 }, { "x-test-user": "u1" })).isError).toBe(false);
  });
});

describe("World API · HTTP 与 MCP 同源", () => {
  it("HTTP 全周期，且 MCP 创建的世界可由 HTTP 继续 step（同一主体）", async () => {
    const { app } = await build();
    const created = await http(app, "POST", "", { seed: 3, scene: SCENE });
    expect(created.statusCode).toBe(201);
    const worldId = created.json().output.world.worldId as string;

    const stepped = await http(app, "POST", `/${worldId}/step`, { action: IMPULSE, dt: 0.1 });
    expect(stepped.statusCode).toBe(200);
    expect(stepped.json().output.ticksAdvanced).toBe(6);

    const mcpWorld = (await mcp(app, "reset", { seed: 3, scene: SCENE })).structuredContent.output.world.worldId as string;
    const viaHttp = await http(app, "POST", `/${mcpWorld}/step`, { action: IMPULSE, dt: 0.1 });
    expect(viaHttp.json().output.observation.stateHash).toBe(stepped.json().output.observation.stateHash);

    const observed = await http(app, "POST", `/${worldId}/observe`, { channels: ["contacts"] });
    expect(observed.json().output.observation.bodies).toBeUndefined();
    const snapshot = (await http(app, "POST", `/${worldId}/snapshot`, {})).json().output.snapshot;
    const forked = await http(app, "POST", "/restore", { snapshot });
    expect(forked.statusCode).toBe(200);
    expect(forked.json().output.world.tick).toBe(6);

    expect((await http(app, "GET", "")).json().worlds.length).toBe(3);
    expect((await http(app, "DELETE", `/${worldId}`)).statusCode).toBe(200);
    expect((await http(app, "POST", `/${worldId}/step`, { ticks: 1 })).statusCode).toBe(404);
  });

  it("HTTP 状态码：非整倍 dt → 422，项目不存在 → 404，配额 → 429", async () => {
    const { app } = await build({ limits: { maxWorlds: 1 } });
    const created = await http(app, "POST", "", { seed: 1, scene: SCENE });
    const worldId = created.json().output.world.worldId as string;
    const bad = await http(app, "POST", `/${worldId}/step`, { dt: 0.02 });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().warnings[0]).toMatch(/正整数倍/);
    expect((await http(app, "POST", "", { seed: 2, scene: SCENE })).statusCode).toBe(429);
    const missing = await app.inject({ method: "POST", url: "/api/projects/ghost/worlds", payload: { seed: 1, scene: SCENE } });
    expect(missing.statusCode).toBe(404);
  });

  it("权限：viewer 只能 observe/snapshot；无项目访问权 → 403", async () => {
    const viewer = await build({ user: { role: "viewer" } });
    expect((await http(viewer.app, "POST", "", { seed: 1, scene: SCENE })).statusCode).toBe(403);
    expect((await http(viewer.app, "POST", "/w1/step", { ticks: 1 })).statusCode).toBe(403);
    expect((await http(viewer.app, "POST", "/w1/observe", {})).statusCode).toBe(404);
    const outsider = await build({ user: { role: "editor", projectIds: ["project-2"] } });
    expect((await http(outsider.app, "POST", "", { seed: 1, scene: SCENE })).statusCode).toBe(403);
  });
});

describe("World API · 审计链", () => {
  it("reset/step/restore/close 逐次写审计；step 审计含 tick 区间、轨迹哈希与动作指纹，不含场景原文", async () => {
    const { app, audits } = await build();
    const worldId = (await mcp(app, "reset", { seed: 5, scene: SCENE })).structuredContent.output.world.worldId as string;
    const step = await mcp(app, "step", { worldId, ticks: 12, action: IMPULSE });
    await mcp(app, "observe", { worldId });
    await mcp(app, "close", { worldId });
    expect(audits.map((record) => record.action)).toEqual(["world.reset", "world.step", "world.close"]);
    const detail = JSON.parse(audits[1]!.detail!) as Record<string, unknown>;
    expect(detail).toMatchObject({ worldId, tickBefore: 0, tickAfter: 12, traceHash: step.structuredContent.output.traceHash, stateHash: step.structuredContent.output.observation.stateHash });
    expect(detail.actionFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(audits)).not.toContain("scene-api");
  });

  it("审计存储故障不推翻 step，但以 warning 如实暴露证据缺口", async () => {
    const { app } = await build({ failAudit: true });
    const worldId = (await mcp(app, "reset", { seed: 5, scene: SCENE })).structuredContent.output.world.worldId as string;
    const step = await mcp(app, "step", { worldId, ticks: 3 });
    expect(step.isError).toBe(false);
    expect(step.structuredContent.warnings.join()).toMatch(/审计未能持久化/);
  });
});

describe("World API · JS/TS SDK 端到端（真实 ServerClient → HTTP 路由）", () => {
  it("SDK 驱动完整闭环，快照回滚后与不中断运行一致；服务端错误给出可操作原因", async () => {
    const { app } = await build();
    const bridge: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const response = await app.inject({ method: (init?.method ?? "GET") as "GET", url: url.pathname, ...(init?.body ? { payload: init.body as string, headers: { "content-type": "application/json" } } : {}) });
      return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
    };
    const server = new ServerClient({
      profile: { baseUrl: "http://studio.test" },
      authStore: { getAccessToken: () => undefined, setAccessToken: () => undefined, clearAccessToken: () => undefined },
      fetch: bridge,
    });
    const worlds = new WorldClient(server, "project-1");
    const world = await worlds.reset({ seed: 21, scene: SCENE as never });
    await world.step({ ticks: 15, action: IMPULSE as never });
    const snapshot = await world.snapshot();
    const uninterrupted = await world.step({ dt: 0.5 });
    await world.restore(snapshot);
    const resumed = await world.step({ dt: 0.5 });
    expect(resumed.observation).toEqual(uninterrupted.observation);
    expect(resumed.traceHash).toBe(uninterrupted.traceHash);
    expect((await worlds.list()).map((item) => item.worldId)).toEqual([world.worldId]);

    expect(await world.close()).toBe(true);
    const error = await world.step({ ticks: 1 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorldApiError);
    expect((error as WorldApiError).message).toMatch(/世界不存在/);
    expect((error as WorldApiError).status).toBe(404);
  });
});
describe("World API · 审查回归（API 层）", () => {
  const invokeGeneric = (app: App, capabilityId: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: "/api/projects/project-1/capabilities/invoke", payload: { capabilityId, input, ...extra } });

  it("#3 同一用户经 MCP（username:id）与通用能力路由（纯 id）创建的世界合并计入配额", async () => {
    const { app } = await build({ user: {}, limits: { maxWorldsPerPrincipal: 3 } });
    await mcp(app, "reset", { seed: 1, scene: SCENE });
    await mcp(app, "reset", { seed: 2, scene: SCENE });
    expect((await invokeGeneric(app, "world.reset", { seed: 3, scene: SCENE })).statusCode).toBe(200);
    const fourth = await mcp(app, "reset", { seed: 4, scene: SCENE });
    expect(fourth.isError).toBe(true);
    expect(fourth.structuredContent.warnings[0]).toMatch(/最多同时持有 3 个世界/);
    const listed = await http(app, "GET", "");
    expect(listed.json().worlds).toHaveLength(3);
  });

  it("#3 经通用路由透传的 dryRun 不会被当成演练真实步进：明确拒绝且世界不变", async () => {
    const { app } = await build({ user: {} });
    const created = await invokeGeneric(app, "world.reset", { seed: 1, scene: SCENE });
    const worldId = created.json().output.world.worldId as string;
    const dry = await invokeGeneric(app, "world.step", { worldId, ticks: 30 }, { dryRun: true });
    expect(dry.statusCode).toBe(422);
    expect(dry.json().warnings[0]).toMatch(/不支持 dryRun/);
    expect((await mcp(app, "observe", { worldId })).structuredContent.output.observation.tick).toBe(0);
  });

  it("#7 审计：restore 记录快照来源（是否本服务签发）、userId/username 与全局钩子对齐、close 未命中不落审计", async () => {
    const { app, audits } = await build({ user: {} });
    const worldId = (await mcp(app, "reset", { seed: 5, scene: SCENE })).structuredContent.output.world.worldId as string;
    await mcp(app, "step", { worldId, ticks: 6 });
    const snapshot = (await mcp(app, "snapshot", { worldId })).structuredContent.output.snapshot;
    await mcp(app, "restore", { worldId, snapshot });
    await mcp(app, "close", { worldId: "someone-elses-or-missing" });
    const restoreAudit = JSON.parse(audits.find((record) => record.action === "world.restore")!.detail!) as Record<string, unknown>;
    expect(restoreAudit).toMatchObject({ snapshotHash: snapshot.snapshotHash, snapshotTraceHash: snapshot.traceHash, snapshotSeed: 5, sceneHash: snapshot.sceneHash, issuedByServer: true });
    expect(audits.find((record) => record.action === "world.reset")).toMatchObject({ username: "agent", userId: "u1" });
    expect(audits.some((record) => record.action === "world.close")).toBe(false);
    const forged = { ...snapshot, snapshotHash: "0".repeat(64) };
    expect((await mcp(app, "restore", { snapshot: forged })).isError).toBe(true);
  });

  it("#6 真实鉴权钩子下：viewer 可经 HTTP observe/snapshot/列表，写操作仍被拒绝", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-world-real-auth-"));
    const operations = new OperationsService(directory);
    await operations.init();
    const store = new JsonStore(directory);
    await store.init();
    const sessions = new WorldSessionManager();
    const host = await createIndustrialCapabilityHost(operations, { worldSessions: sessions });
    const app = createApiServer();
    cleanups.push(async () => { sessions.dispose(); await app.close(); await rm(directory, { recursive: true, force: true }); });
    await registerSystemRoutes(app, store, directory);
    await registerWorldApiRoutes(app, { store, host, sessions });
    const project = await store.createProject("world-auth");
    const login = async (username: string, password: string) =>
      ({ authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } })).json().token}` });
    const admin = await login("admin", "admin");
    await app.inject({ method: "POST", url: "/api/admin/users", headers: admin, payload: { username: "viewer1", password: "viewer-password", role: "viewer", projectIds: [project.id] } });
    const viewer = await login("viewer1", "viewer-password");
    const base = `/api/projects/${project.id}/worlds`;

    const created = await app.inject({ method: "POST", url: base, headers: admin, payload: { seed: 1, scene: SCENE } });
    expect(created.statusCode).toBe(201);
    const worldId = created.json().output.world.worldId as string;
    // 世界归属是创建者：viewer 即使被放行也看不到别人的世界（与不存在一视同仁，404），而不是 403 钩子拦截。
    expect((await app.inject({ method: "POST", url: `${base}/${worldId}/observe`, headers: viewer, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `${base}/${worldId}/snapshot`, headers: viewer, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: base, headers: viewer })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `${base}/${worldId}/step`, headers: viewer, payload: { ticks: 1 } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: base, headers: viewer, payload: { seed: 1, scene: SCENE } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `${base}/${worldId}/observe`, headers: admin, payload: {} })).statusCode).toBe(200);
  });
});