import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseDocument, PublishedSceneRecord, SceneSnapshot } from "@bim-studio/contracts";
import { JsonStore } from "./jsonStore.js";
import { changed } from "./storeUtils.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture(action: "unpublish" | "delete", published = true) {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-discard-atomic-")); directories.push(directory);
  const store = new ControlledStore(directory); await store.init();
  const scene: SceneSnapshot = { schemaVersion: 1, id: "scene", projectId: "default", name: "Current draft", models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } },
    publicationMode: "webgl", publicationPerformance: "fast", publicationToolbarVisible: false,
    createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z",
    ...(published ? { publishedAt: "2026-09-14T00:00:00Z" } : {}) };
  await store.saveScene(scene);
  let current: PublishedSceneRecord | undefined;
  if (published) current = await store.savePublication({ projectId: scene.projectId, sceneId: scene.id, name: "Published", publishedAt: scene.publishedAt!,
    snapshot: { ...scene, name: "Published" } });
  store.writes = 0;
  const request = { projectId: scene.projectId, sceneId: scene.id, expectedSnapshot: structuredClone(scene), expectedPublication: structuredClone(current), action };
  const restart = async () => { const fresh = new JsonStore(directory); await fresh.init(); return fresh; };
  return { store, scene, current, request, restart };
}

