import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SystemUserRecord } from "@bim-studio/contracts";
import { JsonStore } from "./store.js";
import { loadConfig } from "./config.js";
import { registerRoutes } from "./routes.js";
import { createApiServer } from "./serverOptions.js";

describe("填报目标配置权限与持久化", () => {
  it("仅管理员可配置；普通编辑不能借连接/数据集更新绕过；省略配置保留原值", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-writeback-config-"));
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    let role: SystemUserRecord["role"] = "admin";
    app.addHook("preHandler", async request => { request.systemUser = { id: "u", username: "tester", displayName: "tester", role, enabled: true, projectIds: ["default"], createdAt: "now", updatedAt: "now" }; });
    try {
      await registerRoutes(app, { store, dataDir, config: loadConfig(), objects: undefined as never, queue: undefined as never });
      const connection = { id: "http", name: "REST", type: "http", config: { url: "https://example.test/records" } };
      expect((await app.inject({ method: "POST", url: "/api/projects/default/data-connections", payload: connection })).statusCode).toBe(201);
      const writeback = { version: 1, recordPath: "/records/{id}", fields: [{ key: "output", type: "number", min: 0 }] };
      const dataset = { id: "rows", name: "Records", connectionId: "http", fields: [] };
      const save = (payload: unknown) => app.inject({ method: "POST", url: "/api/projects/default/datasets", payload: payload as Record<string, unknown> });
      role = "editor";
      expect((await save({ ...dataset, writeback })).statusCode).toBe(403);
      role = "admin";
      expect((await save({ ...dataset, writeback: { ...writeback, recordPath: "//other/{id}" } })).statusCode).toBe(400);
      expect((await save({ ...dataset, writeback })).statusCode).toBe(201);
      const fresh = new JsonStore(dataDir);
      await fresh.init();
      expect(fresh.listDatasets("default").find(item => item.id === "rows")?.writeback).toEqual(writeback);
      role = "editor";
      expect((await save({ ...dataset, name: "Renamed" })).json().writeback).toEqual(writeback);
      expect((await save({ ...dataset, connectionId: "other" })).statusCode).toBe(403);
      expect((await save({ ...dataset, writeback: null })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/projects/default/data-connections", payload: { ...connection, config: { url: "https://other.test" } } })).statusCode).toBe(403);
      role = "admin";
      expect((await save({ ...dataset, writeback: null })).json().writeback).toBeUndefined();
    } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
  });
});
