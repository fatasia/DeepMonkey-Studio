import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SemanticModelRecord } from "@bim-studio/contracts";
import { loadConfig } from "./config.js";
import { registerRoutes } from "./routes.js";
import { JsonStore } from "./store.js";
import { createApiServer } from "./serverOptions.js";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

const validModel = {
  name: "设备运行口径",
  source: { kind: "dataset" as const, id: "example-postgresql-metrics" },
  metrics: [
    { id: "m-1", key: "avgTemperature", label: "平均温度", fieldKey: "temperature", aggregation: "avg" as const },
    { id: "m-2", key: "deviceCount", label: "设备数", aggregation: "countDistinct" as const, fieldKey: "device_id" },
  ],
  dimensions: [{ id: "d-1", key: "device", label: "设备", fieldKey: "device_id" }],
  parameters: [],
};

async function createApp() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-semantic-routes-"));
  directories.push(dataDir);
  const store = new JsonStore(dataDir);
  await store.init();
  const app = createApiServer();
  await registerRoutes(app, { store, queue: undefined as never, objects: undefined as never, dataDir, config: loadConfig() });
  return app;
}

describe("semantic model routes", () => {
  it("creates, lists, updates with revision increment, and deletes", async () => {
    const app = await createApp();
    const create = await app.inject({ method: "POST", url: "/api/projects/default/semantic-models", payload: validModel });
    expect(create.statusCode).toBe(201);
    const created = create.json() as SemanticModelRecord;
    expect(created.revision).toBe(1);
    expect(created.name).toBe("设备运行口径");

    const list = await app.inject({ method: "GET", url: "/api/projects/default/semantic-models" });
    expect(list.statusCode).toBe(200);
    expect((list.json() as SemanticModelRecord[]).map((item) => item.name)).toContain("设备运行口径");

    const update = await app.inject({
      method: "PUT",
      url: `/api/projects/default/semantic-models/${created.id}`,
      payload: { ...validModel, name: "设备运行口径 v2" },
    });
    expect(update.statusCode).toBe(200);
    expect((update.json() as SemanticModelRecord).revision).toBe(2);
    expect((update.json() as SemanticModelRecord).name).toBe("设备运行口径 v2");

    const remove = await app.inject({ method: "DELETE", url: `/api/projects/default/semantic-models/${created.id}` });
    expect(remove.statusCode).toBe(204);
    const afterDelete = await app.inject({ method: "GET", url: "/api/projects/default/semantic-models" });
    expect(afterDelete.json()).toEqual([]);
  });

  it("rejects duplicate names with 409", async () => {
    const app = await createApp();
    const first = await app.inject({ method: "POST", url: "/api/projects/default/semantic-models", payload: validModel });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url: "/api/projects/default/semantic-models", payload: validModel });
    expect(second.statusCode).toBe(409);
  });

  it("rejects invalid models with 400 and a joined message", async () => {
    const app = await createApp();
    const invalid = await app.inject({
      method: "POST",
      url: "/api/projects/default/semantic-models",
      payload: { ...validModel, metrics: [{ id: "m-1", key: "m", label: "m", fieldKey: "ghost", aggregation: "sum" }] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().message).toContain("不在源字段中");
  });

  it("requires pipeline sources to declare explicit fields", async () => {
    const app = await createApp();
    const pipelineModel = await app.inject({
      method: "POST",
      url: "/api/projects/default/semantic-models",
      payload: { ...validModel, source: { kind: "pipeline", id: "ghost-pipeline" } },
    });
    expect(pipelineModel.statusCode).toBe(400);
  });

  it("blocks dataset deletion with 409 while a semantic model references it", async () => {
    const app = await createApp();
    const create = await app.inject({ method: "POST", url: "/api/projects/default/semantic-models", payload: validModel });
    expect(create.statusCode).toBe(201);
    const blocked = await app.inject({ method: "DELETE", url: "/api/projects/default/datasets/example-postgresql-metrics" });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toContain("语义模型");
    const remove = await app.inject({ method: "DELETE", url: `/api/projects/default/semantic-models/${create.json().id}` });
    expect(remove.statusCode).toBe(204);
    const allowed = await app.inject({ method: "DELETE", url: "/api/projects/default/datasets/example-postgresql-metrics" });
    expect(allowed.statusCode).toBe(204);
  });

  it("returns 404 for missing project and missing model", async () => {
    const app = await createApp();
    expect((await app.inject({ method: "GET", url: "/api/projects/ghost/semantic-models" })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/api/projects/default/semantic-models/ghost", payload: validModel })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/projects/default/semantic-models/ghost" })).statusCode).toBe(404);
  });
});
