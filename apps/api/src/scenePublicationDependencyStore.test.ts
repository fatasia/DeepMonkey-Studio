import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { DatabaseDocument, SceneNativeCompiledPublication, SceneSnapshot } from "@bim-studio/contracts";
import { selectSceneClientDependencyInputs } from "@bim-studio/studio-core";
import { JsonStore } from "./jsonStore.js";
import { assertCapturedSceneDependencies, readScenePublicationDependencies } from "./scenePublicationDependencyStore.js";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const time = "2026-09-15T10:00:00.000Z";
// 仅验证存储绑定的合成证据，不是实际 Native 窗口验证结果。
function nativeCompiled(): SceneNativeCompiledPublication {
  const source = "a".repeat(64), graph = "b".repeat(64), artifact = "c".repeat(64), fixtureId = `scene-${source}`;
  const capabilities = ["deep.scene.runtime.v1", "deep.scene.camera.v1", "deep.scene.dynamic-runtime.v1"];
  const executable = "e".repeat(64);
  return { runtimePackage: { key: `projects/default/publication-resources/sha256/${artifact}`, bytes: 100, sha256: artifact },
    executable: { key: `projects/default/publication-resources/sha256/${executable}`, bytes: 1024, sha256: executable },
    compilationEvidence: { sourceSemanticHash: source, compileGraphHash: graph, targetArtifactHash: artifact },
    compilerSha256: "d".repeat(64), executableSha256: executable, verifiedAt: time,
    compatibilityReport: { schemaVersion: 1, target: "deep-native", sceneId: "scene-1", status: "ready",
      platform: "windows-x64", fixtureId, contentFingerprint: source, compileGraphHash: graph, targetArtifactHash: artifact,
      capabilityProfileVersion: "deep-scene-compiled-v1",
      items: capabilities.map((capability, index) => ({ sceneId: "scene-1", objectId: "scene-1", path: index === 0 ? "$" : index === 1 ? "camera" : "animation",
        capability, status: "supported", reason: "测试证据", remediation: "重新验证", evidenceIds: [capability] })),
      evidence: capabilities.map(capability => ({ id: capability, capability, target: "deep-native", scope: "native-window",
        fixtureId, platform: "windows-x64", sourceSemanticHash: source, compileGraphHash: graph, targetArtifactHash: artifact })) } };
}
class Store extends JsonStore {
  fail = false;
  protected override async persistDocument(doc: DatabaseDocument) { if (this.fail) throw new Error("disk failure"); await super.persistDocument(doc); }
  raw() { return this.document; }
}
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "dependency-store-")); dirs.push(dir);
  const store = new Store(dir); await store.init();
  const scene: SceneSnapshot = { schemaVersion: 1, id: "scene-1", projectId: "default", name: "test", models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } }, createdAt: time, updatedAt: time };
  await store.saveScene(scene);
  const capture = { inputs: selectSceneClientDependencyInputs(store.getProject("default")!, scene, []), resources: [] };
  const request = { projectId: "default", sceneId: scene.id, expectedSnapshot: scene, expectedPublication: undefined, publishedAt: time, dependencyCapture: capture };
  return { store, dir, scene, capture, request };
}
it("persists exact dependency identity, clones reads and restores the original inputs", async () => {
  const { store, dir, request } = await fixture();
  const result = await store.publishSceneSnapshot(request); expect(result.status).toBe("published");
  const original = store.getScenePublicationDependencies("default", "scene-1", 1)!;
  original.inputs.project.name = "mutated";
  const reload = new JsonStore(dir); await reload.init();
  expect(reload.getScenePublicationDependencies("default", "scene-1", 1)!.inputs.project.name).not.toBe("mutated");
  await store.updateProject("default", { name: "new project" });
  const historical = store.getPublication("scene-1")!;
  const restored = await store.restoreScenePublication({ projectId: "default", sceneId: "scene-1", expectedSnapshot: store.getScene("default", "scene-1")!,
    expectedPublication: historical, historicalPublication: historical, publishedAt: "2026-09-15T11:00:00.000Z" });
  expect(restored.status).toBe("restored");
  const next = store.getScenePublicationDependencies("default", "scene-1", 2)!;
  expect(next.inputs).toEqual(request.dependencyCapture.inputs);
  expect(next.publicationIdentity).not.toBe(original.publicationIdentity);
});
it("rejects metadata races and never publishes after a failed write", async () => {
  const { store, request } = await fixture();
  await store.updateProject("default", { name: "changed" });
  expect(await store.publishSceneSnapshot(request)).toEqual({ status: "dependency-conflict" });
  expect(store.getPublication("scene-1")).toBeUndefined();
  request.dependencyCapture.inputs.project.name = "changed"; store.fail = true;
  await expect(store.publishSceneSnapshot(request)).rejects.toThrow("disk failure");
  expect(store.getScenePublicationDependencies("default", "scene-1", 1)).toBeUndefined();
});
it("rejects duplicate, mismatched identities on read and restore", async () => {
  const { store, request } = await fixture(); await store.publishSceneSnapshot(request);
  const row = store.raw().scenePublicationDependencies![0]!;
  store.raw().scenePublicationDependencies!.push(structuredClone(row));
  expect(() => store.getScenePublicationDependencies("default", "scene-1", 1)).toThrow();
  const publication = store.getPublication("scene-1")!;
  expect((await store.restoreScenePublication({ ...request, expectedSnapshot: publication.snapshot, expectedPublication: publication, historicalPublication: publication })).status).toBe("history-conflict");
  store.raw().scenePublicationDependencies!.pop(); row.publicationIdentity = "0".repeat(64);
  expect(() => readScenePublicationDependencies(store.raw(), "default", "scene-1", 1)).toThrow();
});
it("keeps legacy publication dependencies absent and clears scene/project records", async () => {
  const { store, request } = await fixture(); await store.publishSceneSnapshot(request);
  await store.removePublication("scene-1"); expect(store.getScenePublicationDependencies("default", "scene-1", 1)).toBeDefined();
  await store.removeScene("default", "scene-1"); expect(store.raw().scenePublicationDependencies).toEqual([]);
  await store.saveScene(request.expectedSnapshot); await store.publishSceneSnapshot(request);
  await store.removeProject("default"); expect(store.raw().scenePublicationDependencies).toEqual([]);
});
it("checks exact URL membership, key, bytes and integrity claims", async () => {
  const { capture } = await fixture(); const sha256 = "a".repeat(64);
  capture.inputs.resources.push({ id: "a", name: "a", url: "/assets/a", claims: [{ bytes: 2, sha256, integrity: `sha256-${Buffer.from(sha256, "hex").toString("base64")}` }] });
  const resource = { sourceUrl: "/assets/a", key: `projects/default/publication-resources/sha256/${sha256}`, bytes: 2, sha256 };
  const valid = { ...capture, resources: [resource] }; expect(() => assertCapturedSceneDependencies("default", valid)).not.toThrow();
  for (const altered of [{ ...resource, bytes: 3 }, { ...resource, sourceUrl: "/assets/b" }, { ...resource, key: "projects/other/a" }, { ...resource, sha256: "A".repeat(64) }]) {
    expect(() => assertCapturedSceneDependencies("default", { ...capture, resources: [altered] })).toThrow();
  }
  expect(() => assertCapturedSceneDependencies("default", { ...capture, resources: [resource, resource] })).toThrow();
});

