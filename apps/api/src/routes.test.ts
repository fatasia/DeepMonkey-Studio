import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import pureFixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { loadConfig } from "./config.js";
import { registerRoutes } from "./routes.js";
import { JsonStore } from "./store.js";
import { createApiServer } from "./serverOptions.js";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

describe("legacy scene routes", () => {
  it("preserves SceneSnapshot v1 save, publish, public, and browse behavior", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-scene-routes-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    await registerRoutes(app, {
      store,
      queue: undefined as never,
      objects: undefined as never,
      dataDir,
      config: loadConfig()
    });
    const scene = structuredClone(pureFixture) as unknown as SceneSnapshot;
    scene.projectId = "default";

    const save = await app.inject({
      method: "PUT",
      url: "/api/projects/default/scenes/scene-pure-3d",
      payload: scene
    });
    const publication = await app.inject({
      method: "POST",
      url: "/api/projects/default/scenes/scene-pure-3d/publish"
    });

    expect(save.statusCode).toBe(200);
    expect(save.json().schemaVersion).toBe(1);
    expect(publication.statusCode).toBe(201);
    expect(publication.json().snapshot.schemaVersion).toBe(1);
    expect((await app.inject({ method: "GET", url: "/api/public/scenes/scene-pure-3d" })).json().snapshot.name).toBe("纯三维");
    expect((await app.inject({ method: "GET", url: "/api/scenes/scene-pure-3d/browse" })).json().scene.schemaVersion).toBe(1);

    for (const length of [100, 101, 128]) {
      expect((await app.inject({ method: "GET", url: `/api/projects/${"a".repeat(length)}` })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: "GET", url: `/api/projects/${"a".repeat(129)}` })).statusCode).toBe(400);

    await app.close();
  });

  it("rejects unsafe dataset formulas before persistence", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-data-routes-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    await registerRoutes(app, {
      store,
      queue: undefined as never,
      objects: undefined as never,
      dataDir,
      config: loadConfig()
    });
    await app.inject({
      method: "POST",
      url: "/api/projects/default/data-connections",
      payload: { id: "connection-1", name: "测试接口", type: "http", config: { url: "http://localhost/test" } }
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/projects/default/datasets",
      payload: { name: "告警指标", connectionId: "connection-1", computedFields: [{ id: "field-1", key: "risk", label: "风险", type: "number", formula: "process.exit()" }] }
    });
    const valid = await app.inject({
      method: "POST",
      url: "/api/projects/default/datasets",
      payload: { name: "温度指标", connectionId: "connection-1", computedFields: [{ id: "field-2", key: "fahrenheit", label: "华氏温度", type: "number", formula: "ROUND(temperature * 1.8 + 32, 1)" }] }
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().message).toContain("位置");
    expect(valid.statusCode).toBe(201);
    expect(valid.json().computedFields[0].formula).toBe("ROUND(temperature * 1.8 + 32, 1)");

    await app.close();
  });
});
