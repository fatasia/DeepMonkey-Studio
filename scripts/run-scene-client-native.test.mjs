import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { sceneCompilationSource } from "../apps/web/src/delivery/sceneCompilationSource.ts";
import { indexSceneClientArchiveFiles } from "../apps/web/src/delivery/sceneClientPackageIndex.ts";
import { runSceneClientNative, parseNativeClientArguments } from "./run-scene-client-native.mjs";
const requireWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));
const JSZip = requireWeb("jszip");
const { runtimeContentSha256 } = await import(pathToFileURL(requireWeb.resolve("@bim-studio/deep-engine/runtime-package")).href);
const paths = { scene: "scene.json", compilation: "native/compilation-evidence.json", report: "native/compatibility-report.json", runtime: "native/runtime-package.json" };
function fixture() {
  const bytes = readFileSync(new URL("../packages/deep-engine-native/tests/fixtures/runtime-package-camera-v3.json", import.meta.url));
  const runtime = JSON.parse(bytes), camera = runtime.payloads[runtime.entrypoints.camera];
  const primitives = runtime.payloads[runtime.entrypoints.renderPacket].instances.map(instance => ({ modelId: instance.id, visible: true }));
  const scene = { schemaVersion: 1, id: "scene", projectId: "project", name: "Scene", primitives, models: [],
    camera: { position: camera.position, target: camera.target }, publishedAt: "2026-09-15T00:00:00Z" };
  const source = runtimeContentSha256(sceneCompilationSource(scene)), artifact = createHash("sha256").update(bytes).digest("hex");
  const compilation = { schemaVersion: 1, scope: "static-render-packet", recipe: "deep-scene-static-compile-v3",
    sourceSemanticHash: source, compileGraphHash: "a".repeat(64), targetArtifactHash: artifact,
    sourceAssets: [], objectBindings: primitives.map(value => ({ nodeId: value.modelId, instanceIds: [value.modelId] })),
    deferredSceneFields: [], deferredObjectFields: [], compiledSceneFields: [{ field: "camera", capability: "deep.scene.camera.v1", resourceId: "scene.camera" }] };
  const report = { schemaVersion: 1, target: "deep-native", sceneId: "scene", platform: "windows-x64", fixtureId: `scene-${source}`,
    contentFingerprint: source, compileGraphHash: compilation.compileGraphHash, targetArtifactHash: artifact,
    capabilityProfileVersion: "deep-scene-compiled-v1", status: "ready", items: [], evidence: [] };
  // 测试专用声明，检验内部绑定；不代表该样本实际通过窗口验证。
  for (const [capability, path, objectId = "scene"] of [["deep.scene.runtime.v1", "$"], ["deep.scene.camera.v1", "camera"],
    ...primitives.map((value, index) => ["deep.scene.static-primitives.v1", `primitives[${index}]`, value.modelId])]) {
    const id = `test-${path}`;
    report.items.push({ sceneId: "scene", objectId, capability, path, status: "supported", reason: "test", remediation: "test", evidenceIds: [id] });
    report.evidence.push({ id, capability, target: "deep-native", sourceSemanticHash: source, compileGraphHash: compilation.compileGraphHash,
      targetArtifactHash: artifact, fixtureId: report.fixtureId, platform: "windows-x64", scope: "native-window" });
  }
  const manifest = { target: "deep-native", projectId: "project", sceneId: "scene", sceneName: "Scene", publishedAt: scene.publishedAt, files: [],
    capabilities: { status: "ready" }, nativeRuntime: { kind: runtime.schema, schemaVersion: 3, packageHash: runtime.packageHash, status: "ready" } };
  const contents = new Map([[paths.runtime, bytes]]);
  for (const [path, value] of [[paths.scene, scene], ["project.json", { id: "project", models: [] }], [paths.compilation, compilation], [paths.report, report]]) contents.set(path, Buffer.from(JSON.stringify(value)));
  return { manifest, contents };
}

