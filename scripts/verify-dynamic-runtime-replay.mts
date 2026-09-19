// 动态运行包跨端确定性重放:同一冻结 v7 runtime package(动画 + dataReplay + interaction)
// 在真实 Chrome WebGL、真实 Chrome WebGPU、真实 Native winit 窗口各播放两轮。
// 确定性以 canonical 帧字符串为准(三端逐字节对比),SHA-256 由本驱动统一计算;
// presentation 时间为真实测量值,只用于证明播放真实发生,不参与确定性判定。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const output = path.resolve(process.env.DEEP_DYNAMIC_OUTPUT ?? path.join(repo, "test-output/dynamic-runtime-20260919-r1"));
await mkdir(output, { recursive: true });
const requireWeb = createRequire(path.join(repo, "apps/web/package.json"));
const requireEngine = createRequire(path.join(repo, "packages/deep-engine/package.json"));
const { build } = requireEngine("esbuild");
const stepMs = 100;
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const asImport = (absolutePath: string) => absolutePath.replaceAll("\\", "/");

// ---------- 1. 真实编译器:原语场景 + 对象 TRS 动画 → v7 runtime package ----------
const entry = path.join(output, "driver-entry.ts");
await writeFile(entry, `export { compileSceneRuntimePackage } from ${JSON.stringify(asImport(path.join(repo, "apps/web/src/delivery/compileSceneRuntimePackage.ts")))};
export { serializeDeepRuntimePackage, parseDeepRuntimePackage, validateDynamicSceneRuntime, runtimeContentSha256, runtimePackageSha256 } from ${JSON.stringify(asImport(path.join(repo, "packages/deep-engine/src/runtimePackage/index.ts")))};
`);
const compiledModule = path.join(output, "compiler.mjs");
await build({ entryPoints: [entry], outfile: compiledModule, bundle: true, platform: "node", format: "esm", conditions: ["development"], logLevel: "error" });
const compiler = await import(pathToFileURL(compiledModule).href);

