import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseDocument, SceneSnapshot } from "@bim-studio/contracts";
import { selectSceneClientDependencyInputs } from "@bim-studio/studio-core";
import { JsonStore } from "./jsonStore.js";
import { LocalObjectStore } from "./objects.js";
import { changed } from "./storeUtils.js";
import { captureScenePublicationDependencies } from "./scenePublicationDependencyCapture.js";
import { registerSceneRoutes } from "./sceneRoutes.js";
import { createApiServer } from "./serverOptions.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
class FixtureStore extends JsonStore {
  edit(edit: (document: DatabaseDocument) => void) { return this.runDocumentMutation(document => { edit(document); return changed(undefined); }); }
}
async function setup(beforeDiscardPublication?: (publication: import("@bim-studio/contracts").PublishedSceneRecord) => Promise<void>) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "scene-capture-")); cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const store = new FixtureStore(dataDir); await store.init(); const objects = new LocalObjectStore(dataDir);
  const key = "projects/default/images/image.bin", url = `/assets/${key}`;
  await mkdir(path.dirname(path.join(dataDir, key)), { recursive: true }); await writeFile(path.join(dataDir, key), "old");
  const scene = { schemaVersion: 1, id: "capture", projectId: "default", name: "Capture", models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } },
    dashboard: { side: "right", width: 300, widgets: [{ id: "image", type: "image", imageUrl: url }] },
    createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z" } as SceneSnapshot;
  await store.edit(document => { document.projects.find(project => project.id === "default")!.assets = [
    { id: "image", projectId: "default", name: "Image", fileName: "image.bin", kind: "image", url, size: 3 } as never]; });
  await store.saveScene(scene);
  const app = createApiServer(); cleanups.push(() => app.close());
  await registerSceneRoutes(app, { store, deliveryStorage: { objects, dataDir }, ...(beforeDiscardPublication ? { beforeDiscardPublication } : {}) });
  const input = { store, objects, dataDir, scene };
  return { ...input, key, url, app, input, publishUrl: "/api/projects/default/scenes/capture/publish" };
}
describe("scene publication resource capture integration", () => {
  it("freezes old source bytes and binds them to a real published version", async () => {
    const f = await setup();
    const response = await f.app.inject({ method: "POST", url: f.publishUrl, payload: { expectedSnapshot: f.scene, clientTarget: "three-webview" } });
    expect(response.statusCode).toBe(201);
    const record = f.store.getScenePublicationDependencies("default", "capture", response.json().version)!;
    expect(record.resources).toHaveLength(1);
    await writeFile(path.join(f.dataDir, f.key), "new");
    expect(await readFile(path.join(f.dataDir, record.resources[0]!.key), "utf8")).toBe("old");
    const reloaded = new JsonStore(f.dataDir); await reloaded.init();
    expect(reloaded.getScenePublicationDependencies("default", "capture", response.json().version)).toEqual(record);
  });

  it.each(["draft", "project"])("rejects publication CAS when %s changes during resource capture", async kind => {
    const f = await setup(); const original = f.objects.read.bind(f.objects); let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.objects, "read").mockImplementationOnce(async key => { enter(); await gate; return original(key); });
    const pending = f.app.inject({ method: "POST", url: f.publishUrl, payload: { expectedSnapshot: f.scene, clientTarget: "three-webview" } }).then(result => result);
    await entered;
    if (kind === "draft") await f.store.saveScene({ ...f.scene, name: "Concurrent draft" });
    else await f.store.edit(document => { document.projects.find(project => project.id === "default")!.assets![0]!.name = "Concurrent asset metadata"; });
    release(); expect((await pending).statusCode).toBe(409);
    expect(f.store.getPublication("capture")).toBeUndefined(); expect(f.store.getScenePublicationDependencies("default", "capture", 1)).toBeUndefined();
    expect(f.store.getScene("default", "capture")?.name).toBe(kind === "draft" ? "Concurrent draft" : "Capture");
  });

  it("keeps legacy publish free of resource capture", async () => {
    const f = await setup(); const read = vi.spyOn(f.objects, "read"); await rm(path.join(f.dataDir, f.key));
    const response = await f.app.inject({ method: "POST", url: f.publishUrl });
    expect(response.statusCode).toBe(201); expect(read).not.toHaveBeenCalled();
    expect(f.store.getScenePublicationDependencies("default", "capture", response.json().version)).toBeUndefined();
  });

  it.each(["foreign", "external", "missing"])("rejects %s sources instead of publishing partial dependencies", async kind => {
    const f = await setup();
    if (kind === "missing") await rm(path.join(f.dataDir, f.key));
    else {
      const url = kind === "foreign" ? "/assets/projects/foreign/image.bin" : "https://example.test/image.bin";
      f.scene.dashboard!.widgets[0]!.imageUrl = url;
      await f.store.edit(document => { document.projects.find(project => project.id === "default")!.assets![0]!.url = url; });
    }
    await expect(captureScenePublicationDependencies(f.input)).rejects.toThrow(); expect(f.store.getPublication("capture")).toBeUndefined();
  });

  it("rejects same-size preflight hash mismatch against actual bytes", async () => {
    const f = await setup(); const inputs = selectSceneClientDependencyInputs(f.store.getProject("default")!, f.scene, []);
    await expect(captureScenePublicationDependencies({ ...f.input, expected: { inputs, resources: [{ sourceUrl: f.url, bytes: 3, sha256: "0".repeat(64) }] } })).rejects.toThrow(/不匹配/);
  });

  it("rejects declared asset size mismatch", async () => {
    const f = await setup(); await f.store.edit(document => { document.projects.find(project => project.id === "default")!.assets![0]!.size = 4; });
    await expect(captureScenePublicationDependencies(f.input)).rejects.toThrow(/内容与记录不符/);
  });

  it("does not target a newer publication's worker after delayed capture finishes", async () => {
    const stop = vi.fn().mockResolvedValue(undefined), f = await setup(stop);
    const old = await f.store.savePublication({ projectId: "default", sceneId: "capture", name: "Old", snapshot: f.scene, publishedAt: f.scene.updatedAt });
    const original = f.objects.read.bind(f.objects); let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.objects, "read").mockImplementationOnce(async key => { enter(); await gate; return original(key); });
    const pending = f.app.inject({ method: "POST", url: f.publishUrl, payload: { expectedSnapshot: f.scene, clientTarget: "three-webview" } }).then(value => value);
    await entered;
    const newer = await f.store.savePublication({ ...old, name: "New version", snapshot: { ...f.scene, name: "New version" } });
    release(); expect((await pending).statusCode).toBe(409);
    expect(stop.mock.calls.some(([publication]) => publication.version === newer.version)).toBe(false);
    expect(f.store.getPublication("capture")).toEqual(newer);
  });

  it("rejects pre-cancelled empty captures without reading resources", async () => {
    const f = await setup(); delete f.scene.dashboard;
    const controller = new AbortController(); controller.abort(); const read = vi.spyOn(f.objects, "read");
    await expect(captureScenePublicationDependencies({ ...f.input, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(read).not.toHaveBeenCalled();
  });

  it("requires a server Native window candidate before capture or publication", async () => {
    const f = await setup(); const read = vi.spyOn(f.objects, "read"), commit = vi.spyOn(f.store, "publishSceneSnapshot");
    const response = await f.app.inject({ method: "POST", url: f.publishUrl, payload: { expectedSnapshot: f.scene, clientTarget: "deep-native" } });
    expect(response.statusCode).toBe(400); expect(read).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  });

  it("cancels a disconnected real HTTP request after final resource read without stopping or publishing", async () => {
    const stop = vi.fn().mockResolvedValue(undefined), f = await setup(stop);
    await f.store.savePublication({ projectId: "default", sceneId: "capture", name: "Old", snapshot: f.scene, publishedAt: f.scene.updatedAt });
    const original = f.objects.read.bind(f.objects); let enter!: () => void, release!: () => void, closed!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const disconnected = new Promise<void>(resolve => { closed = resolve; });
    f.app.addHook("onRequest", async (_request, reply) => { reply.raw.once("close", closed); });
    vi.spyOn(f.objects, "read").mockImplementation(async key => {
      const result = await original(key);
      if (key.includes("publication-resources")) {
        result.stream.once("end", enter);
        return { stream: result.stream, completed: result.completed.then(() => gate) };
      }
      return result;
    });
    const commit = vi.spyOn(f.store, "publishSceneSnapshot");
    const address = await f.app.listen({ port: 0, host: "127.0.0.1" });
    const req = httpRequest(`${address}${f.publishUrl}`, { method: "POST", headers: { "content-type": "application/json" } });
    req.on("error", () => undefined); req.end(JSON.stringify({ expectedSnapshot: f.scene, clientTarget: "three-webview" }));
    await entered; req.destroy(); await disconnected; release();
    await vi.waitFor(async () => expect(await readdir(path.join(f.dataDir, ".publication-resource-staging"))).toEqual([]));
    expect(stop).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
    expect(f.store.getPublication("capture")?.name).toBe("Old");
  });

  it("checks disconnection again after worker shutdown before committing", async () => {
    let enter!: () => void, release!: () => void, closed!: () => void, errored!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const disconnected = new Promise<void>(resolve => { closed = resolve; }), error = new Promise<void>(resolve => { errored = resolve; });
    const f = await setup(async () => { enter(); await gate; });
    await f.store.savePublication({ projectId: "default", sceneId: "capture", name: "Old", snapshot: f.scene, publishedAt: f.scene.updatedAt });
    f.app.addHook("onRequest", async (_request, reply) => { reply.raw.once("close", closed); });
    f.app.addHook("onError", async () => { errored(); });
    const commit = vi.spyOn(f.store, "publishSceneSnapshot"), address = await f.app.listen({ port: 0, host: "127.0.0.1" });
    const req = httpRequest(`${address}${f.publishUrl}`, { method: "POST", headers: { "content-type": "application/json" } });
    req.on("error", () => undefined); req.end(JSON.stringify({ expectedSnapshot: f.scene, clientTarget: "three-webview" }));
    await entered; req.destroy(); await disconnected; release(); await error;
    expect(commit).not.toHaveBeenCalled(); expect(f.store.getPublication("capture")?.name).toBe("Old");
  });
});
