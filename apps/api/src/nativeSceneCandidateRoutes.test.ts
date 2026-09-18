import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DatabaseDocument, SceneNativeCompiledPublication, SceneSnapshot } from "@bim-studio/contracts";
import { selectSceneClientDependencyInputs } from "@bim-studio/studio-core";
import { JsonStore } from "./jsonStore.js";
import { LocalObjectStore } from "./objects.js";
import { createApiServer } from "./serverOptions.js";
import { registerSystemRoutes } from "./system.js";
import { registerSceneRoutes } from "./sceneRoutes.js";
import { createNativeSceneCandidateRegistry } from "./nativeSceneCandidateRegistry.js";
import type { NativeSceneCandidateService } from "./nativeSceneCandidateRoutes.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
class Store extends JsonStore {
  fail = false;
  nextWrite?: { entered: () => void; gate: Promise<void> };
  protected override async persistDocument(document: DatabaseDocument) {
    const next = this.nextWrite; this.nextWrite = undefined;
    if (next) { next.entered(); await next.gate; }
    if (this.fail) throw new Error("disk failure"); await super.persistDocument(document);
  }
}
const time = "2026-09-15T00:00:00Z", bytes = "HTTP fixture runtime";
// Synthetic evidence exercises HTTP ownership/transactions only; no window verification is claimed.
function compiled(): SceneNativeCompiledPublication {
  const source = "a".repeat(64), graph = "b".repeat(64), artifact = createHash("sha256").update(bytes).digest("hex"), fixtureId = `scene-${source}`;
  const capabilities = ["deep.scene.runtime.v1", "deep.scene.camera.v1"];
  return { runtimePackage: { key: `projects/default/publication-resources/sha256/${artifact}`, bytes: Buffer.byteLength(bytes), sha256: artifact },
    compilationEvidence: { sourceSemanticHash: source, compileGraphHash: graph, targetArtifactHash: artifact },
    compilerSha256: "d".repeat(64), executableSha256: "e".repeat(64), verifiedAt: time,
    compatibilityReport: { schemaVersion: 1, target: "deep-native", sceneId: "scene", status: "ready", platform: "windows-x64", fixtureId,
      contentFingerprint: source, compileGraphHash: graph, targetArtifactHash: artifact, capabilityProfileVersion: "deep-scene-compiled-v1",
      items: capabilities.map((capability, index) => ({ sceneId: "scene", objectId: "scene", path: index ? "camera" : "$", capability,
        status: "supported", reason: "Fixture", remediation: "Verify", evidenceIds: [capability] })),
      evidence: capabilities.map(capability => ({ id: capability, capability, target: "deep-native", scope: "native-window", platform: "windows-x64",
        fixtureId, sourceSemanticHash: source, compileGraphHash: graph, targetArtifactHash: artifact })) } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(configured = true, hooks?: { closed: () => void; failed: () => void }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "native-http-")); cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const store = new Store(dataDir); await store.init(); const objects = new LocalObjectStore(dataDir);
  const scene: SceneSnapshot = { schemaVersion: 1, id: "scene", projectId: "default", name: "Scene", models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } }, createdAt: time, updatedAt: time };
  await store.saveScene(scene); const nativeCompiled = compiled();
  await mkdir(path.dirname(path.join(dataDir, nativeCompiled.runtimePackage.key)), { recursive: true });
  await writeFile(path.join(dataDir, nativeCompiled.runtimePackage.key), bytes);
  let now = Date.parse(time); const registry = createNativeSceneCandidateRegistry(() => now);
  const prepare = vi.fn<NativeSceneCandidateService["prepare"]>(async (actorId, source) => ({ status: "ready",
    ...registry.register({ actorId, scene: source, expectedPublication: store.getPublication(source.id), capture: {
      inputs: selectSceneClientDependencyInputs(store.getProject(source.projectId)!, source, []), resources: [], nativeCompiled } }),
    report: nativeCompiled.compatibilityReport }));
  const service: NativeSceneCandidateService = { prepare, reserve: registry.reserve }, stop = vi.fn().mockResolvedValue(undefined);
  const app = createApiServer(); cleanups.push(() => app.close());
  if (hooks) {
    app.addHook("onRequest", async (_request, reply) => { reply.raw.once("close", hooks.closed); });
    app.addHook("onError", async () => { hooks.failed(); });
  }
  await registerSystemRoutes(app, store, dataDir);
  await registerSceneRoutes(app, { store, deliveryStorage: { objects, dataDir }, ...(configured ? { nativeCandidates: service } : {}), beforeDiscardPublication: stop });
  const login = async (username: string, password = "fixture-password") => {
    const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    expect(response.statusCode).toBe(200); return { authorization: `Bearer ${response.json().token}` };
  };
  const headers = await login("admin", "admin"), base = "/api/projects/default/scenes/scene";
  const user = async (username: string, role: string, projectIds = ["default"]) => {
    expect((await app.inject({ method: "POST", url: "/api/admin/users", headers, payload: { username, password: "fixture-password", role, projectIds } })).statusCode).toBe(201);
    return login(username);
  };
  const candidate = async () => { const response = await app.inject({ method: "POST", url: `${base}/native-candidates`, headers, payload: { expectedSnapshot: scene } });
    expect(response.statusCode).toBe(200); return response.json().candidateId as string; };
  const publish = (nativeCandidateId?: string, as = headers, expectedSnapshot = store.getScene("default", "scene")!) =>
    app.inject({ method: "POST", url: `${base}/publish`, headers: as, payload: { expectedSnapshot, clientTarget: "deep-native", nativeCandidateId } });
  return { app, store, objects, dataDir, scene, nativeCompiled, prepare, stop, headers, base, user, candidate, publish, expire: () => { now += 600_001; } };
}

