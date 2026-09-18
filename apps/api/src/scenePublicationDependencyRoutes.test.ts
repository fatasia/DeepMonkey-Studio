import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseDocument, SceneSnapshot } from "@bim-studio/contracts";
import { JsonStore } from "./jsonStore.js";
import { LocalObjectStore } from "./objects.js";
import { changed } from "./storeUtils.js";
import { createApiServer } from "./serverOptions.js";
import { registerRoutes } from "./routes.js";
import { registerSystemRoutes } from "./system.js";
import { loadConfig } from "./config.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
class FixtureStore extends JsonStore {
  edit(edit: (document: DatabaseDocument) => void) { return this.runDocumentMutation(document => { edit(document); return changed(undefined); }); }
}
async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "scene-dependency-routes-")); cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const store = new FixtureStore(dataDir); await store.init(); const objects = new LocalObjectStore(dataDir);
  const key = "projects/default/image.bin"; await mkdir(path.join(dataDir, "projects/default"), { recursive: true }); await writeFile(path.join(dataDir, key), "old");
  const scene = { schemaVersion: 1, id: "dependency", projectId: "default", name: "Scene", models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } },
    dashboard: { side: "right", width: 300, widgets: [{ id: "image", type: "image", imageUrl: `/assets/${key}` }] },
    createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z" } as SceneSnapshot;
  await store.edit(document => { document.projects.find(project => project.id === "default")!.assets = [
    { id: "image", projectId: "default", name: "Image", fileName: "image.bin", kind: "image", url: `/assets/${key}`, size: 3 } as never]; });
  await store.saveScene(scene);
  const app = createApiServer(); cleanups.push(() => app.close());
  await registerSystemRoutes(app, store, dataDir);
  await registerRoutes(app, { store, objects, dataDir, config: loadConfig(), queue: undefined as never });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin" } });
  expect(login.statusCode).toBe(200); const headers = { authorization: `Bearer ${login.json().token}` };
  const publish = await app.inject({ method: "POST", url: "/api/projects/default/scenes/dependency/publish", headers,
    payload: { expectedSnapshot: scene, clientTarget: "three-webview" } });
  expect(publish.statusCode).toBe(201);
  const version = publish.json().version as number;
  const record = store.getScenePublicationDependencies("default", "dependency", version)!;
  const base = `/api/projects/default/scenes/dependency/publications/${version}/dependencies`;
  return { app, store, objects, dataDir, key, headers, record, base, version };
}
describe("private publication dependency routes", () => {
  it("serves only the authorized Native compiled member and keeps it private", async () => {
    const f = await setup(), content = "server-owned-runtime-bytes";
    const sha256 = createHash("sha256").update(content).digest("hex"), source = "a".repeat(64), graph = "b".repeat(64), fixtureId = `scene-${source}`;
    const key = `projects/default/publication-resources/sha256/${sha256}`;
    await writeFile(path.join(f.dataDir, key), content);
    // 合成描述只验证授权读取，不授予实际窗口证据。
    await f.store.edit(document => {
      document.scenePublicationDependencies![0]!.nativeCompiled = {
        runtimePackage: { key, sha256, bytes: Buffer.byteLength(content) }, compilationEvidence: { sourceSemanticHash: source, compileGraphHash: graph, targetArtifactHash: sha256 },
        compilerSha256: "d".repeat(64), executableSha256: "e".repeat(64), verifiedAt: "2026-09-15T12:00:00Z",
        compatibilityReport: { schemaVersion: 1, target: "deep-native", sceneId: "dependency", status: "ready", platform: "windows-x64", fixtureId,
          contentFingerprint: source, compileGraphHash: graph, targetArtifactHash: sha256, capabilityProfileVersion: "deep-scene-compiled-v1",
          items: ["deep.scene.runtime.v1", "deep.scene.camera.v1"].map((capability, index) => ({ sceneId: "dependency", objectId: "dependency",
            path: index ? "camera" : "$", capability, status: "supported", reason: "测试证据", remediation: "重新验证", evidenceIds: [capability] })),
          evidence: ["deep.scene.runtime.v1", "deep.scene.camera.v1"].map(capability => ({ id: capability, capability, target: "deep-native", scope: "native-window",
            platform: "windows-x64", fixtureId, sourceSemanticHash: source, compileGraphHash: graph, targetArtifactHash: sha256 })) },
      };
    });
    const url = `${f.base}/resources/${sha256}`, read = vi.spyOn(f.objects, "read");
    expect((await f.app.inject({ url })).statusCode).toBe(401);
    expect((await f.app.inject({ url: `/assets/${key}` })).statusCode).toBe(404);
    expect((await f.app.inject({ url: `${f.base}/resources/${"f".repeat(64)}`, headers: f.headers })).statusCode).toBe(404);
    expect(read).not.toHaveBeenCalled();
    const response = await f.app.inject({ url, headers: f.headers });
    expect(response.statusCode).toBe(200); expect(response.body).toBe(content);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(read).toHaveBeenCalledExactlyOnceWith(key);
  });
  it("serves frozen old bytes to an authenticated member after the source is overwritten", async () => {
    const f = await setup(); await writeFile(path.join(f.dataDir, f.key), "new");
    const descriptor = await f.app.inject({ url: f.base, headers: f.headers });
    expect(descriptor.statusCode).toBe(200); expect(descriptor.json()).toEqual(f.record);
    const response = await f.app.inject({ url: `${f.base}/resources/${f.record.resources[0]!.sha256}`, headers: f.headers });
    expect(response.statusCode).toBe(200); expect(response.body).toBe("old"); expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("requires login and project access for both descriptor and byte reads", async () => {
    const f = await setup();
    await f.app.inject({ method: "POST", url: "/api/admin/users", headers: f.headers,
      payload: { username: "outsider", password: "fixture-password", role: "viewer", projectIds: ["foreign"] } });
    const login = await f.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "outsider", password: "fixture-password" } });
    expect(login.statusCode).toBe(200); const foreign = { authorization: `Bearer ${login.json().token}` };
    const read = vi.spyOn(f.objects, "read");
    for (const url of [f.base, `${f.base}/resources/${f.record.resources[0]!.sha256}`]) {
      expect((await f.app.inject({ url })).statusCode).toBe(401);
      expect((await f.app.inject({ url, headers: foreign })).statusCode).toBe(403);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects nonmember hashes and ambiguous version records without reading objects", async () => {
    const f = await setup(); const read = vi.spyOn(f.objects, "read");
    expect((await f.app.inject({ url: `${f.base}/resources/${"0".repeat(64)}`, headers: f.headers })).statusCode).toBe(404);
    await f.store.edit(document => { document.scenePublicationDependencies!.push(structuredClone(f.record)); });
    expect((await f.app.inject({ url: f.base, headers: f.headers })).statusCode).toBe(409);
    expect((await f.app.inject({ url: `${f.base}/resources/${f.record.resources[0]!.sha256}`, headers: f.headers })).statusCode).toBe(409);
    expect(read).not.toHaveBeenCalled();
  });

  it("retains old frozen version access after a newer legacy publish and refuses uncaptured versions", async () => {
    const f = await setup(); const source = f.store.getScene("default", "dependency")!;
    const current = await f.store.publishSceneSnapshot({ projectId: "default", sceneId: "dependency", expectedSnapshot: source,
      expectedPublication: f.store.getPublication("dependency"), publishedAt: "2026-09-16T00:00:00Z" });
    expect(current.status).toBe("published");
    expect((await f.app.inject({ url: f.base, headers: f.headers })).statusCode).toBe(200);
    expect((await f.app.inject({ url: f.base.replace(`/publications/${f.version}/`, `/publications/${f.version + 1}/`), headers: f.headers })).statusCode).toBe(409);
    expect((await f.app.inject({ url: `${f.base}/resources/${f.record.resources[0]!.sha256}`, headers: f.headers })).body).toBe("old");
  });

  it("never exposes private content keys through anonymous assets aliases", async () => {
    const f = await setup(); const key = f.record.resources[0]!.key, read = vi.spyOn(f.objects, "read");
    for (const alias of [key, key.replace("default/", "default/./"), key.replace("projects/", "projects//"), `./${key}`]) {
      expect((await f.app.inject({ url: `/assets/${alias}` })).statusCode, alias).toBe(404);
    }
    expect(read).not.toHaveBeenCalled();
  });
});
