import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pureFixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import type { PublishedSceneRecord, SceneSnapshot } from "@bim-studio/contracts";
import { loadConfig } from "./config.js";
import { registerRoutes } from "./routes.js";
import { createApiServer } from "./serverOptions.js";
import { JsonStore } from "./store.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

describe("published scene cloud-render lifecycle", () => {
  it("stops the previous Worker scope before republish, unpublish or delete", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-cloud-publication-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const beforeDiscardPublication = vi.fn<(publication: PublishedSceneRecord) => Promise<void>>().mockResolvedValue(undefined);
    const app = createApiServer();
    await registerRoutes(app, { store, queue: undefined as never, objects: undefined as never, dataDir, config: loadConfig(), beforeDiscardPublication });
    const scene = structuredClone(pureFixture) as unknown as SceneSnapshot;
    scene.projectId = "default";
    await app.inject({ method: "PUT", url: `/api/projects/default/scenes/${scene.id}`, payload: scene });
    await app.inject({ method: "POST", url: `/api/projects/default/scenes/${scene.id}/publish` });

    expect((await app.inject({ method: "POST", url: `/api/projects/default/scenes/${scene.id}/publish` })).statusCode).toBe(201);
    expect(beforeDiscardPublication).toHaveBeenCalledTimes(1);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/default/scenes/${scene.id}/publish` })).statusCode).toBe(204);
    expect(beforeDiscardPublication).toHaveBeenCalledTimes(2);

    await app.inject({ method: "POST", url: `/api/projects/default/scenes/${scene.id}/publish` });
    expect((await app.inject({ method: "DELETE", url: `/api/projects/default/scenes/${scene.id}` })).statusCode).toBe(204);
    expect(beforeDiscardPublication).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it("blocks publication removal when Worker shutdown cannot be confirmed", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-cloud-publication-failure-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    await registerRoutes(app, {
      store,
      queue: undefined as never,
      objects: undefined as never,
      dataDir,
      config: loadConfig(),
      beforeDiscardPublication: async () => { throw new Error("Worker stop timeout"); }
    });
    const scene = structuredClone(pureFixture) as unknown as SceneSnapshot;
    scene.projectId = "default";
    await app.inject({ method: "PUT", url: `/api/projects/default/scenes/${scene.id}`, payload: scene });
    await app.inject({ method: "POST", url: `/api/projects/default/scenes/${scene.id}/publish` });

    const response = await app.inject({ method: "DELETE", url: `/api/projects/default/scenes/${scene.id}/publish` });
    expect(response.statusCode).toBe(502);
    expect(store.getPublication(scene.id)).toBeDefined();
    await app.close();
  });
});
