import { describe, expect, it } from "vitest";
import type { DataConnectionRecord, DataDatasetRecord, SystemUserRecord } from "@bim-studio/contracts";
import { createApiServer } from "./serverOptions.js";
import { loadConfig } from "./config.js";
import { registerDataWritebackRoutes } from "./dataWritebackRoutes.js";
import type { MetadataStore } from "./store.js";

const connection: DataConnectionRecord = { id: "http", projectId: "p", name: "REST", type: "http", enabled: true, config: { url: "http://127.0.0.1:12345/list" }, createdAt: "now", updatedAt: "now" };
const dataset: DataDatasetRecord = { id: "rows", projectId: "p", connectionId: "http", name: "records", fields: [], refreshSeconds: 0, createdAt: "now", updatedAt: "now", writeback: { version: 1, recordPath: "/records/{id}", fields: [{ key: "output", type: "number", required: true }] } };

describe("填报路由授权与错误语义", () => {
  it("缺失身份/只读/跨项目逐层拒绝，不依赖界面禁用", async () => {
    const app = createApiServer();
    let user: SystemUserRecord | undefined;
    app.addHook("preHandler", async request => { if (user) request.systemUser = user; });
    const store = { listDatasets: () => [dataset], listDataConnections: () => [connection] } as unknown as MetadataStore;
    await registerDataWritebackRoutes(app, store, loadConfig());
    const url = "/api/projects/p/datasets/rows/records/one";
    try {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      user = { id: "u", username: "read-only", displayName: "Viewer", role: "viewer", enabled: true, projectIds: ["p"], createdAt: "now", updatedAt: "now" };
      expect((await app.inject({ method: "PATCH", url, payload: {} })).statusCode).toBe(403);
      user = { ...user, role: "editor", projectIds: ["other"] };
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(403);
      user = { ...user, projectIds: ["p"] };
      const invalid = await app.inject({ method: "PATCH", url, payload: { expectedVersion: '"v1"', values: { output: "bad" } } });
      expect(invalid.statusCode).toBe(422);
      expect(invalid.json()).toMatchObject({ code: "validation-error", outcome: "not-written", retryable: false, issues: [{ field: "output" }] });
      expect((await app.inject({ method: "GET", url: url.replace("rows", "missing") })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
