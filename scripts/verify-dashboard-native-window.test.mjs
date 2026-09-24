import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
// 与 verify-scene-native-window.mjs 同一解析口径:plain node 测试取 dist 构建产物。
const requireWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { parseDeepRuntimePackage, runtimePackageSha256 } = await import(pathToFileURL(requireWeb.resolve("@bim-studio/deep-engine/runtime-package")).href);
import { createNativeWindowVerifier, createDashboardNativeProcessVerifier } from "./lib/nativeWindowVerifier.mjs";
import { createDashboardNativeWindowVerifier } from "./lib/dashboardNativeWindowVerifier.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const dashboardBytes = () => readFile(new URL("../packages/deep-engine/fixtures/dashboard-composition-v1.json", import.meta.url));
async function fixture(t) {
 const directory = await mkdtemp(path.join(tmpdir(), "dashboard-window-runner-test-")); t.after(() => rm(directory, { recursive: true, force: true }));
 const packagePath = path.join(directory, "source.json"), nativeExecutable = path.join(directory, "native.exe");
 const bytes = await dashboardBytes();
 await writeFile(packagePath, bytes); await writeFile(nativeExecutable, "test binary");
 return { packagePath, nativeExecutable, bytes, packageHash: JSON.parse(bytes).packageHash.value };
}
function processFixture(f, change = () => {}, mode = "success", expectedCommand = "--verify-dashboard-package") {
 const calls = []; let pending;
 const spawnProcess = (exe, args, options) => {
  const child = new EventEmitter(); calls.push({ exe, args, options, child });
  child.kill = () => { queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; };
  if (mode === "timeout") return child;
  pending = (async () => {
   assert.equal(options.shell, false);
   // dashboard 链只允许 dashboard 验证命令;scene `--verify-package` 对 dashboard
   // 内容是 native fail-closed(8a9f15a9),不得出现在该链上。
   assert.equal(args[0], expectedCommand);
   assert.deepEqual(await readFile(args[1]), f.bytes); assert.equal((await readFile(exe)).toString(), "test binary");
   const report = { schemaVersion: 1, scope: "native-window", packageHash: f.packageHash, nonce: args[5], width: 960, height: 640,
     presentedFrames: Number(args[7]), backend: "Vulkan", gpuErrorsClean: true,
     device: { name: "GPU", backend: "Vulkan" }, deviceFingerprintSha256: "f".repeat(64), layers: [] };
   await change(report, calls[0]);
   if (mode !== "missing") await writeFile(args[3], JSON.stringify(report));
   if (mode === "error") child.emit("error", new Error("spawn failure"));
   child.emit("close", mode === "exit" ? 1 : 0);
  })().catch(error => { child.emit("error", error); child.emit("close", 1); });
  return child;
 };
 return { calls, spawnProcess, finish: () => pending };
}
const verifyDashboard = createDashboardNativeProcessVerifier(parseDeepRuntimePackage);

test("dashboard chain spawns --verify-dashboard-package and binds the report", async t => {
 const f = await fixture(t);
 const process = processFixture(f);
 const result = await verifyDashboard(f, process); await process.finish();
 assert.equal(result.sourceSha256, sha(f.bytes)); assert.equal(result.executableSha256, sha("test binary"));
 assert.equal(result.report.packageHash, f.packageHash); assert.equal(result.requestedFrames, 3);
 assert.notEqual(process.calls[0].exe, f.nativeExecutable);
 await assert.rejects(stat(process.calls[0].options.cwd), { code: "ENOENT" });
});

test("scene factory keeps spawning --verify-package on the same skeleton", async t => {
 const f = await fixture(t);
 const verifyScene = createNativeWindowVerifier(parseDeepRuntimePackage);
 const process = processFixture(f, undefined, "success", "--verify-package");
 await verifyScene(f, process); await process.finish();
 assert.equal(process.calls[0].args[0], "--verify-package");
});

 for (const mode of ["missing", "exit", "error", "timeout"]) test(`dashboard chain fails closed on process ${mode}`, async t => {
 // 旧 native 程序没有 --verify-dashboard-package:提前退出且不写报告 → 必须报错,
 // 不得以任何降级语义放行候选。
 const f = await fixture(t), process = processFixture(f, undefined, mode);
 await assert.rejects(verifyDashboard(f, { ...process, timeoutMs: 20 })); await process.finish();
 await assert.rejects(stat(process.calls[0].options.cwd), { code: "ENOENT" });
});

test("dashboard verifier rejects a scene artifact before any process starts", async t => {
 const f = await fixture(t);
 // 纵深防御:v5 合同本身要求 dashboard 入口;此处验证即使解析层放行了
 // 一个没有 dashboard 入口的 v5 值,方向防线也在进程启动前拒绝。
 const bytes = await dashboardBytes();
 const runtime = JSON.parse(bytes); runtime.entrypoints.dashboard = null;
 const input = { artifact: Buffer.from(JSON.stringify(runtime)), candidate: {}, sourceSemanticHash: "s",
   compileGraphHash: "c", targetArtifactHash: "t", windowEvidence: { nodeBindings: [], fontBindings: [] } };
 let spawned = false;
 const verify = createDashboardNativeWindowVerifier({ nativeExecutable: f.nativeExecutable,
   parseDeepRuntimePackage: () => ({ valid: true, value: runtime }),
   runtimeContentSha256: () => "x", verifyNativeWindow: async () => { spawned = true; return {}; } });
 await assert.rejects(verify(input), /dashboard entrypoint/); assert.equal(spawned, false);
});
