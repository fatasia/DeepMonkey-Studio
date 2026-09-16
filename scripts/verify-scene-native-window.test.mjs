import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { verifySceneNativeWindow } from "./verify-scene-native-window.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
 const directory = await mkdtemp(path.join(tmpdir(), "window-runner-test-")); t.after(() => rm(directory, { recursive: true, force: true }));
 const packagePath = path.join(directory, "source.json"), nativeExecutable = path.join(directory, "native.exe");
 const bytes = await readFile(new URL("../packages/deep-engine-native/tests/fixtures/runtime-package-camera-v3.json", import.meta.url));
 await writeFile(packagePath, bytes); await writeFile(nativeExecutable, "test binary");
 return { packagePath, nativeExecutable, bytes, packageHash: JSON.parse(bytes).packageHash.value };
}
function processFixture(f, change = () => {}, mode = "success") {
 const calls = []; let pending;
 const spawnProcess = (exe, args, options) => {
  const child = new EventEmitter(); calls.push({ exe, args, options, child });
  child.kill = () => { queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; };
  if (mode === "timeout") return child;
  pending = (async () => {
   assert.equal(options.shell, false); assert.equal(args[0], "--verify-package");
   assert.deepEqual(await readFile(args[1]), f.bytes); assert.equal((await readFile(exe)).toString(), "test binary");
   const report = { schemaVersion: 1, scope: "native-window", packageHash: f.packageHash, nonce: args[5], width: 960, height: 640,
     presentedFrames: Number(args[7]), backend: "Vulkan", gpuErrorsClean: true };
   await change(report, calls[0]);
   if (mode !== "missing") await writeFile(args[3], JSON.stringify(report));
   if (mode === "error") child.emit("error", new Error("spawn failure"));
   child.emit("close", mode === "exit" ? 1 : 0);
  })().catch(error => { child.emit("error", error); child.emit("close", 1); });
  return child;
 };
 return { calls, spawnProcess, finish: () => pending };
}
test("binds report to private package/executable bytes and cleans after close", async t => {
 const f = await fixture(t);
 const process = processFixture(f, async () => { await writeFile(f.nativeExecutable, "new build"); await writeFile(f.packagePath, "new source"); });
 const result = await verifySceneNativeWindow(f, process); await process.finish();
 assert.equal(result.sourceSha256, sha(f.bytes)); assert.equal(result.executableSha256, sha("test binary")); assert.equal(result.report.packageHash, f.packageHash);
 assert.notEqual(process.calls[0].exe, f.nativeExecutable); assert.equal(result.requestedFrames, 3);
 await assert.rejects(stat(process.calls[0].options.cwd), { code: "ENOENT" });
});
for (const [name, change] of [
 ["nonce", report => { report.nonce = "other"; }], ["hash", report => { report.packageHash = "0".repeat(64); }],
 ["scope", report => { report.scope = "native-smoke"; }], ["size", report => { report.width = 64; report.height = 64; }],
 ["frames", report => { report.presentedFrames = 2; }], ["GPU", report => { report.gpuErrorsClean = false; }],
 ["backend", report => { report.backend = ""; }], ["candidate", async (_report, call) => { await writeFile(call.args[1], "changed"); }],
 ["binary", async (_report, call) => { await writeFile(call.exe, "changed"); }],
]) test(`rejects invalid ${name} and cleans`, async t => {
 const f = await fixture(t), process = processFixture(f, change);
 await assert.rejects(verifySceneNativeWindow(f, process)); await process.finish();
 await assert.rejects(stat(process.calls[0].options.cwd), { code: "ENOENT" });
});
for (const mode of ["missing", "exit", "error", "timeout"]) test(`rejects process ${mode}`, async t => {
 const f = await fixture(t), process = processFixture(f, undefined, mode);
 await assert.rejects(verifySceneNativeWindow(f, { ...process, timeoutMs: 20 })); await process.finish();
 await assert.rejects(stat(process.calls[0].options.cwd), { code: "ENOENT" });
});
test("invalid package and frames never spawn", async t => {
 const f = await fixture(t); let calls = 0;
 const spawnProcess = () => { calls++; };
 await assert.rejects(verifySceneNativeWindow({ ...f, frames: 121 }, { spawnProcess }));
 await writeFile(f.packagePath, "bad package"); await assert.rejects(verifySceneNativeWindow(f, { spawnProcess })); assert.equal(calls, 0);
});

test("abort kills child but waits for close before deleting the candidate", async t => {
 const f = await fixture(t), controller = new AbortController(); let closed; let work; let killed = false;
 let started; const ready = new Promise(resolve => { started = resolve; });
 const operation = verifySceneNativeWindow({ ...f, signal: controller.signal }, { spawnProcess(_exe, _args, options) {
  work = options.cwd; const child = new EventEmitter();
  child.kill = () => { killed = true; return true; }; closed = () => child.emit("close", null, "SIGTERM"); started(); return child;
 } });
 await ready; controller.abort(new Error("user cancelled"));
 assert.equal(killed, true); assert((await stat(work)).isDirectory());
 closed(); await assert.rejects(operation, /user cancelled/); await assert.rejects(stat(work), { code: "ENOENT" });
});
test("pre-aborted input does not start a child", async t => {
 const f = await fixture(t); let spawned = false;
 await assert.rejects(verifySceneNativeWindow({ ...f, signal: AbortSignal.abort() }, { spawnProcess() { spawned = true; } })); assert.equal(spawned, false);
});
