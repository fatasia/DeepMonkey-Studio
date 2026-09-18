import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublishedSceneRecord, SceneSnapshot } from "@bim-studio/contracts";
import type { CloudRenderWorkerClient, CloudRenderWorkerSession } from "@bim-studio/server-sdk";
import { CloudRenderControlPlane, MemoryCloudRenderRegistry } from "./cloudRenderControl.js";
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
async function setup(beforeStop?: (publication: PublishedSceneRecord) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "bim-discard-cloud-integration-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const store = new JsonStore(dir); await store.init();
  const timestamp = "2026-09-15T01:00:00.000Z";
  const scene: SceneSnapshot = { schemaVersion: 1, id: "scene", projectId: "default", name: "Draft", models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } },
    createdAt: timestamp, updatedAt: timestamp, publishedAt: timestamp };
  await store.saveScene(scene);
  const publication = await store.savePublication({ projectId: scene.projectId, sceneId: scene.id, name: scene.name, publishedAt: timestamp, snapshot: scene });
  const sessions = new Map<string, CloudRenderWorkerSession>();
  const worker = {
    health: vi.fn<CloudRenderWorkerClient["health"]>().mockResolvedValue({ contractVersion: 1, workerId: "worker", status: "ready", observedAt: timestamp,
      capacity: { maxSessions: 4, activeSessions: 0 }, gpu: { vendor: "NVIDIA", model: "L40S", memoryMiB: 48_000, encoder: { hardware: true, codecs: ["h264"] } } }),
    createSession: vi.fn<CloudRenderWorkerClient["createSession"]>().mockImplementation(async request => {
      const workerSessionId = `worker-session-${sessions.size + 1}`;
      const session: CloudRenderWorkerSession = { contractVersion: 1, workerSessionId, sceneId: request.scope.sceneId,
        publishedAt: request.scope.publishedAt, state: "starting", viewerUrl: `https://worker.example.test/${workerSessionId}` };
      sessions.set(workerSessionId, session); return structuredClone(session);
    }),
    getSession: vi.fn<CloudRenderWorkerClient["getSession"]>().mockImplementation(async id => structuredClone(sessions.get(id)!)),
    stopSession: vi.fn<CloudRenderWorkerClient["stopSession"]>().mockResolvedValue(undefined),
  };
  const control = new CloudRenderControlPlane(new MemoryCloudRenderRegistry(), { worker, publicOrigin: "https://studio.example.test", now: () => new Date(timestamp) });
  await control.init(); await control.setEnabled(publication, true); await control.startSession(publication, "admin");
  const app = createApiServer(); cleanups.push(() => app.close());
  await registerSceneRoutes(app, { store, beforeDiscardPublication: async captured => {
    await beforeStop?.(captured); await control.setEnabled(captured, false);
  } });
  const state = () => ({ draft: store.getScene(scene.projectId, scene.id), publication: store.getPublication(scene.id), history: store.listScenePublications(scene.id) });
  return { app, store, scene, publication, worker, control, state };
}
const url = (action: "unpublish" | "delete") => `/api/projects/default/scenes/scene${action === "unpublish" ? "/publish" : ""}`;

describe("scene removal through the real cloud control plane", () => {
  it.each(["delete", "unpublish"] as const)("late %s never stops a newer publication's session sharing its timestamp", async action => {
    const entered = latch(), release = latch();
    const { app, store, scene, publication, worker, control, state } = await setup(async captured => {
      expect(captured.version).toBe(1); entered.release(); await release.promise;
    });
    const pending = app.inject({ method: "DELETE", url: url(action) }).then(response => response);
    await entered.promise;
    const newer = await store.savePublication({ ...publication, name: "Version two", snapshot: { ...scene, name: "Version two" } });
    expect(newer.version).toBe(2); expect(newer.publishedAt).toBe(publication.publishedAt);
    await control.setEnabled(publication, false);
    expect(worker.stopSession).toHaveBeenCalledExactlyOnceWith("worker-session-1");
    await control.setEnabled(newer, true); const started = await control.startSession(newer, "admin");
    expect(started.workerSessionId).toBe("worker-session-2");
    const expected = state(); release.release();
    const response = await pending;
    expect(response.statusCode).toBe(409); expect(response.json()).toMatchObject({ code: "publication_changed" });
    expect(worker.stopSession).toHaveBeenCalledExactlyOnceWith("worker-session-1"); expect(state()).toEqual(expected);
    expect((await control.overview([newer])).scenes[0]).toMatchObject({ enabled: true, session: { workerSessionId: "worker-session-2", state: "signaling" } });
  });

  it("unpublishes only after the real control plane receives worker shutdown acknowledgement", async () => {
    const { app, store, scene, publication, worker, control, state } = await setup();
    const entered = latch(), stopped = latch(), before = state();
    worker.stopSession.mockImplementationOnce(async () => { entered.release(); await stopped.promise; });
    const pending = app.inject({ method: "DELETE", url: url("unpublish") }).then(response => response);
    await entered.promise; expect(state()).toEqual(before); stopped.release();
    expect((await pending).statusCode).toBe(204); expect(worker.stopSession).toHaveBeenCalledExactlyOnceWith("worker-session-1");
    expect(store.getPublication(scene.id)).toBeUndefined(); expect(store.getScene(scene.projectId, scene.id)).not.toHaveProperty("publishedAt");
    expect(store.listScenePublications(scene.id)).toEqual([publication]);
    expect((await control.overview([publication])).scenes[0]).toMatchObject({ enabled: false, session: { state: "closed" } });
  });

  it.each(["delete", "unpublish"] as const)("%s preserves a new draft saved while worker shutdown awaits acknowledgement", async action => {
    const { app, store, scene, publication, worker, control } = await setup(); const entered = latch(), stopped = latch();
    worker.stopSession.mockImplementationOnce(async () => { entered.release(); await stopped.promise; });
    const pending = app.inject({ method: "DELETE", url: url(action) }).then(response => response);
    await entered.promise;
    const draft = { ...scene, name: "Concurrent draft", updatedAt: "2026-09-15T02:00:00Z" }; await store.saveScene(draft);
    stopped.release(); expect((await pending).statusCode).toBe(409);
    expect(worker.stopSession).toHaveBeenCalledExactlyOnceWith("worker-session-1");
    expect(store.getScene(scene.projectId, scene.id)).toEqual(draft); expect(store.getPublication(scene.id)).toEqual(publication);
    expect(store.listScenePublications(scene.id)).toEqual([publication]);
    expect((await control.overview([publication])).scenes[0]).toMatchObject({ enabled: false, session: { state: "closed" } });
  });
});
