import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateSceneSnapshotV1, type DatabaseDocument, type ModelRecord, type SceneSnapshot } from "@bim-studio/contracts";
import fixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import { JsonStore } from "./store.js";
import { createApiServer } from "./serverOptions.js";
import { registerModelAssetRoutes } from "./modelAssetRoutes.js";
import { registerSceneRoutes } from "./sceneRoutes.js";
import { isModelAssetReferenced } from "./modelAssetReferences.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function scene(assetModelId = "asset-a"): SceneSnapshot {
  const snapshot = structuredClone(fixture) as unknown as SceneSnapshot;
  snapshot.projectId = "default";
  snapshot.models = [{
    modelId: "instance", assetModelId, name: "实例", visible: true, opacity: 1,
    transform: { position: { x: 2, y: 0, z: 1 }, rotation: { x: 0, y: 1, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  }];
  snapshot.selectedModelId = "instance";
  return snapshot;
}

function model(id: string, overrides: Partial<ModelRecord> = {}): ModelRecord {
  return {
    id, projectId: "default", name: `${id}.glb`, format: "glb", size: 1, status: "ready", progress: 100, message: "",
    sourceUrl: `/${id}.glb`, createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z",
    manifest: { schemaVersion: 1, modelId: id, sourceName: `${id}.glb`, sourceFormat: "glb", viewerKind: "gltf", geometryUrl: `/${id}.glb`, createdAt: "2026-09-06T00:00:00Z" },
    ...overrides,
  };
}

async function harness() {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-model-references-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory);
  await store.init();
  await store.addModel("default", model("asset-a"));
  await store.addModel("default", model("asset-b"));
  return { directory, store };
}

