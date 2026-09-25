import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { migrateSceneSnapshotV1, type ModelRecord, type SceneSnapshot } from "@bim-studio/contracts";
import { JsonStore } from "./jsonStore.js";
import { LocalObjectStore } from "./objects.js";
import { prepareNativeSceneCandidate } from "./prepareNativeSceneCandidate.js";
import type { NativeSceneCandidate } from "./nativeSceneCandidateCompiler.js";
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const compiled = { packageJson: "{}", evidence: {}, report: { status: "blocked" }, compilerSha256: "a".repeat(64) } as NativeSceneCandidate;
async function fixture() {
 const dataDir = await mkdtemp(path.join(tmpdir(), "prepare-native-")); directories.push(dataDir);
 const store = new JsonStore(dataDir); await store.init(); const objects = new LocalObjectStore(dataDir);
 const content = Buffer.from([1, 2, 3]), sourceKey = "projects/default/models/asset/model.glb";
 await mkdir(path.dirname(path.join(dataDir, sourceKey)), { recursive: true }); await writeFile(path.join(dataDir, sourceKey), content);
 await store.addModel("default", { id: "asset", projectId: "default", name: "Model", status: "ready", manifest: { geometryUrl: `/assets/${sourceKey}`, viewerKind: "glb", modelId: "asset" } } as ModelRecord);
 await store.addModel("default", { id: "unused", projectId: "default", name: "Unused", status: "ready", manifest: { geometryUrl: "/assets/projects/default/models/missing.glb", viewerKind: "glb", modelId: "unused" } } as ModelRecord);
 const object = (id: string) => ({ modelId: id, assetModelId: "asset", name: id, visible: true, opacity: 1,
 transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });
 const scene: SceneSnapshot = { schemaVersion: 1, id: "scene", projectId: "default", name: "Scene", models: [object("one"), object("two"), { ...object("hidden"), visible: false, assetModelId: "asset" }], primitives: [], measurements: [],
 camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } }, createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z" };
 await store.saveScene(scene);
 return { store, objects, dataDir, scene, content, sourceKey, key: `projects/default/publication-resources/sha256/${createHash("sha256").update(content).digest("hex")}` };
}
it("reads frozen bytes after source replacement, deduplicates visible assets and ignores unrelated models", async () => {
 const f = await fixture(); const originalRead = f.objects.read.bind(f.objects);
 vi.spyOn(f.objects, "read").mockImplementation(async key => {
  if (key.includes("publication-resources")) await writeFile(path.join(f.dataDir, f.sourceKey), "new source");
  return originalRead(key);
 });
 const compiler = vi.fn(async input => { expect([...input.models.keys()]).toEqual(["asset"]); expect(Buffer.from(input.models.get("asset")!)).toEqual(f.content); return compiled; });
 const result = await prepareNativeSceneCandidate(f, compiler);
 expect(result.compiled).toBe(compiled); expect(compiler).toHaveBeenCalledTimes(1);
 expect(result.capture.resources).toHaveLength(1);
});
it.each(["missing", "corrupt"])("rejects %s private resource before compilation", async kind => {
 const f = await fixture(), originalRead = f.objects.read.bind(f.objects);
 vi.spyOn(f.objects, "read").mockImplementation(async key => {
  if (key.includes("publication-resources")) {
   if (kind === "missing") await rm(path.join(f.dataDir, key), { force: true });
   else await writeFile(path.join(f.dataDir, key), new Uint8Array([9, 9, 9]));
  }
  return originalRead(key);
 });
 const compiler = vi.fn(async () => compiled); await expect(prepareNativeSceneCandidate(f, compiler)).rejects.toThrow(); expect(compiler).not.toHaveBeenCalled();
});
it.each(["scene", "project", "application"])("rejects %s changed while compiler is running", async kind => {
 const f = await fixture();
 const compiler = vi.fn(async () => {
  if (kind === "scene") await f.store.saveScene({ ...f.scene, name: "edited" });
  if (kind === "project") await f.store.updateProject("default", { name: "changed" });
  if (kind === "application") await f.store.createApplicationDraft("default", migrateSceneSnapshotV1(f.scene), f.scene.updatedAt);
  return compiled;
 });
 await expect(prepareNativeSceneCandidate(f, compiler)).rejects.toThrow(/已变化/);
});
it("cancels even after frozen stream ends while completed remains pending", async () => {
 const f = await fixture(), controller = new AbortController(), originalRead = f.objects.read.bind(f.objects);
 let end!: () => void; const ended = new Promise<void>(resolve => { end = resolve; });
 vi.spyOn(f.objects, "read").mockImplementation(async key => {
  if (!key.includes("publication-resources")) return originalRead(key);
  const stream = Readable.from([f.content]); stream.once("end", end);
  return { stream, completed: new Promise<void>(() => {}) };
 });
 const compiler = vi.fn(async () => compiled);
 const operation = prepareNativeSceneCandidate({ ...f, signal: controller.signal }, compiler);
 await ended; controller.abort(new Error("cancel completed wait"));
 await expect(operation).rejects.toThrow("cancel completed wait"); expect(compiler).not.toHaveBeenCalled();
});
it("rejects stale source before capture and cancellation before reads", async () => {
 const f = await fixture(), read = vi.spyOn(f.objects, "read"), compiler = vi.fn(async () => compiled);
 await expect(prepareNativeSceneCandidate({ ...f, scene: { ...f.scene, name: "unsaved" } }, compiler)).rejects.toThrow("已变化");
 await expect(prepareNativeSceneCandidate({ ...f, signal: AbortSignal.abort() }, compiler)).rejects.toThrow();
 expect(read).not.toHaveBeenCalled(); expect(compiler).not.toHaveBeenCalled();
});
it("loads persisted probe-bake candidates from disk and forwards gzip bytes to the compiler", async () => {
 // web 侧会话键函数（服务端不做投影复刻，键以浏览器计算结果透传存储）。
 const { probeGridBakeSourceHash } = await import("../../../apps/web/src/delivery/probeGridBakePublicationSession");
 const { storeProbeGridBakeDocument } = await import("./probeGridBakeStore.js");
 const { gunzipSync } = await import("node:zlib");
 const f = await fixture();
 const sourceHash = probeGridBakeSourceHash(f.scene);
 await storeProbeGridBakeDocument({ dataDir: f.dataDir, sceneId: f.scene.id,
   document: { sourceHash, bake: { origin: [0, 0, 0], spacing: 4, gridSize: [2, 2, 2], probes: [] }, probeCount: 0 } });
 const compiler = vi.fn(async () => compiled);
 await prepareNativeSceneCandidate(f, compiler);
 const input = compiler.mock.calls[0]![0]!;
 expect(input.probeBakeCandidates).toHaveLength(1);
 expect(input.probeBakeCandidates![0]!.sourceHash).toBe(sourceHash);
 expect(JSON.parse(gunzipSync(Buffer.from(input.probeBakeCandidates![0]!.gzip)).toString("utf8")).sourceHash).toBe(sourceHash);
 // 无持久化目录时不传候选键（语义=不带探针继续验证）。
 const empty = await fixture(), emptyCompiler = vi.fn(async () => compiled);
 await prepareNativeSceneCandidate(empty, emptyCompiler);
 expect(emptyCompiler.mock.calls[0]![0]!.probeBakeCandidates).toBeUndefined();
});