const snapshot = {
  schemaVersion: 1, id: "dynamic-replay", projectId: "replay", name: "Dynamic runtime replay",
  primitives: [
    { modelId: "pump", name: "Pump", kind: "box", color: "#c96f4a", visible: true, opacity: 1,
      transform: { position: { x: -2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
    { modelId: "valve", name: "Valve", kind: "cylinder", color: "#4a9ac9", visible: true, opacity: 1,
      transform: { position: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
  ],
  models: [], measurements: [],
  camera: { mode: "orbit", position: { x: 0, y: 3.5, z: 9 }, target: { x: 0, y: 0, z: 0 } },
  environment: { skybox: "none", gridVisible: false, backgroundColor: "#172126" },
  createdAt: "2026-09-19T00:00:00Z", updatedAt: "2026-09-19T00:00:00Z",
  animation: { duration: 1, loop: true, camera: [], models: [
    { id: "pump-0", time: 0, modelId: "pump", transform: { position: { x: -2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
    { id: "pump-1", time: 1, modelId: "pump", transform: { position: { x: 3, y: 1, z: 0 }, rotation: { x: 0, y: Math.PI / 2, z: 0 }, scale: { x: 1.5, y: 1.5, z: 1.5 } } },
    { id: "valve-0", time: 0, modelId: "valve", transform: { position: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
    { id: "valve-1", time: 1, modelId: "valve", transform: { position: { x: 2, y: 2, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 0.5, y: 2, z: 0.5 } } },
  ] },
};
const options = { packageId: "scene.dynamic-replay", packageVersion: "1.0.0", loadModel: async () => { throw new Error("scene must stay primitive-only"); } };
const compiled = await compiler.compileSceneRuntimePackage(structuredClone(snapshot), options);
assert.ok(compiled.evidence.compiledSceneFields.some(field => field.field === "animation" && field.capability === "deep.scene.dynamic-runtime.v1"),
  "compiler must lower model TRS animation into the v7 dynamic resource");
// "animation" stays in deferredSceneFields until camera/clip channels compile too; only the
// deterministic object-TRS subset enters the package.
assert.equal(compiled.runtimePackage.schemaVersion, 7);

// ---------- 2. 冻结包:编译器动画产物 + 同一 v1 ABI 的 dataReplay/interaction 通道 ----------
// 直接在已编译包上扩展 dynamic payload 并用包 ABI 的真实 canonical 哈希函数重签:
// 渲染包保持编译器原始字节,避免把快照 JSON 再喂回需要 Float32Array 的 prepare 路径。
const parsedPackage = JSON.parse(compiled.packageJson);
const dynamicPayload = parsedPackage.payloads[parsedPackage.entrypoints.dynamicRuntime];
const rebuilt = structuredClone(parsedPackage);
rebuilt.payloads["scene.dynamic"] = { ...dynamicPayload,
  dataReplay: { schema: "deep-engine.dynamic-data-replay", schemaVersion: 1, channel: "telemetry", events: [
    { revision: 1, timeMs: 250, payload: { value: 7 } },
    { revision: 2, timeMs: 750, payload: { value: 42 } },
  ] },
  interaction: { schema: "deep-engine.dynamic-interaction", schemaVersion: 1, trigger: "command", action: "select", targetId: "pump" },
};
const dynamicResource = rebuilt.resources.find((resource: { kind: string }) => resource.kind === "dynamic-runtime");
assert.equal(dynamicResource.id, "scene.dynamic");
dynamicResource.contentHash.value = compiler.runtimeContentSha256(rebuilt.payloads["scene.dynamic"]);
rebuilt.packageHash.value = compiler.runtimePackageSha256(rebuilt);
const frozen = compiler.parseDeepRuntimePackage(JSON.stringify(rebuilt));
assert.equal(frozen.valid, true, "frozen package must revalidate through the package validator");
const frozenValue = frozen.value;
const frozenJson = compiler.serializeDeepRuntimePackage(frozenValue);
const frozenFile = path.join(output, "frozen.runtime.json");
await writeFile(frozenFile, frozenJson);
const reparsed = compiler.parseDeepRuntimePackage(frozenJson);
assert.equal(reparsed.valid, true, "serialized frozen package must revalidate");
const dynamicParsed = compiler.validateDynamicSceneRuntime(reparsed.value.payloads[reparsed.value.entrypoints.dynamicRuntime]);
assert.equal(dynamicParsed.valid, true, "frozen dynamic payload must satisfy the v1 ABI");
const frozenBytes = await readFile(frozenFile);
const frozenSha256 = sha(frozenBytes);
const durationMs = dynamicParsed.value.animation.durationMs;
const totalSteps = Math.floor(durationMs / stepMs) + 1;

// ---------- 3. Native:真实 winit 窗口 + 真实时钟消费 TRS,退出回执 ----------
const executable = process.env.DEEP_DYNAMIC_EXE ?? path.join(repo, "packages/deep-engine-native/target/debug/deep-engine-native.exe");
const executableSha256 = sha(await readFile(executable));
function runNative() {
  const result = spawnSync(executable, ["--smoke-dynamic-package", frozenFile], { cwd: output, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  assert.ifError(result.error);
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  assert.equal(result.status, 0, text);
  const line = text.split("\n").find(candidate => candidate.startsWith("native dynamic playback receipt: "));
  assert.ok(line, `missing receipt: ${text}`);
  const receipt = JSON.parse(line.slice("native dynamic playback receipt: ".length));
  assert.match(text, /Deep Runtime Package Dynamic Player preflight OK/);
  return { receipt, log: text };
}
const nativeRounds = [runNative(), runNative()];
for (const { receipt } of nativeRounds) {
  assert.equal(receipt.packageHash, frozenValue.packageHash.value, "native player must report the frozen package hash");
  assert.equal(receipt.clock, "real-window");
  assert.equal(receipt.totalSteps, totalSteps);
  assert.equal(receipt.steps.length, totalSteps);
  assert.ok(receipt.presentations.length >= 1);
}

// ---------- 4. Web:真实 Chrome,同一冻结包,WebGL 与 WebGPU 各两轮 ----------
const { createServer } = await import(pathToFileURL(requireWeb.resolve("vite")).href);
const server = await createServer({ root: path.join(repo, "apps/web"), configFile: false,
  server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await server.listen();
const playwright = await import(pathToFileURL(path.join(repo, "apps/cloud-render-worker/node_modules/playwright-core/index.js")).href);
const replayConfig = JSON.stringify({ stepMs, steps: totalSteps });
let chromeVersion: string | null = null;
const webRounds: Record<string, Array<{ steps: Array<{ timeMs: number; canonical: string }>; presentations: Array<Record<string, unknown>> }>> = {};
try {
  const { chromium } = (playwright as { default?: { chromium: unknown }; chromium?: unknown }).default ?? playwright;
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu"] });
    chromeVersion = (browser as { version: () => string }).version();
  try {
    for (const backend of ["webgl", "webgpu"]) {
      webRounds[backend] = [];
      for (let round = 1; round <= 2; round += 1) {
        const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
        await page.addInitScript(values => {
          window.frozenPackageJson = values.frozen;
          window.sceneSnapshotJson = values.snapshot;
          window.replayConfigJson = values.config;
        }, { frozen: frozenJson, snapshot: JSON.stringify(snapshot), config: replayConfig });
        await page.goto(`${server.resolvedUrls.local[0]}scripts/dynamic-runtime.html?backend=${backend}`);
        await page.waitForFunction(() => (window as { result?: unknown }).result || (window as { failure?: string }).failure,
          undefined, { timeout: 120_000 });
        const failure = await page.evaluate(() => (window as { failure?: string }).failure);
        assert(!failure, `Web ${backend} round ${round} failed: ${failure}`);
        const result = await page.evaluate(() => (window as { result: { backend: string; steps: Array<{ timeMs: number; canonical: string }>; presentations: Array<Record<string, unknown>> } }).result);
        assert.equal(result.backend, backend);
        assert.equal(result.steps.length, totalSteps, `${backend} round ${round} step count`);
        assert.ok(result.presentations.length >= totalSteps / 2, `${backend} round ${round} presentations`);
        assert.ok(result.presentations.some(presentation => Number((presentation as { drawCalls?: number | null }).drawCalls ?? 0) > 0),
          `${backend} round ${round} must carry real renderer draw evidence`);
        webRounds[backend].push(result);
        await page.close();
      }
    }
  } finally { await browser.close(); }
} finally { await server.close(); }

// ---------- 5. 确定性判定 + 证据 ----------
const digestOf = (canonical: string) => sha(Buffer.from(canonical, "utf8"));
const canonicalSequence = (run: { steps: Array<{ canonical: string }> }) => run.steps.map(step => step.canonical);
const nativeSequences = nativeRounds.map(({ receipt }) => receipt.steps.map((step: { canonical: string }) => step.canonical));
const webSequences = Object.fromEntries(Object.entries(webRounds).map(([backend, runs]) => [backend, runs.map(canonicalSequence)]));
const reference = nativeSequences[0];
const deterministic = {
  nativeRoundRepeat: JSON.stringify(nativeSequences[0]) === JSON.stringify(nativeSequences[1]),
  webglRoundRepeat: JSON.stringify(webSequences.webgl[0]) === JSON.stringify(webSequences.webgl[1]),
  webgpuRoundRepeat: JSON.stringify(webSequences.webgpu[0]) === JSON.stringify(webSequences.webgpu[1]),
  webglMatchesNative: JSON.stringify(webSequences.webgl[0]) === JSON.stringify(reference),
  webgpuMatchesNative: JSON.stringify(webSequences.webgpu[0]) === JSON.stringify(reference),
};
for (const [check, passed] of Object.entries(deterministic)) assert(passed, `determinism check failed: ${check}`);
assert.equal(reference.length, totalSteps);
assert.ok(reference[0]!.startsWith("dynamic-frame-v1|t=0|events=|tracks="));
assert.ok(reference.at(-1)!.includes("|t=1000|events=1,2|"), "final frame must expose both replay revisions");

const evidence = {
  schema: "deep-monkey.dynamic-runtime-replay",
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  frozenPackage: {
    file: "frozen.runtime.json", sha256: frozenSha256, bytes: frozenBytes.byteLength,
    packageHash: frozenValue.packageHash.value, packageId: frozenValue.packageId, packageVersion: frozenValue.packageVersion,
    schemaVersion: frozenValue.schemaVersion, dynamicChannels: { animation: true, dataReplay: true, interaction: true },
    durationMs, stepMs, totalSteps,
    dynamicRuntimeHash: frozenValue.resources.find((resource: { kind: string }) => resource.kind === "dynamic-runtime").contentHash.value,
  },
  compile: {
    recipe: compiled.evidence.recipe, sourceSemanticHash: compiled.evidence.sourceSemanticHash,
    compileGraphHash: compiled.evidence.compileGraphHash, targetArtifactHash: compiled.evidence.targetArtifactHash,
    deferredSceneFields: compiled.evidence.deferredSceneFields,
  },
  environment: {
    platform: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version,
    nativeExecutable: executable, nativeExecutableSha256: executableSha256,
    chromePath, chromeVersion,
  },
  native: nativeRounds.map(({ receipt }, index) => ({
    round: index + 1, clock: "real-window",
    packageHash: receipt.packageHash,
    steps: receipt.steps.map((step: { timeMs: number; canonical: string; replayRevisions: number[]; changedInstances: number }) => ({
      timeMs: step.timeMs, canonical: step.canonical, digest: digestOf(step.canonical),
      replayRevisions: step.replayRevisions, changedInstances: step.changedInstances,
    })),
    presentations: receipt.presentations,
  })),
  web: Object.fromEntries(Object.entries(webRounds).map(([backend, runs]) => [backend, runs.map((run, index) => ({
    round: index + 1,
    steps: run.steps.map(step => ({ timeMs: step.timeMs, canonical: step.canonical, digest: digestOf(step.canonical) })),
    presentations: run.presentations,
  }))])),
  determinism: { ...deterministic, crossEndDigestReference: "sha256(canonical), one node-side implementation for all ends" },  boundary: {
    realWindowPlayback: "Native=winit real window + real clock + per-step GPU packet staging; Web=real Chrome rAF presentation scheduler",
    deterministicClock: "fixed step grid indexes the replay; wall clock schedules step application, never changes sampled values",
    stillDeferred: ["camera/clip tracks", "enabled live dataBindings", "script interactions", "multi-instance model internal composition on Native"],
  },
};
await writeFile(path.join(output, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({
  passed: true, output, frozenSha256, totalSteps,
  determinism: deterministic,
  nativePresentations: nativeRounds[0].receipt.presentations.length,
  webPresentations: Object.fromEntries(Object.entries(webRounds).map(([backend, runs]) => [backend, runs.map(run => run.presentations.length)])),
}, null, 2));

function sha(bytes: Uint8Array | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
