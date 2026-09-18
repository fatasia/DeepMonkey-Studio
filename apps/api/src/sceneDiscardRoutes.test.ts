import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PublishedSceneRecord, SceneSnapshot } from "@bim-studio/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "./serverOptions.js";
import { registerSceneRoutes } from "./sceneRoutes.js";
import { JsonStore } from "./jsonStore.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function setup(stop?: (publication: PublishedSceneRecord) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "bim-scene-discard-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const store = new JsonStore(dir); await store.init();
  const scene: SceneSnapshot = { schemaVersion: 1, id: "scene", projectId: "default", name: "Saved draft",
    models: [], primitives: [], measurements: [], camera: { mode: "orbit", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } },
    createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z", publishedAt: "2026-09-15T01:00:00Z" };
  await store.saveScene(scene);
  const publication = await store.savePublication({ projectId: scene.projectId, sceneId: scene.id, name: scene.name,
    publishedAt: scene.publishedAt!, snapshot: scene });
  const app = createApiServer(); cleanups.push(() => app.close());
  await registerSceneRoutes(app, { store, beforeDiscardPublication: stop });
  const state = () => ({ draft: store.getScene(scene.projectId, scene.id), publication: store.getPublication(scene.id), history: store.listScenePublications(scene.id) });
  return { app, store, scene, publication, state };
}
function url(action: "unpublish" | "delete", projectId = "default") {
  return `/api/projects/${projectId}/scenes/scene${action === "unpublish" ? "/publish" : ""}`;
}

describe.each(["unpublish", "delete"] as const)("%s publication preconditions", action => {
  it("stops the captured publication then commits the intended removal", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const { app, store, scene, publication } = await setup(stop);
    expect((await app.inject({ method: "DELETE", url: url(action) })).statusCode).toBe(204);
    expect(stop).toHaveBeenCalledExactlyOnceWith(publication);
    expect(store.getPublication(scene.id)).toBeUndefined();
    expect((await app.inject({ method: "GET", url: `/api/public/scenes/${scene.id}` })).statusCode).toBe(404);
    if (action === "unpublish") {
      const { publishedAt: _, ...draft } = scene;
      expect(store.getScene(scene.projectId, scene.id)).toEqual(draft);
      expect(store.listScenePublications(scene.id)).toEqual([publication]);
    } else {
      expect(store.getScene(scene.projectId, scene.id)).toBeUndefined();
      expect(store.listScenePublications(scene.id)).toEqual([]);
    }
  });

  it.each(["save", "publish", "delete", "unpublish"] as const)("preserves %s that completes while cloud shutdown is pending", async change => {
    const entered = latch(), stopped = latch();
    const { app, store, scene, publication, state } = await setup(async () => { entered.release(); await stopped.promise; });
    const pending = app.inject({ method: "DELETE", url: url(action) }).then(response => response);
    await entered.promise;
    if (change === "save") await store.saveScene({ ...scene, name: "Another window draft" });
    if (change === "publish") await store.savePublication({ ...publication, snapshot: { ...scene, name: "New publication" }, publishedAt: "2026-09-15T02:00:00Z" });
    if (change === "delete") await store.removeScene(scene.projectId, scene.id);
    if (change === "unpublish") await store.removePublication(scene.id);
    const expected = state(); stopped.release();
    expect((await pending).statusCode).toBe(change === "delete" ? 404 : 409);
    expect(state()).toEqual(expected);
  });

  it("keeps metadata when shutdown or storage fails and permits a later retry", async () => {
    const stop = vi.fn().mockRejectedValueOnce(new Error("Worker timeout")).mockResolvedValue(undefined);
    const { app, store, state } = await setup(stop); const expected = state();
    expect((await app.inject({ method: "DELETE", url: url(action) })).statusCode).toBe(502);
    expect(state()).toEqual(expected);
    const persist = vi.spyOn(store, "discardScene").mockRejectedValueOnce(new Error("Storage unavailable"));
    expect((await app.inject({ method: "DELETE", url: url(action) })).statusCode).toBe(500);
    expect(state()).toEqual(expected); persist.mockRestore();
    expect((await app.inject({ method: "DELETE", url: url(action) })).statusCode).toBe(204);
  });

  it("rejects a foreign project before stopping its matching sceneId", async () => {
    const stop = vi.fn(); const { app, state } = await setup(stop); const expected = state();
    expect((await app.inject({ method: "DELETE", url: url(action, "other") })).statusCode).toBe(404);
    expect(stop).not.toHaveBeenCalled(); expect(state()).toEqual(expected);
  });

  it("allows only one of two requests that captured the same draft and publication", async () => {
    const entered = latch(), stopped = latch(); let arrivals = 0;
    const { app } = await setup(async () => { if (++arrivals === 2) entered.release(); await stopped.promise; });
    const pending = Promise.all([1, 2].map(() => app.inject({ method: "DELETE", url: url(action) })));
    await entered.promise; stopped.release();
    expect((await pending).map(response => response.statusCode).sort()).toEqual([204, action === "delete" ? 404 : 409]);
  });
});

it("deletes an unpublished draft without stopping any worker", async () => {
  const stop = vi.fn(); const { app, store, scene } = await setup(stop);
  await store.removePublication(scene.id);
  expect((await app.inject({ method: "DELETE", url: url("delete") })).statusCode).toBe(204);
  expect(stop).not.toHaveBeenCalled(); expect(store.getScene(scene.projectId, scene.id)).toBeUndefined();
});