describe("atomic scene discard", () => {
  it("unpublishes in one write, preserves draft content and history after reload", async () => {
    const { store, scene, request, restart } = await fixture("unpublish"); const history = store.listScenePublications(scene.id);
    expect(await store.discardScene(request)).toEqual({ status: "discarded" }); expect(store.writes).toBe(1);
    const draft = structuredClone(scene); delete draft.publishedAt;
    for (const value of [store, await restart()]) {
      expect(value.getScene(scene.projectId, scene.id)).toEqual(draft); expect(value.getPublication(scene.id)).toBeUndefined();
      expect(value.listScenePublications(scene.id)).toEqual(history);
    }
  });

  it("deletes draft, active publication and all history atomically with one write", async () => {
    const { store, scene, request, restart } = await fixture("delete");
    expect(await store.discardScene(request)).toEqual({ status: "discarded" }); expect(store.writes).toBe(1);
    for (const value of [store, await restart()]) {
      expect(value.getScene(scene.projectId, scene.id)).toBeUndefined(); expect(value.getPublication(scene.id)).toBeUndefined();
      expect(value.listScenePublications(scene.id)).toEqual([]);
    }
  });

  it("preserves legacy active publication in history before unpublishing", async () => {
    const { store, scene, current, request, restart } = await fixture("unpublish");
    await store.edit(document => { document.scenePublicationHistory = []; }); store.writes = 0;
    expect(await store.discardScene(request)).toEqual({ status: "discarded" }); expect(store.writes).toBe(1);
    for (const value of [store, await restart()]) expect(value.listScenePublications(scene.id)).toEqual([current]);
  });

  it("deletes an unpublished scene but unpublish returns not-published without writing", async () => {
    const { store, scene, request, restart } = await fixture("delete", false);
    expect(await store.discardScene({ ...request, action: "unpublish" })).toEqual({ status: "not-published" }); expect(store.writes).toBe(0);
    expect(await store.discardScene(request)).toEqual({ status: "discarded" }); expect(store.writes).toBe(1);
    expect((await restart()).getScene(scene.projectId, scene.id)).toBeUndefined();
  });

  it("serializes a later draft save after unpublish while retaining publication history", async () => {
    const { store, scene, current, request, restart } = await fixture("unpublish"); const gate = store.pause();
    const discard = store.discardScene(request); await gate.entered;
    expect(store.getPublication(scene.id)).toEqual(current);
    const newer = { ...scene, name: "Saved after unpublish" }; delete newer.publishedAt;
    const saving = store.saveScene(newer); gate.release();
    expect(await discard).toEqual({ status: "discarded" }); await saving;
    for (const value of [store, await restart()]) {
      expect(value.getScene(scene.projectId, scene.id)).toEqual(newer); expect(value.getPublication(scene.id)).toBeUndefined();
      expect(value.listScenePublications(scene.id)).toEqual([current]);
    }
  });

  it("rejects a queued stale publication after discard commits", async () => {
    const { store, scene, current, request, restart } = await fixture("delete"); const gate = store.pause();
    const discard = store.discardScene(request); await gate.entered;
    const publishing = store.publishSceneSnapshot({ projectId: scene.projectId, sceneId: scene.id,
      expectedSnapshot: scene, expectedPublication: current, publishedAt: "2026-09-15T10:00:00Z" });
    gate.release(); expect(await discard).toEqual({ status: "discarded" });
    expect(await publishing).toEqual({ status: "scene-not-found" }); expect(store.writes).toBe(1);
    expect((await restart()).listScenePublications(scene.id)).toEqual([]);
  });

  it.each(["delete", "unpublish", "legacy-delete", "legacy-unpublish"] as const)("%s preserves another project's same-ID draft, publication and history", async operation => {
    const { store, scene, current, request, restart } = await fixture(operation.endsWith("delete") ? "delete" : "unpublish");
    const foreignScene = { ...structuredClone(scene), projectId: "foreign", name: "Foreign draft" };
    const foreignPublication = { ...structuredClone(current!), projectId: "foreign", name: "Foreign publication", snapshot: foreignScene };
    await store.edit(document => {
      document.scenes.push(foreignScene); document.publishedScenes!.push(foreignPublication);
      document.scenePublicationHistory!.push(structuredClone(foreignPublication));
    });
    store.writes = 0;
    if (operation === "legacy-delete") expect(await store.removeScene(scene.projectId, scene.id)).toBe(true);
    else if (operation === "legacy-unpublish") expect(await store.removePublication(scene.id)).toBe(true);
    else expect(await store.discardScene(request)).toEqual({ status: "discarded" });
    expect(store.writes).toBe(1);
    for (const value of [store, await restart()]) {
      expect(value.getScene("foreign", scene.id)).toEqual(foreignScene);
      expect(value.getPublication(scene.id)).toEqual(foreignPublication);
      expect(value.listScenePublications(scene.id).filter(item => item.projectId === "foreign")).toEqual([foreignPublication]);
    }
  });

  it.each(["delete", "unpublish"] as const)("%s rejects foreign current publication even when the caller supplies it as expected", async action => {
    const { store, scene, current, request, restart } = await fixture(action);
    const foreign = { ...structuredClone(current!), projectId: "foreign", snapshot: { ...structuredClone(scene), projectId: "foreign" } };
    await store.edit(document => { document.publishedScenes = [foreign]; }); store.writes = 0;
    const history = store.listScenePublications(scene.id);
    expect(await store.discardScene({ ...request, expectedPublication: foreign })).toEqual({ status: "publication-conflict" });
    expect(store.writes).toBe(0);
    for (const value of [store, await restart()]) {
      expect(value.getScene(scene.projectId, scene.id)).toEqual(scene); expect(value.getPublication(scene.id)).toEqual(foreign);
      expect(value.listScenePublications(scene.id)).toEqual(history);
    }
  });

  for (const action of ["unpublish", "delete"] as const) {
    it(`${action} rejects a newer draft committed while it waits`, async () => {
      const { store, scene, current, request } = await fixture(action); const history = store.listScenePublications(scene.id);
      const gate = store.pause(), saving = store.saveScene({ ...scene, name: "New draft" }); await gate.entered;
      const discard = store.discardScene(request); gate.release(); await saving;
      expect(await discard).toEqual({ status: "snapshot-conflict" }); expect(store.writes).toBe(1);
      expect(store.getScene(scene.projectId, scene.id)?.name).toBe("New draft"); expect(store.getPublication(scene.id)).toEqual(current);
      expect(store.listScenePublications(scene.id)).toEqual(history);
    });

    it(`${action} rejects a newer publication committed while it waits`, async () => {
      const { store, scene, current, request } = await fixture(action); const gate = store.pause();
      const publishing = store.savePublication({ ...current!, name: "New published", publishedAt: "2026-09-15T10:00:00Z" }); await gate.entered;
      const discard = store.discardScene(request); gate.release(); const newer = await publishing;
      expect(await discard).toEqual({ status: "publication-conflict" }); expect(store.writes).toBe(1);
      expect(store.getPublication(scene.id)).toEqual(newer); expect(store.getScene(scene.projectId, scene.id)).toEqual(scene);
    });

    it(`${action} rejects a scene deleted ahead of it without resurrection`, async () => {
      const { store, scene, request, restart } = await fixture(action); const gate = store.pause();
      const deleting = store.removeScene(scene.projectId, scene.id); await gate.entered;
      const discard = store.discardScene(request); gate.release(); await deleting;
      expect(await discard).toEqual({ status: "scene-not-found" }); expect(store.writes).toBe(1);
      expect((await restart()).getScene(scene.projectId, scene.id)).toBeUndefined();
    });

    it(`${action} rolls back memory and disk when persistence fails and can retry`, async () => {
      const { store, scene, current, request, restart } = await fixture(action); const history = store.listScenePublications(scene.id);
      store.fail = true; await expect(store.discardScene(request)).rejects.toThrow("injected failure");
      for (const value of [store, await restart()]) {
        expect(value.getScene(scene.projectId, scene.id)).toEqual(scene); expect(value.getPublication(scene.id)).toEqual(current);
        expect(value.listScenePublications(scene.id)).toEqual(history);
      }
      store.fail = false; expect(await store.discardScene(request)).toEqual({ status: "discarded" });
    });

    it(`${action} freezes expected inputs and action at enqueue time`, async () => {
      const { store, scene, request } = await fixture(action); const gate = store.pause();
      const saving = store.saveScene(scene); await gate.entered;
      const discard = store.discardScene(request);
      request.expectedSnapshot.name = "Changed"; request.expectedPublication!.snapshot.name = "Changed";
      request.expectedPublication!.name = "Changed"; request.action = action === "delete" ? "unpublish" : "delete";
      request.projectId = "foreign"; gate.release(); await saving;
      expect(await discard).toEqual({ status: "discarded" });
      expect(Boolean(store.getScene(scene.projectId, scene.id))).toBe(action === "unpublish");
    });

    it(`${action} accepts only one simultaneous request`, async () => {
      const { store, request } = await fixture(action);
      const results = await Promise.all([store.discardScene(request), store.discardScene(request)]);
      expect(results[0]).toEqual({ status: "discarded" });
      expect(results[1]).toEqual({ status: action === "delete" ? "scene-not-found" : "snapshot-conflict" }); expect(store.writes).toBe(1);
    });

    it(`${action} rejects a different project without touching the target scene`, async () => {
      const { store, scene, current, request } = await fixture(action);
      expect(await store.discardScene({ ...request, projectId: "foreign" })).toEqual({ status: "scene-not-found" });
      expect(store.writes).toBe(0); expect(store.getScene(scene.projectId, scene.id)).toEqual(scene); expect(store.getPublication(scene.id)).toEqual(current);
    });
  }
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
  edit(edit: (document: DatabaseDocument) => void) {
    return this.runDocumentMutation(document => { edit(document); return changed(undefined); });
  }
  protected override async persistDocument(document: DatabaseDocument): Promise<void> {
    this.writes++; const gate = this.gate; this.gate = undefined;
    if (gate) { gate.enter(); await gate.released; }
    if (this.fail) throw new Error("injected failure");
    await super.persistDocument(document);
  }
}