it("retains dependencies only for retained versions and keeps legacy restore unfrozen", async () => {
  const { store, request } = await fixture();
  for (let i = 0; i < 52; i++) {
    const source = store.getScene("default", "scene-1")!;
    const inputs = selectSceneClientDependencyInputs(store.getProject("default")!, source, []);
    const result = await store.publishSceneSnapshot({ ...request, expectedSnapshot: source, expectedPublication: store.getPublication("scene-1"),
      publishedAt: new Date(Date.parse(time) + i * 1000).toISOString(), dependencyCapture: { inputs, resources: [] } });
    expect(result.status).toBe("published");
  }
  expect(store.raw().scenePublicationDependencies).toHaveLength(50);
  expect(store.getScenePublicationDependencies("default", "scene-1", 1)).toBeUndefined();
  expect(store.getScenePublicationDependencies("default", "scene-1", 52)).toBeDefined();
  const legacy = await store.savePublication({ projectId: "default", sceneId: "scene-1", name: "legacy", snapshot: request.expectedSnapshot, publishedAt: "2026-09-15T12:00:00.000Z" });
  const result = await store.restoreScenePublication({ ...request, expectedSnapshot: store.getScene("default", "scene-1")!, expectedPublication: legacy,
    historicalPublication: legacy, publishedAt: "2026-09-15T13:00:00.000Z" });
  expect(result.status).toBe("restored");
  if (result.status === "restored") expect(store.getScenePublicationDependencies("default", "scene-1", result.publication.version!)).toBeUndefined();
});

it("persists Native artifact pointers across restart and restore without exposing mutable records", async () => {
  const { store, dir, request } = await fixture();
  const native = nativeCompiled(), expected = structuredClone(native);
  const result = await store.publishSceneSnapshot({ ...request, dependencyCapture: { ...request.dependencyCapture, nativeCompiled: native } });
  expect(result.status).toBe("published"); native.runtimePackage.bytes = 200;
  const reload = new JsonStore(dir); await reload.init();
  const read = reload.getScenePublicationDependencies("default", "scene-1", 1)!;
  expect(read.nativeCompiled).toEqual(expected);
  read.nativeCompiled!.runtimePackage.bytes = 300;
  expect(reload.getScenePublicationDependencies("default", "scene-1", 1)!.nativeCompiled).toEqual(expected);
  const publication = reload.getPublication("scene-1")!;
  const restored = await reload.restoreScenePublication({ ...request, expectedSnapshot: publication.snapshot,
    expectedPublication: publication, historicalPublication: publication, publishedAt: "2026-09-15T12:00:00.000Z" });
  expect(restored.status).toBe("restored");
  expect(reload.getScenePublicationDependencies("default", "scene-1", 2)!.nativeCompiled).toEqual(expected);
  expect(reload.getScenePublicationDependencies("default", "scene-1", 1)!.nativeCompiled).toEqual(expected);
  await reload.removeScene("default", "scene-1");
  expect(reload.getScenePublicationDependencies("default", "scene-1", 2)).toBeUndefined();
});

