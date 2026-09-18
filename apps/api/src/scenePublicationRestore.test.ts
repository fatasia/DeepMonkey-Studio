import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseDocument, SceneSnapshot } from "@bim-studio/contracts";
import { JsonStore } from "./jsonStore.js";
import { changed } from "./storeUtils.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const publishedAt = "2026-09-15T10:00:00.000Z";
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-restore-atomic-")); directories.push(directory);
  const store = new ControlledStore(directory); await store.init();
  const scene: SceneSnapshot = { schemaVersion: 1, id: "scene", projectId: "default", name: "Current draft", models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } },
    createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z" };
  await store.saveScene(scene);
  const historical = await store.savePublication({ projectId: scene.projectId, sceneId: scene.id, name: "Historical", publishedAt: "2026-09-13T00:00:00Z",
    snapshot: { ...scene, name: "Historical", publicationMode: "webgl", publicationPerformance: "fast", publicationToolbarVisible: false } });
  const current = await store.savePublication({ ...historical, name: "Current publication", publishedAt: "2026-09-14T00:00:00Z" });
  store.writes = 0;
  const request = { projectId: scene.projectId, sceneId: scene.id, expectedSnapshot: structuredClone(scene), expectedPublication: structuredClone(current),
    historicalPublication: structuredClone(historical), publishedAt };
  const restart = async () => { const fresh = new JsonStore(directory); await fresh.init(); return fresh; };
  return { store, scene, historical, current, request, restart };
}

