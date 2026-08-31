import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { createApiServer } from "./serverOptions.js";
import { registerSceneRoutes } from "./sceneRoutes.js";
import { JsonStore } from "./store.js";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

describe("scene publication notification", () => {
  it("records a publish first and does not fail it when notification dispatch fails", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-notification-scene-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const afterPublish = vi.fn().mockRejectedValue(new Error("outbound unavailable"));
    const app = createApiServer();
    await registerSceneRoutes(app, { store, afterPublish });
    const scene: SceneSnapshot = {
      id: "scene-1", projectId: "project-1", name: "装配线", schemaVersion: 1,
      createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z",
      objects: [], layers: [], settings: {},
    };
    await app.inject({ method: "PUT", url: "/api/projects/project-1/scenes/scene-1", payload: scene });

    const response = await app.inject({ method: "POST", url: "/api/projects/project-1/scenes/scene-1/publish" });

    expect(response.statusCode).toBe(201);
    expect(afterPublish).toHaveBeenCalledWith(expect.objectContaining({ sceneId: "scene-1" }));
    await app.close();
  });

  it("serves an anonymous browse payload without exposing project integrations", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-public-scene-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const project = await store.createProject("工厂");
    const app = createApiServer();
    await registerSceneRoutes(app, { store });
    const scene: SceneSnapshot = {
      id: "scene-public", projectId: project.id, name: "公开工作站", schemaVersion: 1,
      camera: { position: { x: 2, y: 2, z: 2 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
      models: [], primitives: [], measurements: [], objects: [], layers: [], settings: {},
      createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z",
    };
    await store.saveScene(scene);
    await store.savePublication({ sceneId: scene.id, projectId: project.id, name: scene.name, snapshot: scene, publishedAt: scene.updatedAt });

    const response = await app.inject({ method: "GET", url: `/api/public/scenes/${scene.id}/browse` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ publication: { sceneId: scene.id }, project: { id: project.id, models: [] } });
    expect(response.json().project.dataConnections).toBeUndefined();
    await app.close();
  });
});