it.each(["foreign-key", "bad-runtime-hash", "empty-bytes", "oversize", "bad-compiler", "bad-executable", "foreign-executable-key", "mismatched-executable-hash", "bad-date",
  "foreign-scene", "wrong-target", "blocked", "wrong-platform", "source", "graph", "artifact", "fixture", "missing-proof", "forged-proof", "extra-proof", "missing-camera"])
  ("rejects Native identity corruption before committing: %s", async failure => {
    const { store, request } = await fixture(), native = nativeCompiled();
    if (failure === "foreign-key") native.runtimePackage.key = native.runtimePackage.key.replace("default", "other");
    if (failure === "bad-runtime-hash") native.runtimePackage.sha256 = "f".repeat(64);
    if (failure === "empty-bytes") native.runtimePackage.bytes = 0;
    if (failure === "oversize") native.runtimePackage.bytes = 256 * 1024 ** 2 + 1;
    if (failure === "bad-compiler") native.compilerSha256 = "invalid";
    if (failure === "bad-executable") native.executableSha256 = "E".repeat(64);
    if (failure === "foreign-executable-key") native.executable!.key = native.executable!.key.replace("default", "other");
    if (failure === "mismatched-executable-hash") native.executable!.sha256 = "f".repeat(64);
    if (failure === "bad-date") native.verifiedAt = "invalid";
    const changes: Record<string, object> = { "foreign-scene": { sceneId: "other" }, "wrong-target": { target: "three-webview" },
      blocked: { status: "blocked" }, "wrong-platform": { platform: "linux" }, source: { contentFingerprint: "f".repeat(64) },
      graph: { compileGraphHash: "f".repeat(64) }, artifact: { targetArtifactHash: "f".repeat(64) }, fixture: { fixtureId: "other" },
      "missing-proof": { evidence: [] }, "forged-proof": { evidence: native.compatibilityReport.evidence.map(proof => ({ ...proof, scope: "static-render-packet" })) },
      "extra-proof": { evidence: [...native.compatibilityReport.evidence, { ...native.compatibilityReport.evidence[0], id: "unused", targetArtifactHash: "f".repeat(64) }] },
      "missing-camera": { items: native.compatibilityReport.items.slice(0, 1) } };
    Object.assign(native.compatibilityReport, changes[failure]);
    await expect(store.publishSceneSnapshot({ ...request, dependencyCapture: { ...request.dependencyCapture, nativeCompiled: native } })).rejects.toThrow(/Native/);
    expect(store.getPublication("scene-1")).toBeUndefined();
    expect(store.getScenePublicationDependencies("default", "scene-1", 1)).toBeUndefined();
  });

it("rejects a corrupted stored Native report on read and historical restore", async () => {
  const { store, request } = await fixture();
  await store.publishSceneSnapshot({ ...request, dependencyCapture: { ...request.dependencyCapture, nativeCompiled: nativeCompiled() } });
  const publication = store.getPublication("scene-1")!;
  store.raw().scenePublicationDependencies![0]!.nativeCompiled!.compilationEvidence.targetArtifactHash = "f".repeat(64);
  expect(() => store.getScenePublicationDependencies("default", "scene-1", 1)).toThrow(/Native/);
  expect((await store.restoreScenePublication({ ...request, expectedSnapshot: publication.snapshot,
    expectedPublication: publication, historicalPublication: publication })).status).toBe("history-conflict");
  expect(store.getPublication("scene-1")).toEqual(publication);
});

it("rolls back both Native metadata and publication when persistence fails", async () => {
  const { store, request } = await fixture(); store.fail = true;
  await expect(store.publishSceneSnapshot({ ...request, dependencyCapture: { ...request.dependencyCapture, nativeCompiled: nativeCompiled() } })).rejects.toThrow("disk failure");
  expect(store.getPublication("scene-1")).toBeUndefined();
  expect(store.getScenePublicationDependencies("default", "scene-1", 1)).toBeUndefined();
});

it("rejects null Native metadata instead of silently treating corrupted data as legacy", async () => {
  const { capture } = await fixture();
  expect(() => assertCapturedSceneDependencies("default", { ...capture, nativeCompiled: null as unknown as SceneNativeCompiledPublication })).toThrow(/Native/);
});
