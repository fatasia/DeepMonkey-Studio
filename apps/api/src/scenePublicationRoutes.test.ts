import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublishedSceneRecord, SceneSnapshot } from "@bim-studio/contracts";
import { createApiServer } from "./serverOptions.js";
import { registerSceneRoutes } from "./sceneRoutes.js";
import { JsonStore } from "./store.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(beforeDiscardPublication?: (publication: PublishedSceneRecord) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "bim-scene-publish-cas-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const store = new JsonStore(dir);
  await store.init();
  const project = await store.createProject("发布测试");
  const scene: SceneSnapshot = {
    schemaVersion: 1, id: "scene", projectId: project.id, name: "已审计草稿",
    camera: { mode: "orbit", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } },
    models: [], primitives: [], measurements: [], createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z",
  };
  await store.saveScene(scene);
  const afterPublish = vi.fn();
  const app = createApiServer();
  cleanups.push(() => app.close());
  await registerSceneRoutes(app, { store, afterPublish, ...(beforeDiscardPublication ? { beforeDiscardPublication } : {}) });
  const url = `/api/projects/${project.id}/scenes/${scene.id}/publish`;
  const seedPublication = () => store.savePublication({ sceneId: scene.id, projectId: scene.projectId, name: scene.name,
    snapshot: scene, publishedAt: scene.updatedAt });
  return { app, store, scene, url, afterPublish, seedPublication };
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function restoreUrl(scene: SceneSnapshot, publication: PublishedSceneRecord): string {
  return `/api/projects/${scene.projectId}/scenes/${scene.id}/publications/${encodeURIComponent(publication.publishedAt)}/restore`;
}

describe("atomic historical scene restoration routes", () => {
  it("rejects ambiguous publication timestamps before stopping cloud rendering", async () => {
    const stop = vi.fn();
    const { app, store, scene, seedPublication } = await setup(stop);
    const historical = await seedPublication();
    const current = await store.savePublication({ ...historical, name: "同一毫秒的另一版本" });
    expect(current.version).toBe(2);
    const response = await app.inject({ method: "POST", url: restoreUrl(scene, historical) });
    expect(response.statusCode).toBe(409); expect(stop).not.toHaveBeenCalled();
    expect(store.getPublication(scene.id)).toEqual(current);
    expect(store.getScene(scene.projectId, scene.id)).toEqual(scene);
  });

  it("restores the selected version publicly while retaining draft content and time", async () => {
    const { app, store, scene, seedPublication } = await setup();
    const historical = await seedPublication();
    const draft = { ...scene, name: "未发布的下一版", updatedAt: "2026-09-15T02:00:00Z" };
    await store.saveScene(draft);
    const response = await app.inject({ method: "POST", url: restoreUrl(scene, historical) });
    expect(response.statusCode).toBe(201);
    const restored = response.json<PublishedSceneRecord>();
    expect(restored).toMatchObject({ version: 2, snapshot: { name: scene.name } });
    expect(store.getScene(scene.projectId, scene.id)).toMatchObject({ ...draft, publishedAt: restored.publishedAt });
    expect((await app.inject({ method: "GET", url: `/api/public/scenes/${scene.id}` })).json()).toEqual(restored);
    expect(store.listScenePublications(scene.id)).toContainEqual(historical);
  });

  it.each(["draft", "publication", "delete"] as const)("rejects %s changed while stopping cloud rendering", async (change) => {
    const entered = latch(), stopped = latch();
    const { app, store, scene, seedPublication } = await setup(async () => { entered.release(); await stopped.promise; });
    const historical = await seedPublication();
    const pending = app.inject({ method: "POST", url: restoreUrl(scene, historical) }).then(response => response);
    await entered.promise;
    if (change === "draft") await store.saveScene({ ...scene, name: "另一个窗口的新草稿" });
    if (change === "publication") await store.savePublication({ ...historical, publishedAt: "2026-09-15T03:00:00Z", name: "新发布" });
    if (change === "delete") await store.removeScene(scene.projectId, scene.id);
    const draft = store.getScene(scene.projectId, scene.id), publication = store.getPublication(scene.id);
    const history = store.listScenePublications(scene.id);
    stopped.release();
    expect((await pending).statusCode).toBe(change === "delete" ? 404 : 409);
    expect(store.getScene(scene.projectId, scene.id)).toEqual(draft);
    expect(store.getPublication(scene.id)).toEqual(publication);
    expect(store.listScenePublications(scene.id)).toEqual(history);
  });

  it("allows only one of two restorations that stopped the same publication", async () => {
    const entered = latch(), stopped = latch(); let arrivals = 0;
    const { app, store, scene, seedPublication } = await setup(async () => {
      if (++arrivals === 2) entered.release(); await stopped.promise;
    });
    const historical = await seedPublication();
    const responses = Promise.all([1, 2].map(() => app.inject({ method: "POST", url: restoreUrl(scene, historical) })));
    await entered.promise; stopped.release();
    expect((await responses).map(response => response.statusCode).sort()).toEqual([201, 409]);
    expect(store.listScenePublications(scene.id)).toHaveLength(2);
    expect(store.getPublication(scene.id)?.version).toBe(2);
  });

  it("does not mutate metadata when shutdown or persistence fails", async () => {
    const stop = vi.fn().mockRejectedValueOnce(new Error("worker unavailable")).mockResolvedValue(undefined);
    const { app, store, scene, seedPublication } = await setup(stop);
    const historical = await seedPublication();
    const url = restoreUrl(scene, historical);
    expect((await app.inject({ method: "POST", url })).statusCode).toBe(502);
    const fail = vi.spyOn(store, "restoreScenePublication").mockRejectedValueOnce(new Error("storage unavailable"));
    expect((await app.inject({ method: "POST", url })).statusCode).toBe(500);
    expect(store.getScene(scene.projectId, scene.id)).toEqual(scene);
    expect(store.getPublication(scene.id)).toEqual(historical);
    expect(store.listScenePublications(scene.id)).toEqual([historical]);
    fail.mockRestore();
    expect((await app.inject({ method: "POST", url })).statusCode).toBe(201);
  });

  it("rejects missing or foreign historical identity before stopping the current publication", async () => {
    const stop = vi.fn();
    const { app, store, scene, seedPublication } = await setup(stop);
    const historical = await seedPublication();
    for (const url of [restoreUrl(scene, { ...historical, publishedAt: "2000-01-01T00:00:00Z" }),
      restoreUrl({ ...scene, projectId: "foreign" }, historical)]) {
      expect((await app.inject({ method: "POST", url })).statusCode).toBe(404);
    }
    expect(stop).not.toHaveBeenCalled();
    expect(store.getPublication(scene.id)).toEqual(historical);
  });
});