async function archive(purpose = "delivery") {
 const f = fixture();
 f.contents.set("applications.json", Buffer.from("[]")); f.contents.set("runtime.json", Buffer.from("{}")); f.contents.set("README.txt", Buffer.from("test"));
 const files = await indexSceneClientArchiveFiles([...f.contents].map(([path, content]) => ({ path, content: Uint8Array.from(content).buffer })));
 const metadata = { ...f.manifest, kind: "bim-studio-scene-client-package", schemaVersion: 1, purpose, renderer: "webgl", toolbarVisible: true,
 nativeRuntime: { ...f.manifest.nativeRuntime, path: paths.runtime, reportPath: paths.report }, capabilities: { status: "ready", reportPath: paths.report } };
 delete metadata.files;
 const manifest = { ...metadata, files, generatedAt: "2026-09-15T00:00:00Z", contentHash: { algorithm: "sha256", value: runtimeContentSha256({ metadata, files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) }) } };
 const zip = new JSZip(); for (const [path, bytes] of f.contents) zip.file(path, bytes); zip.file("manifest.json", JSON.stringify(manifest));
 return { bytes: await zip.generateAsync({ type: "nodebuffer" }), runtime: f.contents.get(paths.runtime) };
}
async function setup(t, purpose) {
 const dir = await mkdtemp(path.join(tmpdir(), "native-launch-test-")); t.after(() => rm(dir, { recursive: true, force: true }));
 const nativeExecutable = path.join(dir, "native fixture.exe"), archivePath = path.join(dir, "fixture.zip");
 const f = await archive(purpose); await writeFile(nativeExecutable, "fake"); await writeFile(archivePath, f.bytes);
 return { ...f, nativeExecutable, archivePath, dir };
}
test("launches only validated runtime with exact arguments and cleans after close", async t => {
 const f = await setup(t); let work; let inspected;
 const result = await runSceneClientNative(f, { spawnProcess(exe, args, options) {
 assert.equal(exe, f.nativeExecutable); assert.equal(options.shell, false); assert.equal(args[0], "--package"); work = options.cwd;
 const child = new EventEmitter(); inspected = (async () => {
 assert.deepEqual(await readdir(work), ["runtime-package.json"]); assert.deepEqual(await readFile(args[1]), f.runtime);
 child.emit("close", 0, null);
 })().catch(error => { child.emit("error", error); child.emit("close", 1); }); return child;
 } });
 await inspected; assert.deepEqual(result, { status: "closed", code: 0 }); await assert.rejects(stat(work), { code: "ENOENT" });
});
for (const failure of ["error", "exit", "sync"]) test(`cleans temporary runtime after ${failure}`, async t => {
 const f = await setup(t); let work;
 await assert.rejects(runSceneClientNative(f, { spawnProcess(_exe, _args, options) {
 work = options.cwd; if (failure === "sync") throw new Error("spawn failure");
 const child = new EventEmitter(); queueMicrotask(() => { if (failure === "error") child.emit("error", new Error("spawn failure")); child.emit("close", 2); }); return child;
 } })); await assert.rejects(stat(work), { code: "ENOENT" });
});
for (const bad of ["diagnostic", "corrupt", "missing-exe"]) test(`rejects ${bad} before spawn`, async t => {
 const f = await setup(t, bad === "diagnostic" ? "diagnostic" : "delivery"); let calls = 0;
 if (bad === "corrupt") await writeFile(f.archivePath, "bad zip");
 if (bad === "missing-exe") f.nativeExecutable = path.join(f.dir, "missing.exe");
 await assert.rejects(runSceneClientNative(f, { spawnProcess() { calls++; } })); assert.equal(calls, 0);
});

test("CLI accepts only explicit verification mode and rejects supplied reports or frame overrides", () => {
 const args = ["client.zip", "--native-executable", "native.exe"];
 assert.deepEqual(parseNativeClientArguments(args), { archivePath: "client.zip", nativeExecutable: "native.exe", verifyWindow: false });
 assert.equal(parseNativeClientArguments([...args, "--verify-window"]).verifyWindow, true);
 for (const extra of [["--frames", "1"], ["--report", "existing.json"], ["--verify-window", "--nonce", "fake"], ["--verify-window", "--verify-window"]]) {
 assert.throws(() => parseNativeClientArguments([...args, ...extra]));
 }
});
for (const failure of [undefined, "nonce", "hash", "gpu", "frames", "exit", "tamper"])
test(`window check uses verified archive bytes, validates report and cleans: ${failure ?? "success"}`, async t => {
 const f = await setup(t); let work;
 const pending = runSceneClientNative({ ...f, verifyWindow: true }, { spawnProcess(exe, args, options) {
 work = options.cwd; assert.equal(options.shell, false); assert.equal(args[0], "--verify-package"); assert.equal(args[6], "--frames"); assert.equal(args[7], "3");
 assert.equal(path.dirname(exe), work);
 const child = new EventEmitter(); (async () => {
 assert.deepEqual(await readFile(args[1]), f.runtime);
 const runtime = JSON.parse(f.runtime);
 const report = { schemaVersion: 1, scope: "native-window", nonce: args[5], packageHash: runtime.packageHash.value,
 width: 1200, height: 800, presentedFrames: 3, backend: "fixture", gpuErrorsClean: true };
 if (failure === "nonce") report.nonce = "wrong";
 if (failure === "hash") report.packageHash = "0".repeat(64);
 if (failure === "gpu") report.gpuErrorsClean = false;
 if (failure === "frames") report.presentedFrames = 2;
 if (failure === "tamper") await writeFile(args[1], "changed");
 await writeFile(args[3], JSON.stringify(report)); child.emit("close", failure === "exit" ? 1 : 0);
 })().catch(error => { child.emit("error", error); child.emit("close", 1); }); return child;
 } });
 if (failure) await assert.rejects(pending);
 else { const result = await pending; assert.equal(result.scope, "native-window"); assert.equal(result.requestedFrames, 3);
 assert.equal(result.sourceSha256, createHash("sha256").update(f.runtime).digest("hex")); }
 await assert.rejects(stat(work), { code: "ENOENT" });
});
test("corrupted archive fails verification mode before any window starts", async t => {
 const f = await setup(t); const zip = await JSZip.loadAsync(f.bytes); zip.file(paths.runtime, "tampered");
 await writeFile(f.archivePath, await zip.generateAsync({ type: "nodebuffer" })); let calls = 0;
 await assert.rejects(runSceneClientNative({ ...f, verifyWindow: true }, { spawnProcess() { calls++; } })); assert.equal(calls, 0);
});