it("enforces anonymous, viewer and foreign project authorization before candidate preparation", async () => {
  const f = await fixture(), viewer = await f.user("viewer", "viewer"), foreign = await f.user("foreign", "editor", ["foreign"]);
  for (const suffix of ["native-candidates", "publish"]) for (const [headers, status] of [[undefined, 401], [viewer, 403], [foreign, 403]] as const) {
    expect((await f.app.inject({ method: "POST", url: `${f.base}/${suffix}`, headers, payload: { expectedSnapshot: f.scene, clientTarget: "deep-native" } })).statusCode).toBe(status);
  }
  expect(f.prepare).not.toHaveBeenCalled();
});
it.each(["executable", "executablePath", "evidence", "nativeCompiled"])("rejects client-owned %s before preparation", async field => {
  const f = await fixture(); expect((await f.app.inject({ method: "POST", url: `${f.base}/native-candidates`, headers: f.headers,
    payload: { expectedSnapshot: f.scene, [field]: "untrusted" } })).statusCode).toBe(400); expect(f.prepare).not.toHaveBeenCalled();
});
it("returns unconfigured and missing-candidate errors without publishing", async () => {
  const f = await fixture(false);
  expect((await f.app.inject({ method: "POST", url: `${f.base}/native-candidates`, headers: f.headers, payload: { expectedSnapshot: f.scene } })).statusCode).toBe(503);
  expect((await f.publish()).statusCode).toBe(400); expect((await f.publish("unknown")).statusCode).toBe(503);
  expect(f.store.getPublication("scene")).toBeUndefined();
});
it("returns blocked diagnostics without creating a publication", async () => {
  const f = await fixture(); f.prepare.mockResolvedValueOnce({ status: "blocked", report: { ...f.nativeCompiled.compatibilityReport, status: "blocked" } });
  const response = await f.app.inject({ method: "POST", url: `${f.base}/native-candidates`, headers: f.headers, payload: { expectedSnapshot: f.scene } });
  expect(response.json()).toMatchObject({ status: "blocked" }); expect(response.json().candidateId).toBeUndefined();
  expect(f.store.getPublication("scene")).toBeUndefined();
});
it("rejects another actor and expired candidate without consuming the owner's valid candidate", async () => {
  const f = await fixture(), id = await f.candidate(), other = await f.user("other", "editor");
  expect((await f.publish(id, other)).statusCode).toBe(409); f.expire(); expect((await f.publish(id)).statusCode).toBe(409);
  expect(f.store.getPublication("scene")).toBeUndefined();
});
it("publishes server bytes privately and consumes the original opaque ID", async () => {
  const f = await fixture(), id = await f.candidate(), read = vi.spyOn(f.objects, "read"); const response = await f.publish(id);
  expect(response.statusCode).toBe(201); expect(read).not.toHaveBeenCalled();
  const record = f.store.getScenePublicationDependencies("default", "scene", response.json().version)!;
  expect(record.nativeCompiled).toEqual(f.nativeCompiled);
  const url = `${f.base}/publications/${response.json().version}/dependencies/resources/${f.nativeCompiled.runtimePackage.sha256}`;
  expect((await f.app.inject({ url })).statusCode).toBe(401);
  const loaded = await f.app.inject({ url, headers: f.headers }); expect(loaded.body).toBe(bytes); expect(loaded.headers["cache-control"]).toBe("private, no-store");
  expect((await f.publish(id)).statusCode).toBe(409);
  const reload = new JsonStore(f.dataDir); await reload.init(); expect(reload.getScenePublicationDependencies("default", "scene", response.json().version)).toEqual(record);
});
it("allows only one concurrent lease and commits exactly once", async () => {
  const f = await fixture(), id = await f.candidate(), entered = deferred(), release = deferred(), original = f.store.publishSceneSnapshot.bind(f.store);
  const commit = vi.spyOn(f.store, "publishSceneSnapshot").mockImplementationOnce(async input => { entered.resolve(); await release.promise; return original(input); });
  const first = f.publish(id).then(value => value); await entered.promise;
  expect((await f.publish(id)).statusCode).toBe(409); release.resolve(); expect((await first).statusCode).toBe(201); expect(commit).toHaveBeenCalledTimes(1);
});
it("releases a failed transaction so the same candidate can be retried", async () => {
  const f = await fixture(), id = await f.candidate(); f.store.fail = true;
  expect((await f.publish(id)).statusCode).toBe(500); expect(f.store.getPublication("scene")).toBeUndefined();
  f.store.fail = false; expect((await f.publish(id)).statusCode).toBe(201);
});
it.each(["scene", "dependencies", "publication"])("rejects %s changes after validation", async kind => {
  const f = await fixture(), id = await f.candidate();
  if (kind === "scene") await f.store.saveScene({ ...f.scene, name: "Changed" });
  if (kind === "dependencies") await f.store.updateProject("default", { name: "Changed" });
  if (kind === "publication") await f.store.savePublication({ projectId: "default", sceneId: "scene", name: "New", snapshot: f.scene, publishedAt: time });
  expect((await f.publish(id)).statusCode).toBe(409); expect(f.stop).not.toHaveBeenCalled();
  expect(f.store.getScenePublicationDependencies("default", "scene", 1)).toBeUndefined();
});
it("aborts candidate preparation when a real HTTP connection disconnects", async () => {
  const f = await fixture(), entered = deferred(), aborted = deferred();
  f.prepare.mockImplementationOnce(async (_actor, _scene, signal) => { entered.resolve(); return new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => { aborted.resolve(); reject(signal!.reason); }, { once: true });
  }); });
  const address = await f.app.listen({ port: 0, host: "127.0.0.1" });
  const request = httpRequest(`${address}${f.base}/native-candidates`, { method: "POST", headers: { ...f.headers, "content-type": "application/json" } });
  request.on("error", () => undefined); request.end(JSON.stringify({ expectedSnapshot: f.scene }));
  await entered.promise; request.destroy(); await aborted.promise; expect(f.store.getPublication("scene")).toBeUndefined();
});
it("releases the Native publication lease after disconnect during worker shutdown", async () => {
  const entered = deferred(), release = deferred(), disconnected = deferred(), failed = deferred();
  let watch = false;
  const f = await fixture(true, { closed: () => { if (watch) disconnected.resolve(); }, failed: failed.resolve });
  await f.store.savePublication({ projectId: "default", sceneId: "scene", name: "Old", snapshot: f.scene, publishedAt: time });
  const id = await f.candidate(); watch = true;
  f.stop.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
  const commit = vi.spyOn(f.store, "publishSceneSnapshot"), address = await f.app.listen({ port: 0, host: "127.0.0.1" });
  const request = httpRequest(`${address}${f.base}/publish`, { method: "POST", headers: { ...f.headers, "content-type": "application/json" } });
  request.on("error", () => undefined); request.end(JSON.stringify({ expectedSnapshot: f.scene, clientTarget: "deep-native", nativeCandidateId: id }));
  await entered.promise; request.destroy(); await disconnected.promise; release.resolve(); await failed.promise;
  expect(commit).not.toHaveBeenCalled(); expect(f.store.getPublication("scene")?.name).toBe("Old");
  expect((await f.publish(id)).statusCode).toBe(201);
});
it.each(["scene", "dependencies", "publication"])("rechecks %s inside the publication transaction after a lease is acquired", async kind => {
  const f = await fixture();
  await f.store.savePublication({ projectId: "default", sceneId: "scene", name: "Old", snapshot: f.scene, publishedAt: time });
  const id = await f.candidate();
  f.stop.mockImplementationOnce(async () => {
    if (kind === "scene") await f.store.saveScene({ ...f.scene, name: "Concurrent" });
    if (kind === "dependencies") await f.store.updateProject("default", { name: "Concurrent" });
    if (kind === "publication") await f.store.savePublication({ projectId: "default", sceneId: "scene", name: "Concurrent", snapshot: f.scene, publishedAt: time });
  });
  expect((await f.publish(id)).statusCode).toBe(409);
  expect(f.store.getScenePublicationDependencies("default", "scene", 2)).toBeUndefined();
  expect(f.store.getPublication("scene")?.name).toBe(kind === "publication" ? "Concurrent" : "Old");
});
it("cancels a queued Native publication after socket disconnect and releases its lease", async () => {
  const disconnected = deferred(), failed = deferred(); let watch = false;
  const f = await fixture(true, { closed: () => { if (watch) disconnected.resolve(); }, failed: failed.resolve });
  const id = await f.candidate(), entered = deferred(), release = deferred(), queued = deferred();
  f.store.nextWrite = { entered: entered.resolve, gate: release.promise };
  const blocker = f.store.updateProject("default", { name: f.store.getProject("default")!.name }); await entered.promise;
  const original = f.store.publishSceneSnapshot.bind(f.store);
  vi.spyOn(f.store, "publishSceneSnapshot").mockImplementationOnce((input, options) => { const result = original(input, options); queued.resolve(); return result; });
  const address = await f.app.listen({ port: 0, host: "127.0.0.1" }); watch = true;
  const request = httpRequest(`${address}${f.base}/publish`, { method: "POST", headers: { ...f.headers, "content-type": "application/json" } });
  request.on("error", () => undefined); request.end(JSON.stringify({ expectedSnapshot: f.scene, clientTarget: "deep-native", nativeCandidateId: id }));
  await queued.promise; request.destroy(); await disconnected.promise; release.resolve(); await blocker; await failed.promise;
  expect(f.store.getPublication("scene")).toBeUndefined();
  expect((await f.publish(id)).statusCode).toBe(201);
});
it.each(["abort", "timeout"])("rejects %s while publication waits in the storage queue", async reason => {
  const f = await fixture(), entered = deferred(), release = deferred(), controller = new AbortController();
  f.store.nextWrite = { entered: entered.resolve, gate: release.promise };
  const blocker = f.store.updateProject("default", { name: f.store.getProject("default")!.name }); await entered.promise;
  const signal = reason === "timeout" ? AbortSignal.timeout(10) : controller.signal;
  const pending = f.store.publishSceneSnapshot({ projectId: "default", sceneId: "scene", expectedSnapshot: f.scene, expectedPublication: undefined, publishedAt: time }, { signal });
  const checked = expect(pending).rejects.toMatchObject({ name: reason === "timeout" ? "TimeoutError" : "AbortError" });
  if (reason === "abort") controller.abort(); else await new Promise<void>(done => signal.addEventListener("abort", () => done(), { once: true }));
  release.resolve(); await blocker; await checked; expect(f.store.getPublication("scene")).toBeUndefined();
});
it("finishes persistence consistently when cancellation arrives after writing has started", async () => {
  const f = await fixture(), entered = deferred(), release = deferred(), controller = new AbortController();
  f.store.nextWrite = { entered: entered.resolve, gate: release.promise };
  const pending = f.store.publishSceneSnapshot({ projectId: "default", sceneId: "scene", expectedSnapshot: f.scene, expectedPublication: undefined, publishedAt: time }, { signal: controller.signal });
  await entered.promise; controller.abort(); release.resolve(); expect((await pending).status).toBe("published");
  const reloaded = new JsonStore(f.dataDir); await reloaded.init(); expect(reloaded.getPublication("scene")).toEqual(f.store.getPublication("scene"));
});