describe("scene publication snapshot preconditions", () => {
  it("publishes the audited saved snapshot and serves the same immutable version publicly", async () => {
    const { app, store, scene, url, afterPublish } = await setup();
    const response = await app.inject({ method: "POST", url, payload: { expectedSnapshot: scene } });
    expect(response.statusCode).toBe(201);
    const publication = response.json<PublishedSceneRecord>();
    expect(publication).toMatchObject({ version: 1, snapshot: { name: scene.name, camera: scene.camera } });
    expect(store.getScene(scene.projectId, scene.id)).toEqual(publication.snapshot);
    await store.saveScene({ ...publication.snapshot, name: "下个草稿" });
    const publicResponse = await app.inject({ method: "GET", url: `/api/public/scenes/${scene.id}` });
    expect(publicResponse.json()).toEqual(publication);
    expect(afterPublish).toHaveBeenCalledOnce();
  });

  it("rejects stale content before stopping the existing cloud publication", async () => {
    const stop = vi.fn();
    const { app, store, scene, url, seedPublication, afterPublish } = await setup(stop);
    const current = await seedPublication();
    await store.saveScene({ ...scene, name: "另一个窗口的改动" });
    const response = await app.inject({ method: "POST", url, payload: { expectedSnapshot: scene } });
    expect(response.statusCode).toBe(409);
    expect(stop).not.toHaveBeenCalled();
    expect(afterPublish).not.toHaveBeenCalled();
    expect(store.getPublication(scene.id)).toEqual(current);
  });

  it("preserves a newer draft saved while the previous cloud session is stopping", async () => {
    const entered = latch(), stopped = latch();
    const { app, store, scene, url, seedPublication, afterPublish } = await setup(async () => { entered.release(); await stopped.promise; });
    const current = await seedPublication();
    const history = store.listScenePublications(scene.id);
    const pending = app.inject({ method: "POST", url, payload: { expectedSnapshot: scene } }).then((response) => response);
    await entered.promise;
    const newer = { ...scene, name: "更新草稿", updatedAt: "2026-09-15T01:00:00Z" };
    await store.saveScene(newer);
    stopped.release();
    expect((await pending).statusCode).toBe(409);
    expect(store.getScene(scene.projectId, scene.id)).toEqual(newer);
    expect(store.getPublication(scene.id)).toEqual(current);
    expect(store.listScenePublications(scene.id)).toEqual(history);
    expect(afterPublish).not.toHaveBeenCalled();
  });

  it("does not replace a publication changed during cloud shutdown", async () => {
    const entered = latch(), stopped = latch();
    const { app, store, scene, url, seedPublication } = await setup(async () => { entered.release(); await stopped.promise; });
    const current = await seedPublication();
    const pending = app.inject({ method: "POST", url, payload: { expectedSnapshot: scene } }).then((response) => response);
    await entered.promise;
    const newer = await store.savePublication({ ...current, name: "另一发布", publishedAt: "2026-09-15T01:00:00Z" });
    stopped.release();
    expect((await pending).statusCode).toBe(409);
    expect(store.getPublication(scene.id)).toEqual(newer);
    expect(store.getScene(scene.projectId, scene.id)).toEqual(scene);
  });

  it("keeps metadata unchanged when cloud shutdown fails", async () => {
    const { app, store, scene, url, seedPublication, afterPublish } = await setup(async () => { throw new Error("worker unavailable"); });
    const current = await seedPublication();
    const response = await app.inject({ method: "POST", url, payload: { expectedSnapshot: scene } });
    expect(response.statusCode).toBe(502);
    expect(store.getPublication(scene.id)).toEqual(current);
    expect(store.getScene(scene.projectId, scene.id)).toEqual(scene);
    expect(afterPublish).not.toHaveBeenCalled();
  });

  it("rejects malformed explicit preconditions instead of treating them as legacy publication", async () => {
    const { app, store, scene, url } = await setup();
    for (const payload of [{}, { expectedSnapshot: null }, { expectedSnapshot: { schemaVersion: 2 } }]) {
      expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(400);
    }
    expect(store.getPublication(scene.id)).toBeUndefined();
  });
});
