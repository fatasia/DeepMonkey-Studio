import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseDocument, SceneSnapshot } from "@bim-studio/contracts";
import { JsonStore } from "./jsonStore.js";
import { scenePublicationJsonEqual } from "./scenePublicationStore.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const publishedAt = "2026-09-15T10:00:00.000Z";
function snapshot(): SceneSnapshot {
  return { schemaVersion: 1, id: "scene-1", projectId: "default", name: "装配线", models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } },
    createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z" };
}
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-scene-atomic-")); directories.push(directory);
  const store = new ControlledStore(directory); await store.init();
  const scene = snapshot(); await store.saveScene(scene); store.writes = 0;
  const request = { projectId: scene.projectId, sceneId: scene.id, expectedSnapshot: scene, expectedPublication: undefined, publishedAt };
  const restart = async () => { const fresh = new JsonStore(directory); await fresh.init(); return fresh; };
  return { store, scene, request, restart };
}

describe("atomic scene publication", () => {
  it("commits draft, publication and history in one write and survives reload", async () => {
    const { store, scene, request, restart } = await fixture();
    const result = await store.publishSceneSnapshot(request);
    expect(store.writes).toBe(1);
    expect(result).toMatchObject({ status: "published", publication: { version: 1, snapshot: { name: scene.name, publishedAt } } });
    for (const current of [store, await restart()]) {
      expect(current.getScene(scene.projectId, scene.id)?.publishedAt).toBe(publishedAt);
      expect(current.getPublication(scene.id)?.snapshot).toEqual(current.getScene(scene.projectId, scene.id));
      expect(current.listScenePublications(scene.id)).toHaveLength(1);
    }
    expect(scene.publishedAt).toBeUndefined();
  });

  it("accepts wire-equivalent snapshots without depending on object key order", async () => {
    const { store, scene, request } = await fixture();
    await store.saveScene({ ...scene, thumbnail: undefined });
    const reordered = Object.fromEntries(Object.entries(scene).reverse()) as unknown as SceneSnapshot;
    expect((await store.publishSceneSnapshot({ ...request, expectedSnapshot: reordered })).status).toBe("published");
    expect(scenePublicationJsonEqual({ value: undefined, a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(scenePublicationJsonEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(scenePublicationJsonEqual(undefined, null)).toBe(false);
  });

  it("rejects changed content even when its updatedAt is unchanged", async () => {
    const { store, scene, request } = await fixture();
    await store.saveScene({ ...scene, name: "新草稿" }); store.writes = 0;
    expect(await store.publishSceneSnapshot(request)).toEqual({ status: "snapshot-conflict" });
    expect(store.writes).toBe(0);
    expect(store.getScene(scene.projectId, scene.id)?.name).toBe("新草稿");
    expect(store.getPublication(scene.id)).toBeUndefined();
  });

  it("rejects a changed current publication without changing the draft or history", async () => {
    const { store, scene, request } = await fixture();
    await store.savePublication({ sceneId: scene.id, projectId: scene.projectId, name: scene.name, snapshot: scene, publishedAt });
    store.writes = 0;
    expect(await store.publishSceneSnapshot(request)).toEqual({ status: "publication-conflict" });
    expect(store.writes).toBe(0);
    expect(store.getScene(scene.projectId, scene.id)).toEqual(scene);
    expect(store.listScenePublications(scene.id)).toHaveLength(1);
  });

  it("rejects wrong snapshot identity and missing scenes", async () => {
    const { store, scene, request } = await fixture();
    expect(await store.publishSceneSnapshot({ ...request, expectedSnapshot: { ...scene, projectId: "other" } })).toEqual({ status: "snapshot-conflict" });
    expect(await store.publishSceneSnapshot({ ...request, sceneId: "missing" })).toEqual({ status: "scene-not-found" });
    expect(store.writes).toBe(0);
  });

  it("serializes a pending save before publication and refuses the stale snapshot", async () => {
    const { store, scene, request } = await fixture();
    const gate = store.pause();
    const saving = store.saveScene({ ...scene, name: "排队的新草稿" }); await gate.entered;
    const publishing = store.publishSceneSnapshot(request);
    gate.release(); await saving;
    expect(await publishing).toEqual({ status: "snapshot-conflict" });
    expect(store.getPublication(scene.id)).toBeUndefined();
  });

  it("queues saves behind publication without changing the frozen publication", async () => {
    const { store, scene, request, restart } = await fixture();
    const gate = store.pause(); const publishing = store.publishSceneSnapshot(request); await gate.entered;
    expect(store.getPublication(scene.id)).toBeUndefined();
    const saving = store.saveScene({ ...scene, name: "后续草稿" });
    gate.release(); expect((await publishing).status).toBe("published"); await saving;
    for (const current of [store, await restart()]) {
      expect(current.getScene(scene.projectId, scene.id)?.name).toBe("后续草稿");
      expect(current.getPublication(scene.id)?.snapshot.name).toBe(scene.name);
    }
  });

  it("serializes delete-before-publish and publish-before-delete", async () => {
    const first = await fixture();
    const deleting = first.store.removeScene(first.scene.projectId, first.scene.id);
    const publication = first.store.publishSceneSnapshot(first.request);
    await deleting; expect(await publication).toEqual({ status: "scene-not-found" });
    const second = await fixture();
    const publishing = second.store.publishSceneSnapshot(second.request);
    const deletion = second.store.removeScene(second.scene.projectId, second.scene.id);
    expect((await publishing).status).toBe("published"); await deletion;
    expect(second.store.getPublication(second.scene.id)).toBeUndefined();
    expect((await second.restart()).listScenePublications(second.scene.id)).toEqual([]);
  });

  it("allows only one publication for simultaneous requests against one snapshot", async () => {
    const { store, scene, request } = await fixture();
    const results = await Promise.all([store.publishSceneSnapshot(request), store.publishSceneSnapshot(request)]);
    expect(results.map((result) => result.status)).toEqual(["published", "snapshot-conflict"]);
    expect(store.writes).toBe(1); expect(store.listScenePublications(scene.id)).toHaveLength(1);
  });

  it("freezes caller expectations when queued", async () => {
    const { store, scene, request } = await fixture();
    const gate = store.pause(); const saving = store.saveScene(scene); await gate.entered;
    const publishing = store.publishSceneSnapshot(request);
    request.expectedSnapshot.name = "调用者后来改动";
    gate.release(); await saving;
    expect((await publishing).status).toBe("published");
    expect(store.getPublication(scene.id)?.name).toBe("装配线");
  });

  it("rolls back every field on persistence failure, reloads cleanly and permits retry", async () => {
    const { store, scene, request, restart } = await fixture();
    store.fail = true;
    await expect(store.publishSceneSnapshot(request)).rejects.toThrow("injected failure");
    for (const current of [store, await restart()]) {
      expect(current.getScene(scene.projectId, scene.id)).toEqual(scene);
      expect(current.getPublication(scene.id)).toBeUndefined();
      expect(current.listScenePublications(scene.id)).toEqual([]);
    }
    store.fail = false; expect((await store.publishSceneSnapshot(request)).status).toBe("published");
  });

  it("shares version history with the legacy writer", async () => {
    const { store, scene, request } = await fixture();
    const old = await store.savePublication({ projectId: scene.projectId, sceneId: scene.id, name: scene.name, snapshot: scene, publishedAt: scene.updatedAt });
    const result = await store.publishSceneSnapshot({ ...request, expectedPublication: old });
    expect(result).toMatchObject({ status: "published", publication: { version: 2 } });
    expect(store.listScenePublications(scene.id).map((item) => item.version)).toEqual([2, 1]);
  });

  it("preserves an existing publication and history when replacement persistence fails", async () => {
    const { store, scene, request, restart } = await fixture();
    await store.publishSceneSnapshot(request);
    const previousScene = store.getScene(scene.projectId, scene.id)!;
    const previousPublication = store.getPublication(scene.id)!;
    store.fail = true;
    await expect(store.publishSceneSnapshot({ ...request, expectedSnapshot: previousScene,
      expectedPublication: previousPublication, publishedAt: "2026-09-15T11:00:00.000Z" })).rejects.toThrow("injected failure");
    for (const current of [store, await restart()]) {
      expect(current.getScene(scene.projectId, scene.id)).toEqual(previousScene);
      expect(current.getPublication(scene.id)).toEqual(previousPublication);
      expect(current.listScenePublications(scene.id)).toEqual([previousPublication]);
    }
  });
});

class ControlledStore extends JsonStore {
  writes = 0;
  fail = false;
  private gate?: { enter: () => void; released: Promise<void> };
  pause() {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.gate = { enter, released }; return { entered, release };
  }
  protected override async persistDocument(document: DatabaseDocument): Promise<void> {
    this.writes++;
    const gate = this.gate; this.gate = undefined;
    if (gate) { gate.enter(); await gate.released; }
    if (this.fail) throw new Error("injected failure");
    await super.persistDocument(document);
  }
}
