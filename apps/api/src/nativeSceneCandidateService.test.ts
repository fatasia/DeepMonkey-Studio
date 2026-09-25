import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { summarizeScenePublicationCompatibility, type SceneSnapshot } from "@bim-studio/contracts";
import { selectSceneClientDependencyInputs } from "@bim-studio/studio-core";
import { JsonStore } from "./jsonStore.js";
import { LocalObjectStore } from "./objects.js";
import { createNativeSceneCandidateService } from "./nativeSceneCandidateService.js";
import type { NativeSceneWindowEvidence } from "./nativeSceneWindowVerifier.js";
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
 const dataDir = await mkdtemp(path.join(tmpdir(), "native-service-")); directories.push(dataDir); const store = new JsonStore(dataDir); await store.init();
 const at = "2026-09-15T00:00:00Z", digest = "a".repeat(64), packageJson = "{}", artifact = createHash("sha256").update(packageJson).digest("hex");
 const scene: SceneSnapshot = { schemaVersion: 1, projectId: "default", id: "s", name: "s", models: [], primitives: [], measurements: [],
 camera: { mode: "orbit", position: { x: 0, y: 1, z: 2 }, target: { x: 0, y: 0, z: 0 } }, createdAt: at, updatedAt: at };
 await store.saveScene(scene); const capabilities = ["deep.scene.runtime.v1", "deep.scene.camera.v1"];
 // 测试专用收据，只验证服务编排。
 const report = summarizeScenePublicationCompatibility({ target: "deep-native", sceneId: "s", contentFingerprint: digest, compileGraphHash: digest,
 targetArtifactHash: artifact, fixtureId: `scene-${digest}`, platform: "windows-x64", profile: { version: "deep-scene-compiled-v1", capabilities },
 evidence: capabilities.map(capability => ({ id: capability, capability, target: "deep-native", scope: "native-window", sourceSemanticHash: digest, compileGraphHash: digest,
 targetArtifactHash: artifact, fixtureId: `scene-${digest}`, platform: "windows-x64" })),
 items: capabilities.map((capability, index) => ({ sceneId: "s", objectId: "s", path: index ? "camera" : "$", capability, status: "supported", reason: "test", remediation: "test", evidenceIds: [capability] })) });
 const capture = { inputs: selectSceneClientDependencyInputs(store.getProject("default")!, scene, []), resources: [] };
 const compiled = { packageJson, evidence: { sourceSemanticHash: digest, compileGraphHash: digest, targetArtifactHash: artifact }, compilerSha256: digest, report };
 const prepare = vi.fn(async () => ({ scene, capture, compiled })); const assess = vi.fn(async () => report);
 const executableBytes = Buffer.alloc(128); executableBytes.write("MZ", 0, "ascii"); executableBytes.writeUInt32LE(64, 0x3c); executableBytes.write("PE\0\0", 64, "ascii");
 const executableSha256 = createHash("sha256").update(executableBytes).digest("hex");
 const nativeExecutable = path.join(dataDir, "verified-player.exe"); await writeFile(nativeExecutable, executableBytes);
 const verifyWindow = vi.fn(async (file: string) => { expect((await readFile(file)).toString()).toBe(packageJson);
 return { sourceSha256: artifact, scope: "native-window", nonce: "test", executableSha256, verifiedAt: at, report: { gpuErrorsClean: true } } as NativeSceneWindowEvidence; });
 const service = createNativeSceneCandidateService({ store, objects: new LocalObjectStore(dataDir), dataDir, nativeExecutable, prepare, assess, verifyWindow });
 return { dataDir, store, scene, compiled, report, capture, prepare, assess, verifyWindow, service, artifact, executableBytes, executableSha256 };
}
it("stores private compiled bytes and supports reserve/release/commit with one-use identity", async () => {
 const f = await fixture(); const result = await f.service.prepare("user", f.scene); expect(result.status).toBe("ready");
 if (result.status !== "ready") throw new Error("missing candidate");
 const lease = f.service.reserve(result.candidateId, "user", f.scene), native = lease.value.capture.nativeCompiled!;
 expect(createHash("sha256").update(await readFile(path.join(f.dataDir, native.runtimePackage.key))).digest("hex")).toBe(f.artifact);
 expect(native.executable).toMatchObject({ bytes: f.executableBytes.length, sha256: f.executableSha256 });
 expect(await readFile(path.join(f.dataDir, native.executable!.key))).toEqual(f.executableBytes);
 lease.release(); f.service.reserve(result.candidateId, "user", f.scene).commit();
 expect(() => f.service.reserve(result.candidateId, "user", f.scene)).toThrow();
 await expect(stat(path.dirname(f.verifyWindow.mock.lastCall![0]))).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["window", "receipt", "scene", "project", "publication", "assess"])("cleans and releases running after %s failure", async mode => {
 const f = await fixture(), normal = f.verifyWindow.getMockImplementation()!;
 f.verifyWindow.mockImplementationOnce(async file => {
  if (mode === "window") throw new Error("window failure");
  const result = await normal(file);
  if (mode === "receipt") result.sourceSha256 = "0".repeat(64);
  if (mode === "scene") await f.store.saveScene({ ...f.scene, name: "changed" });
  if (mode === "project") await f.store.updateProject("default", { name: "changed" });
  if (mode === "publication") await f.store.savePublication({ sceneId: f.scene.id, projectId: f.scene.projectId, name: f.scene.name, snapshot: f.scene, publishedAt: f.scene.updatedAt });
  return result;
 });
 if (mode === "assess") f.assess.mockRejectedValueOnce(new Error("assessment failed"));
 await expect(f.service.prepare("user", f.scene)).rejects.toThrow();
 await expect(stat(path.dirname(f.verifyWindow.mock.lastCall![0]))).rejects.toMatchObject({ code: "ENOENT" });
 f.prepare.mockRejectedValueOnce(new Error("slot released")); await expect(f.service.prepare("user", f.scene)).rejects.toThrow("slot released");
});
it("packages optional uncompiled fields after the real window evidence", async () => {
 const f = await fixture(); f.compiled.report.items.push({ sceneId: "s", objectId: "s", path: "postProcessing",
   capability: "deep.scene.uncompiled.v1", status: "degraded", reason: "可选后处理未接入", remediation: "补齐后处理能力", evidenceIds: [] });
 const result = await f.service.prepare("user", f.scene);
 expect(result.status).toBe("ready"); expect(result.report?.status).toBe("ready"); expect(f.verifyWindow).toHaveBeenCalledOnce();
 expect((await f.service.prepare("user", f.scene)).status).toBe("ready");
});
it("rejects concurrent work and cancellation cannot create a candidate", async () => {
 const f = await fixture(), controller = new AbortController(); let release!: () => void;
 let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
 const normal = f.verifyWindow.getMockImplementation()!;
 f.verifyWindow.mockImplementationOnce(async file => { started(); await new Promise<void>(resolve => { release = resolve; }); return normal(file); });
 const operation = f.service.prepare("user", f.scene, controller.signal); await ready;
 await expect(f.service.prepare("user", f.scene)).rejects.toThrow("正在运行"); controller.abort(); release();
 await expect(operation).rejects.toThrow(); f.prepare.mockRejectedValueOnce(new Error("released")); await expect(f.service.prepare("user", f.scene)).rejects.toThrow("released");
});
