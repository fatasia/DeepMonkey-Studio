import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import pureFixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import { loadConfig } from "./config.js";
import { registerRoutes } from "./routes.js";
import { JsonStore } from "./store.js";
import { createApiServer } from "./serverOptions.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true }))));

describe("scene simulation entities persistence", () => {
  it("roundtrips simulation entities through scene save and load", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-sim-persist-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    await registerRoutes(app, { store, queue: undefined as never, objects: undefined as never, dataDir, config: loadConfig() });

    const scene = structuredClone(pureFixture) as unknown as SceneSnapshot;
    scene.projectId = "default";
    scene.simulationEntities = [
      { id: "f1", kind: "flowLink", fromModelId: "model-a", toModelId: "model-b" },
      { id: "p1", kind: "path", name: "巡检路径", targetModelId: "model-a", points: [[0, 0, 0], [10, 0, 0]], loopMode: "loop", speed: 2 },
      { id: "c1", kind: "collisionPair", name: "夹爪碰撞", a: { modelId: "model-a", layerId: "jaw" }, b: { modelId: "model-b" }, tolerance: 0.02 },
    ];

    const save = await app.inject({ method: "PUT", url: "/api/projects/default/scenes/scene-pure-3d", payload: scene });
    expect(save.statusCode).toBe(200);
    const loaded = await app.inject({ method: "GET", url: "/api/projects/default/scenes/scene-pure-3d" });
    expect(loaded.statusCode).toBe(200);
    const snapshot = loaded.json() as SceneSnapshot;
    expect(snapshot.simulationEntities).toHaveLength(3);
    expect(snapshot.simulationEntities?.[0]).toMatchObject({ kind: "flowLink", fromModelId: "model-a", toModelId: "model-b" });
    expect(snapshot.simulationEntities?.[1]).toMatchObject({ kind: "path", loopMode: "loop", speed: 2 });

    // 删除字段后保存（旧行为兼容）：字段回空
    delete scene.simulationEntities;
    const save2 = await app.inject({ method: "PUT", url: "/api/projects/default/scenes/scene-pure-3d", payload: scene });
    expect(save2.statusCode).toBe(200);
    const loaded2 = await app.inject({ method: "GET", url: "/api/projects/default/scenes/scene-pure-3d" });
    expect(loaded2.json().simulationEntities).toBeUndefined();
  });
});