describe("atomic historical publication restoration", () => {
  it("writes publication, history and draft metadata once while preserving draft content on reload", async () => {
    const { store, scene, request, restart } = await fixture();
    const result = await store.restoreScenePublication(request);
    expect(result.status).toBe("restored"); expect(store.writes).toBe(1);
    for (const value of [store, await restart()]) {
      expect(value.getScene(scene.projectId, scene.id)).toEqual({ ...scene, publishedAt, publicationMode: "webgl", publicationPerformance: "fast", publicationToolbarVisible: false });
      expect(value.getPublication(scene.id)).toMatchObject({ version: 3, name: "Historical", publishedAt,
        snapshot: { name: "Historical", updatedAt: publishedAt, publishedAt } });
      expect(value.listScenePublications(scene.id)).toHaveLength(3);
    }
  });

  it("rejects a queued restore behind a newer save without altering publication or history", async () => {
    const { store, scene, request, current } = await fixture(); const history = store.listScenePublications(scene.id);
    const gate = store.pause(), saving = store.saveScene({ ...scene, name: "New draft" }); await gate.entered;
    const restore = store.restoreScenePublication(request); gate.release(); await saving;
    expect(await restore).toEqual({ status: "snapshot-conflict" }); expect(store.writes).toBe(1);
    expect(store.getScene(scene.projectId, scene.id)?.name).toBe("New draft");
    expect(store.getPublication(scene.id)).toEqual(current); expect(store.listScenePublications(scene.id)).toEqual(history);
  });

  it("rejects a queued restore behind a newer publication", async () => {
    const { store, scene, request, current } = await fixture(); const gate = store.pause();
    const publishing = store.savePublication({ ...current, name: "New publication", publishedAt }); await gate.entered;
    const restore = store.restoreScenePublication(request); gate.release(); const newer = await publishing;
    expect(await restore).toEqual({ status: "publication-conflict" });
    expect(store.getPublication(scene.id)).toEqual(newer); expect(store.getScene(scene.projectId, scene.id)).toEqual(scene);
    expect(store.writes).toBe(1);
  });

  it("allows a later save after restore without replacing the restored immutable snapshot", async () => {
    const { store, scene, request, restart } = await fixture(); const gate = store.pause();
    const restoring = store.restoreScenePublication(request); await gate.entered;
    expect(store.getPublication(scene.id)?.publishedAt).toBe(request.expectedPublication.publishedAt);
    const saving = store.saveScene({ ...scene, name: "Later draft" }); gate.release();
    expect((await restoring).status).toBe("restored"); await saving;
    for (const value of [store, await restart()]) {
      expect(value.getScene(scene.projectId, scene.id)?.name).toBe("Later draft");
      expect(value.getPublication(scene.id)?.name).toBe("Historical");
    }
  });

  it("serializes deletion before and after restore without resurrecting a scene", async () => {
    const first = await fixture(); const gate = first.store.pause();
    const deleting = first.store.removeScene(first.scene.projectId, first.scene.id); await gate.entered;
    const restore = first.store.restoreScenePublication(first.request); gate.release(); await deleting;
    expect(await restore).toEqual({ status: "scene-not-found" });
    expect(first.store.getPublication(first.scene.id)).toBeUndefined();
    const second = await fixture(); const restoring = second.store.restoreScenePublication(second.request);
    const deletion = second.store.removeScene(second.scene.projectId, second.scene.id);
    expect((await restoring).status).toBe("restored"); await deletion;
    expect((await second.restart()).listScenePublications(second.scene.id)).toEqual([]);
  });

  it("rolls back all fields on persistence failure and permits retry after reload", async () => {
    const { store, scene, current, request, restart } = await fixture(); const history = store.listScenePublications(scene.id);
    store.fail = true; await expect(store.restoreScenePublication(request)).rejects.toThrow("injected failure");
    for (const value of [store, await restart()]) {
      expect(value.getScene(scene.projectId, scene.id)).toEqual(scene); expect(value.getPublication(scene.id)).toEqual(current);
      expect(value.listScenePublications(scene.id)).toEqual(history);
    }
    store.fail = false; expect((await store.restoreScenePublication(request)).status).toBe("restored");
  });

  it("freezes all caller inputs before waiting for a pending write", async () => {
    const { store, scene, request } = await fixture(); const gate = store.pause();
    const saving = store.saveScene(scene); await gate.entered;
    const restore = store.restoreScenePublication(request);
    request.expectedSnapshot.name = "Changed"; request.expectedPublication.name = "Changed";
    request.historicalPublication.name = "Changed"; request.historicalPublication.snapshot.name = "Changed";
    request.publishedAt = "invalid"; gate.release(); await saving;
    expect((await restore).status).toBe("restored");
    expect(store.getPublication(scene.id)).toMatchObject({ name: "Historical", publishedAt, snapshot: { name: "Historical" } });
  });

  it.each(["missing", "changed"])("rejects %s historical content even when draft and current publication still match", async kind => {
    const { store, scene, request, current } = await fixture();
    await store.editHistory(document => {
      if (kind === "missing") document.scenePublicationHistory = document.scenePublicationHistory!.filter(item => item.publishedAt !== request.historicalPublication.publishedAt);
      else document.scenePublicationHistory!.find(item => item.publishedAt === request.historicalPublication.publishedAt)!.snapshot.name = "History changed";
    });
    store.writes = 0; const history = store.listScenePublications(scene.id);
    expect(await store.restoreScenePublication(request)).toEqual({ status: "history-conflict" });
    expect(store.writes).toBe(0); expect(store.getScene(scene.projectId, scene.id)).toEqual(scene);
    expect(store.getPublication(scene.id)).toEqual(current); expect(store.listScenePublications(scene.id)).toEqual(history);
  });

  it("accepts only one concurrent restore against the same expected state", async () => {
    const { store, request } = await fixture();
    const results = await Promise.all([store.restoreScenePublication(request), store.restoreScenePublication(request)]);
    expect(results.map(result => result.status)).toEqual(["restored", "snapshot-conflict"]); expect(store.writes).toBe(1);
  });

  it("rejects ambiguous timestamps belonging to two distinct historical versions", async () => {
    const { store, scene, request, current } = await fixture();
    await store.editHistory(document => {
      document.scenePublicationHistory!.push({ ...structuredClone(request.historicalPublication), version: 99 });
    });
    store.writes = 0; const history = store.listScenePublications(scene.id);
    expect(await store.restoreScenePublication(request)).toEqual({ status: "history-conflict" });
    expect(store.writes).toBe(0); expect(store.getPublication(scene.id)).toEqual(current);
    expect(store.getScene(scene.projectId, scene.id)).toEqual(scene); expect(store.listScenePublications(scene.id)).toEqual(history);
  });

  it.each(["projectId", "id"] as const)("rejects matching stored history with a foreign snapshot %s", async field => {
    const { store, scene, request, current } = await fixture();
    request.historicalPublication.snapshot[field] = "foreign";
    await store.editHistory(document => {
      const historical = document.scenePublicationHistory!.find(item => item.publishedAt === request.historicalPublication.publishedAt)!;
      historical.snapshot[field] = "foreign";
    });
    store.writes = 0; const history = store.listScenePublications(scene.id);
    expect(await store.restoreScenePublication(request)).toEqual({ status: "history-conflict" });
    expect(store.writes).toBe(0); expect(store.getPublication(scene.id)).toEqual(current);
    expect(store.getScene(scene.projectId, scene.id)).toEqual(scene); expect(store.listScenePublications(scene.id)).toEqual(history);
  });

  it("rejects an invalid new publication timestamp without any persistence", async () => {
    const { store, scene, request, current, restart } = await fixture(); const history = store.listScenePublications(scene.id);
    await expect(store.restoreScenePublication({ ...request, publishedAt: "not-a-date" })).rejects.toThrow("发布时间无效");
    expect(store.writes).toBe(0);
    for (const value of [store, await restart()]) {
      expect(value.getScene(scene.projectId, scene.id)).toEqual(scene); expect(value.getPublication(scene.id)).toEqual(current);
      expect(value.listScenePublications(scene.id)).toEqual(history);
    }
  });

  it("isolates the returned publication and nested snapshot from committed data", async () => {
    const { store, scene, request, restart } = await fixture();
    const result = await store.restoreScenePublication(request);
    if (result.status !== "restored") throw new Error("Restore failed");
    const publication = store.getPublication(scene.id), history = store.listScenePublications(scene.id), draft = store.getScene(scene.projectId, scene.id);
    result.publication.name = "Changed return"; result.publication.snapshot.camera.position.x = 999;
    result.publication.snapshot.name = "Changed nested return";
    for (const value of [store, await restart()]) {
      expect(value.getPublication(scene.id)).toEqual(publication); expect(value.listScenePublications(scene.id)).toEqual(history);
      expect(value.getScene(scene.projectId, scene.id)).toEqual(draft);
    }
  });
});

class ControlledStore extends JsonStore {
  writes = 0; fail = false;
  private gate: { enter: () => void; released: Promise<void> } | undefined;
  pause() {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    this.gate = { enter, released }; return { entered, release };
  }
  editHistory(edit: (document: DatabaseDocument) => void) {
    return this.runDocumentMutation(document => { edit(document); return changed(undefined); });
  }
  protected override async persistDocument(document: DatabaseDocument): Promise<void> {
    this.writes++; const gate = this.gate; this.gate = undefined;
    if (gate) { gate.enter(); await gate.released; }
    if (this.fail) throw new Error("injected failure");
    await super.persistDocument(document);
  }
}