describe("model resource reference boundary", () => {
  it.each(["scene", "publication", "scene-history", "application", "application-history", "application-asset"])("protects %s references with project scoping", kind => {
    const snapshot = scene();
    const application = migrateSceneSnapshotV1(snapshot);
    const publication = { sceneId: snapshot.id, projectId: "default", name: snapshot.name, snapshot, publishedAt: snapshot.updatedAt };
    const document: DatabaseDocument = { projects: [], scenes: [] };
    if (kind === "scene") document.scenes = [snapshot];
    if (kind === "publication") document.publishedScenes = [publication];
    if (kind === "scene-history") document.scenePublicationHistory = [publication];
    if (kind === "application") document.applications = [application];
    if (kind === "application-history") document.publishedApplications = [{ id: "version", applicationId: application.metadata.id, projectId: "default", applicationRevision: 1, document: application, publishedAt: snapshot.updatedAt }];
    if (kind === "application-asset") { application.scenes = []; document.applications = [application]; }
    expect(isModelAssetReferenced(document, "default", "asset-a")).toBe(true);
    expect(isModelAssetReferenced(document, "other", "asset-a")).toBe(false);
    expect(isModelAssetReferenced(document, "default", "instance")).toBe(false);
    expect(isModelAssetReferenced(document, "default", "asset-b")).toBe(false);
  });

  it("preserves legacy fields and protects legacy model references", async () => {
    const { store } = await harness();
    const legacy = scene();
    delete legacy.models[0]!.assetModelId;
    legacy.models[0]!.modelId = "asset-a";
    expect(await store.saveScene(legacy)).toEqual(legacy);
    await expect(store.removeModel("default", "asset-a")).rejects.toMatchObject({ statusCode: 409 });
    expect(store.getScene("default", legacy.id)!.models[0]).not.toHaveProperty("assetModelId");
  });

  it("replaces only resource identity and retains immutable publication dependencies", async () => {
    const { store } = await harness();
    const original = scene();
    await store.saveScene(original);
    await store.savePublication({ sceneId: original.id, projectId: "default", name: original.name, snapshot: original, publishedAt: original.updatedAt });
    await store.saveScene(scene("asset-b"));
    expect(store.getScene("default", original.id)!.models[0]).toMatchObject({ modelId: "instance", assetModelId: "asset-b", transform: original.models[0]!.transform });
    expect(store.getPublication(original.id)!.snapshot.models[0]).toMatchObject({ modelId: "instance", assetModelId: "asset-a" });
    await store.removePublication(original.id);
    await expect(store.removeModel("default", "asset-a")).rejects.toMatchObject({ statusCode: 409 });
    await store.removeScene("default", original.id);
    expect(await store.removeModel("default", "asset-a")).toBe(true);
    expect(store.getProject("default")!.models.some(asset => asset.id === "asset-b")).toBe(true);
  });

  it.each(["missing", "wrong-project", "processing", "manifest-id", "no-geometry"])("rejects explicit %s assets without committing", async kind => {
    const { store } = await harness();
    if (kind !== "missing") {
      const patch: Partial<ModelRecord> = kind === "wrong-project" ? { projectId: "other" }
        : kind === "processing" ? { status: "processing" }
          : { manifest: { ...model("invalid").manifest!, ...(kind === "manifest-id" ? { modelId: "another" } : { geometryUrl: "" }) } };
      await store.addModel("default", model("invalid", patch));
    }
    const invalid = scene("invalid");
    await expect(store.saveScene(invalid)).rejects.toMatchObject({ statusCode: 409 });
    expect(store.getScene("default", invalid.id)).toBeUndefined();
  });

  it("rejects duplicate instance ids including primitive collisions", async () => {
    const { store } = await harness();
    const snapshot = scene();
    snapshot.models.push({ ...snapshot.models[0]!, assetModelId: "asset-b" });
    await expect(store.saveScene(snapshot)).rejects.toMatchObject({ statusCode: 400 });
    snapshot.models.pop();
    snapshot.primitives = [{ ...snapshot.models[0]!, kind: "box", color: "#ffffff" }];
    await expect(store.saveScene(snapshot)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("serializes deletion and saving so neither ordering commits a dangling explicit reference", async () => {
    const { store } = await harness();
    const snapshot = scene();
    const saveFirst = await Promise.allSettled([store.saveScene(snapshot), store.removeModel("default", "asset-a")]);
    expect(saveFirst.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    await store.removeScene("default", snapshot.id);
    const deleteFirst = await Promise.allSettled([store.removeModel("default", "asset-a"), store.saveScene(snapshot)]);
    expect(deleteFirst.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(store.getScene("default", snapshot.id)).toBeUndefined();
  });

  it("validates application drafts and workspace scenes atomically", async () => {
    const { store } = await harness();
    const original = scene();
    const application = migrateSceneSnapshotV1(original);
    await store.createApplicationDraft("default", application, original.updatedAt);
    const invalid = scene("missing");
    const changed = migrateSceneSnapshotV1(invalid);
    await expect(store.updateApplicationDraft("default", application.metadata.id, changed, original.updatedAt)).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.saveApplicationWorkspace("default", application.metadata.id, application, invalid, original.updatedAt)).rejects.toMatchObject({ statusCode: 409 });
    expect(store.getApplication("default", application.metadata.id)!.metadata.revision).toBe(1);
    expect(store.getScene("default", original.id)).toBeUndefined();
  });

  it("returns a conflict without touching model binaries and rejects invalid route saves", async () => {
    const { store, directory } = await harness();
    const app = createApiServer();
    cleanup.push(() => app.close());
    const removePrefix = vi.fn();
    await registerModelAssetRoutes(app, { store, dataDir: directory, objects: { removePrefix }, queue: {}, config: {} } as unknown as Parameters<typeof registerModelAssetRoutes>[1]);
    await registerSceneRoutes(app, { store });
    const snapshot = scene();
    await store.saveScene(snapshot);
    const remove = await app.inject({ method: "DELETE", url: "/api/projects/default/models/asset-a" });
    expect(remove.statusCode).toBe(409);
    expect(removePrefix).not.toHaveBeenCalled();
    const save = await app.inject({ method: "PUT", url: `/api/projects/default/scenes/${snapshot.id}`, payload: scene("missing") });
    expect(save.statusCode).toBe(409);
    expect(store.getScene("default", snapshot.id)!.models[0]!.assetModelId).toBe("asset-a");
    expect((await app.inject({ method: "DELETE", url: "/api/projects/default/models/asset-b" })).statusCode).toBe(204);
    expect(removePrefix).toHaveBeenCalledExactlyOnceWith("projects/default/models/asset-b");
  });

  it("saves and publishes two instances, replaces one resource, and restores the old publication", async () => {
    const { store } = await harness();
    const app = createApiServer();
    cleanup.push(() => app.close());
    await registerSceneRoutes(app, { store });
    const snapshot = scene();
    snapshot.models.push({ ...structuredClone(snapshot.models[0]!), modelId: "instance-2", name: "实例二" });
    snapshot.selectionSets = [{ id: "group", name: "双实例", objectIds: ["instance", "instance-2"] }];
    snapshot.interactions = [{ id: "script", name: "实例脚本", target: { kind: "object", modelId: "instance" }, trigger: "click", enabled: true, code: "console.info('instance')" }];
    snapshot.simulationEntities = [{ id: "path", kind: "path", name: "运动路径", targetModelId: "instance", points: [[0, 0, 0], [2, 0, 0]], speed: 1, loopMode: "once" }];
    const base = `/api/projects/default/scenes/${snapshot.id}`;
    expect((await app.inject({ method: "PUT", url: base, payload: snapshot })).statusCode).toBe(200);
    const firstPublication = (await app.inject({ method: "POST", url: `${base}/publish` })).json();
    expect(firstPublication.snapshot.models).toHaveLength(2);
    const replaced = structuredClone(snapshot);
    replaced.models[0]!.assetModelId = "asset-b";
    expect((await app.inject({ method: "PUT", url: base, payload: replaced })).statusCode).toBe(200);
    const read = (await app.inject({ method: "GET", url: base })).json();
    expect(read.models).toEqual(replaced.models);
    expect(read.interactions).toEqual(snapshot.interactions);
    expect(read.simulationEntities).toEqual(snapshot.simulationEntities);
    expect(read.selectionSets).toEqual(snapshot.selectionSets);
    const publicPath = `/api/public/scenes/${snapshot.id}/browse`;
    expect((await app.inject({ method: "GET", url: publicPath })).json().project.models.map((item: ModelRecord) => item.id)).toEqual(["asset-a"]);
    expect((await app.inject({ method: "POST", url: `${base}/publish` })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: publicPath })).json().project.models.map((item: ModelRecord) => item.id)).toEqual(["asset-a", "asset-b"]);
    const restore = await app.inject({ method: "POST", url: `${base}/publications/${encodeURIComponent(firstPublication.publishedAt)}/restore` });
    expect(restore.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: publicPath })).json().publication.snapshot.models).toEqual(snapshot.models);
    expect(store.getScene("default", snapshot.id)!.models).toEqual(replaced.models);
  });
});
