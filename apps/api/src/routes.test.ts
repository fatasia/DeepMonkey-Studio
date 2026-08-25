import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import pureFixture from "../../../packages/contracts/src/__fixtures__/scene-v1-pure-3d.json";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { loadConfig } from "./config.js";
import { registerRoutes } from "./routes.js";
import { JsonStore } from "./store.js";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

describe("legacy scene routes", () => {
  it("preserves SceneSnapshot v1 save, publish, public, and browse behavior", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-scene-routes-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const app = Fastify({ routerOptions: { maxParamLength: 256 } });
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

    const oversizedProjectId = "a".repeat(129);
    const invalidProject = await app.inject({ method: "GET", url: `/api/projects/${oversizedProjectId}` });
    expect(invalidProject.statusCode).toBe(400);

    await app.close();
  });
});
