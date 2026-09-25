import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { createApiServer } from "./serverOptions.js";
import { registerSceneRoutes } from "./sceneRoutes.js";
import { registerSystemRoutes } from "./system.js";
import { JsonStore } from "./store.js";
import { probeGridBakeDirectoryForTest } from "./probeGridBakeStore.js";

const cleanups: Array<() => Promise<unknown>> = [];
// 反序执行：先 app.close()（等待审计日志等挂起写入），再删临时目录。
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const hashA = "a".repeat(64), hashB = "b".repeat(64);
function bakeDocument(sourceHash = hashA, probeCount = 8) {
  return { sourceHash, probeCount, coveredCount: probeCount, bakedAt: "2026-09-25T00:00:00Z",
    bake: { origin: [0, 0, 0], spacing: 4, gridSize: [2, 2, 2],
      probes: Array.from({ length: probeCount }, () => ({ irradiance: [1, 2, 3], validity: 1, meanDistance: 0, distanceVariance: 0 })) } };
}

async function setup(options: { maxBytes?: number } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "probe-bake-routes-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const store = new JsonStore(dataDir);
  await store.init();
  const app = createApiServer();
  cleanups.push(() => app.close());
  await registerSystemRoutes(app, store, dataDir);
  await registerSceneRoutes(app, { store, probeBakeDataDir: dataDir, ...(options.maxBytes ? { probeBakeMaxBytes: options.maxBytes } : {}) });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin" } });
  expect(login.statusCode).toBe(200);
  const headers = { authorization: `Bearer ${login.json().token}` };
  const scene: SceneSnapshot = { schemaVersion: 1, id: "scene-1", projectId: "project-1", name: "场景",
    objects: [], layers: [], settings: {}, createdAt: "2026-09-25T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z" };
  await app.inject({ method: "PUT", url: "/api/projects/project-1/scenes/scene-1", payload: scene, headers });
  return { app, store, dataDir, headers };
}

describe("probe-bake routes（探针烘焙持久化端点）", () => {
  it("PUT 成功落盘；GET 按 (sceneId, sourceHash) 命中返回同一文档", async () => {
    const f = await setup();
    const put = await f.app.inject({ method: "PUT", url: "/api/scenes/scene-1/probe-bake", headers: f.headers,
      payload: bakeDocument() });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ sourceHash: hashA, bytes: expect.any(Number) });
    const files = await readdir(probeGridBakeDirectoryForTest(f.dataDir, "scene-1"));
    expect(files.filter(name => name.endsWith(".json.gz"))).toEqual([`${hashA}.json.gz`]);
    const get = await f.app.inject({ method: "GET", url: `/api/scenes/scene-1/probe-bake?sourceHash=${hashA}`, headers: f.headers });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual(bakeDocument());
    expect(get.headers["cache-control"]).toContain("immutable");
  });

  it("GET 未命中（不同 hash）返回 404；缺 sourceHash 参数返回 400", async () => {
    const f = await setup();
    await f.app.inject({ method: "PUT", url: "/api/scenes/scene-1/probe-bake", headers: f.headers, payload: bakeDocument() });
    expect((await f.app.inject({ method: "GET", url: `/api/scenes/scene-1/probe-bake?sourceHash=${hashB}`, headers: f.headers })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "GET", url: "/api/scenes/scene-1/probe-bake", headers: f.headers })).statusCode).toBe(400);
  });

  it("同 hash 重复 PUT 幂等（目录仍一份，GET 返回最新内容）", async () => {
    const f = await setup();
    await f.app.inject({ method: "PUT", url: "/api/scenes/scene-1/probe-bake", headers: f.headers, payload: bakeDocument(hashA, 8) });
    await f.app.inject({ method: "PUT", url: "/api/scenes/scene-1/probe-bake", headers: f.headers, payload: bakeDocument(hashA, 27) });
    const files = (await readdir(probeGridBakeDirectoryForTest(f.dataDir, "scene-1"))).filter(name => name.endsWith(".json.gz"));
    expect(files).toEqual([`${hashA}.json.gz`]);
    const get = await f.app.inject({ method: "GET", url: `/api/scenes/scene-1/probe-bake?sourceHash=${hashA}`, headers: f.headers });
    expect(get.json().probeCount).toBe(27);
  });

  it("非法请求：缺 bake/非法 hash 返回 400；场景不存在返回 404", async () => {
    const f = await setup();
    expect((await f.app.inject({ method: "PUT", url: "/api/scenes/scene-1/probe-bake", headers: f.headers,
      payload: { sourceHash: hashA } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "PUT", url: "/api/scenes/scene-1/probe-bake", headers: f.headers,
      payload: { sourceHash: "nothex", bake: {} } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "PUT", url: "/api/scenes/missing/probe-bake", headers: f.headers,
      payload: bakeDocument() })).statusCode).toBe(404);
  });

  it("鉴权与既有场景路由一致：未登录 401；viewer 写入 403、读取放行", async () => {
    const f = await setup();
    await f.app.inject({ method: "PUT", url: "/api/scenes/scene-1/probe-bake", headers: f.headers, payload: bakeDocument() });
    expect((await f.app.inject({ method: "PUT", url: "/api/scenes/scene-1/probe-bake", payload: bakeDocument() })).statusCode).toBe(401);
    await f.app.inject({ method: "POST", url: "/api/admin/users", headers: f.headers,
      payload: { username: "viewer", password: "viewer-password", role: "viewer", projectIds: ["project-1"] } });
    const viewerLogin = await f.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "viewer", password: "viewer-password" } });
    const viewerHeaders = { authorization: `Bearer ${viewerLogin.json().token}` };
    expect((await f.app.inject({ method: "PUT", url: "/api/scenes/scene-1/probe-bake", headers: viewerHeaders,
      payload: bakeDocument(hashB) })).statusCode).toBe(403);
    const get = await f.app.inject({ method: "GET", url: `/api/scenes/scene-1/probe-bake?sourceHash=${hashA}`, headers: viewerHeaders });
    expect(get.statusCode).toBe(200);
  });

  it("解析层 bodyLimit 同步上限：更小上限下超限负载在解析层即被 413 拒绝", async () => {
    const f = await setup({ maxBytes: 4096 });
    const response = await f.app.inject({ method: "PUT", url: "/api/scenes/scene-1/probe-bake", headers: f.headers,
      payload: bakeDocument(hashB, 128) });
    expect(response.statusCode).toBe(413);
  });
});
