// R3 状态操作序列跨端确定性重放:同一冻结的剖切/选择操作序列(deep-monkey.r3-state-ops)
// 与同一冻结 v7 runtime package(dataReplay 修订),在真实 Chrome WebGL、真实 Chrome
// WebGPU(--enable-unsafe-webgpu)与真实 Native winit 窗口(真实时钟)各跑两轮。
// 确定性以 canonical 状态帧字符串为准(r3-state-frame-v1 合同,与 dynamic-frame-v1 同一
// 纪律:合同字符串即跨端字节合同,SHA-256 由本驱动统一计算,不引入第三份哈希实现)。
// 每步的真实消费证据:Web 从 ViewerEngine 回读、Native 从 PlayerState/PlayerView(f32)
// 回读,applied 帧必须与合同帧逐字节相等(Native 的 box 剖切无消费者,如实记录)。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const output = path.resolve(process.env.DEEP_STATE_OUTPUT ?? path.join(repo, "test-output/r3-determinism-20260919-r1"));
await mkdir(output, { recursive: true });
const requireWeb = createRequire(path.join(repo, "apps/web/package.json"));
const requireEngine = createRequire(path.join(repo, "packages/deep-engine/package.json"));
const { build } = requireEngine("esbuild");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const asImport = (absolutePath: string) => absolutePath.replaceAll("\\", "/");

// ---------- 1. 真实编译器:原语场景 → v7 runtime package(承载 dataReplay 通道) ----------
const entry = path.join(output, "driver-entry.ts");
await writeFile(entry, `export { compileSceneRuntimePackage } from ${JSON.stringify(asImport(path.join(repo, "apps/web/src/delivery/compileSceneRuntimePackage.ts")))};
export { serializeDeepRuntimePackage, parseDeepRuntimePackage, runtimeContentSha256, runtimePackageSha256 } from ${JSON.stringify(asImport(path.join(repo, "packages/deep-engine/src/runtimePackage/index.ts")))};
`);
const compiledModule = path.join(output, "compiler.mjs");
await build({ entryPoints: [entry], outfile: compiledModule, bundle: true, platform: "node", format: "esm", conditions: ["development"], logLevel: "error" });
const compiler = await import(pathToFileURL(compiledModule).href);

const snapshot = {
  schemaVersion: 1, id: "r3-state-replay", projectId: "replay", name: "R3 state determinism replay",
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
  // 静态 TRS 动画仅为让编译器产出 dynamic-runtime 通道(承载 dataReplay);
  // 状态合同的 steps 与事件均不消费 TRS 采样,两端也都不应用该动画。
  animation: { duration: 1, loop: true, camera: [], models: [
    { id: "pump-0", time: 0, modelId: "pump", transform: { position: { x: -2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
    { id: "pump-1", time: 1, modelId: "pump", transform: { position: { x: -2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
  ] },
};
const options = { packageId: "scene.r3-state-replay", packageVersion: "1.0.0", loadModel: async () => { throw new Error("scene must stay primitive-only"); } };
const compiled = await compiler.compileSceneRuntimePackage(structuredClone(snapshot), options);

// 冻结包:在编译产物上补 dataReplay 事件通道(修订在帧内浮现的合同字段)并重签哈希。
const parsedPackage = JSON.parse(compiled.packageJson);
const dynamicPayload = parsedPackage.payloads[parsedPackage.entrypoints.dynamicRuntime];
const rebuilt = structuredClone(parsedPackage);
rebuilt.payloads["scene.dynamic"] = { ...dynamicPayload,
  dataReplay: { schema: "deep-engine.dynamic-data-replay", schemaVersion: 1, channel: "telemetry", events: [
    { revision: 1, timeMs: 250, payload: { value: 7 } },
    { revision: 2, timeMs: 750, payload: { value: 42 } },
  ] },
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
const frozenBytes = await readFile(frozenFile);
const frozenSha256 = sha(frozenBytes);
const packageHash = frozenValue.packageHash.value;
const replayEvents = rebuilt.payloads["scene.dynamic"].dataReplay.events;

// ---------- 2. 冻结操作序列:剖切启停/位移/多平面 + 选择 + dataReplay 浮现 ----------
// 所有浮点参数都在 1e-3 网格上(合同校验 |v| <= 1000):0.125/-1.25/0.5/-2/-1.5 等均
// 可被两端逐字节复现;序列同时覆盖 axis 单平面(两端消费)与 box 六平面(仅 Web 消费)。
const ops = {
  schema: "deep-monkey.r3-state-ops",
  schemaVersion: 1,
  id: "r3-state-determinism",
  packageHash,
  steps: [
    { atMs: 0, op: { kind: "clip-enable", axis: "z", inverted: false, offset: 0.125 } },
    { atMs: 100, op: { kind: "select", targetId: "pump" } },
    { atMs: 200, op: { kind: "clip-move", offset: -1.25 } },
    { atMs: 300, op: { kind: "box-enable", box: { min: [-1, -2, -1.5], max: [1, 2, 1.5] } } },
    { atMs: 400, op: { kind: "clip-disable" } },
    { atMs: 500, op: { kind: "clear-selection" } },
    { atMs: 600, op: { kind: "clip-enable", axis: "x", inverted: true, offset: 0.5 } },
    { atMs: 750, op: { kind: "select", targetId: "valve" } },
    { atMs: 850, op: { kind: "clip-move", offset: -0.5 } },
  ],
};
const opsFile = path.join(output, "frozen.state-ops.json");
await writeFile(opsFile, `${JSON.stringify(ops, null, 2)}\n`);
const opsBytes = await readFile(opsFile);
const opsSha256 = sha(opsBytes);
const selectTargets = ops.steps.filter(step => step.op.kind === "select").map(step => step.op.targetId);
for (const target of selectTargets) {
  assert(snapshot.primitives.some(primitive => primitive.modelId === target),
    `select target ${target} must exist in the scene so both ends read back the same selection`);
}

// ---------- 3. Native:真实 winit 窗口 + 真实时钟消费状态操作,退出回执 ----------
const executable = process.env.DEEP_STATE_EXE ?? path.join(repo, "packages/deep-engine-native/target/debug/deep-engine-native.exe");
const executableSha256 = sha(await readFile(executable));
function runNative() {
  const result = spawnSync(executable, ["--smoke-state-ops", opsFile, frozenFile], { cwd: output, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  assert.ifError(result.error);
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  assert.equal(result.status, 0, text);
  const line = text.split("\n").find(candidate => candidate.startsWith("native state ops receipt: "));
  assert.ok(line, `missing receipt: ${text}`);
  const receipt = JSON.parse(line.slice("native state ops receipt: ".length));
  assert.match(text, /Deep Runtime Package State Ops Player preflight OK/);
  return { receipt, log: text };
}
const nativeRounds = [runNative(), runNative()];
for (const { receipt } of nativeRounds) {
  assert.equal(receipt.packageHash, packageHash, "native player must report the frozen package hash");
  assert.equal(receipt.clock, "real-window");
  assert.equal(receipt.totalSteps, ops.steps.length);
  assert.equal(receipt.steps.length, ops.steps.length);
  assert.ok(receipt.presentations.length >= 1);
  // Native 消费者的每步回读必须与合同逐字节相等;box 步无消费者,如实记录。
  for (const step of receipt.steps) {
    if (step.applied === null) {
      assert.match(step.appliedNote, /unsupported-native/);
      assert.match(step.canonical, /clip=box:/, "only box steps may lack a native consumer");
    } else {
      assert.equal(step.applied, step.canonical, `native step ${step.index} applied state diverged`);
    }
  }
}

// ---------- 4. Web:真实 Chrome,同一冻结包与操作序列,WebGL 与 WebGPU 各两轮 ----------
const { createServer } = await import(pathToFileURL(requireWeb.resolve("vite")).href);
const server = await createServer({ root: path.join(repo, "apps/web"), configFile: false,
  server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await server.listen();
const playwright = await import(pathToFileURL(path.join(repo, "apps/cloud-render-worker/node_modules/playwright-core/index.js")).href);
let chromeVersion: string | null = null;
const webRounds: Record<string, Array<{ steps: Array<{ index: number; atMs: number; canonical: string; applied: string }>; presentations: Array<Record<string, unknown>> }>> = {};
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
          window.stateOpsJson = values.ops;
        }, { frozen: frozenJson, snapshot: JSON.stringify(snapshot), ops: JSON.stringify(ops) });
        await page.goto(`${server.resolvedUrls.local[0]}scripts/r3-state-runtime.html?backend=${backend}`);
        await page.waitForFunction(() => (window as { result?: unknown }).result || (window as { failure?: string }).failure,
          undefined, { timeout: 120_000 });
        const failure = await page.evaluate(() => (window as { failure?: string }).failure);
        assert(!failure, `Web ${backend} round ${round} failed: ${failure}`);
        const result = await page.evaluate(() => (window as { result: { backend: string; steps: Array<{ index: number; atMs: number; canonical: string; applied: string }>; presentations: Array<Record<string, unknown>> } }).result);
        assert.equal(result.backend, backend);
        assert.equal(result.steps.length, ops.steps.length, `${backend} round ${round} step count`);
        assert.ok(result.presentations.length >= ops.steps.length / 2, `${backend} round ${round} presentations`);
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
const webAppliedMatches = Object.fromEntries(Object.entries(webRounds).map(([backend, runs]) => [backend,
  runs.every(run => run.steps.every(step => step.applied === step.canonical))]));
const nativeAppliedMatches = nativeRounds.map(({ receipt }) =>
  receipt.steps.every((step: { applied: string | null; canonical: string }) => step.applied === null || step.applied === step.canonical));
const deterministic = {
  nativeRoundRepeat: JSON.stringify(nativeSequences[0]) === JSON.stringify(nativeSequences[1]),
  webglRoundRepeat: JSON.stringify(webSequences.webgl[0]) === JSON.stringify(webSequences.webgl[1]),
  webgpuRoundRepeat: JSON.stringify(webSequences.webgpu[0]) === JSON.stringify(webSequences.webgpu[1]),
  webglMatchesNative: JSON.stringify(webSequences.webgl[0]) === JSON.stringify(reference),
  webgpuMatchesNative: JSON.stringify(webSequences.webgpu[0]) === JSON.stringify(reference),
};
for (const [check, passed] of Object.entries(deterministic)) assert(passed, `determinism check failed: ${check}`);
assert.equal(reference.length, ops.steps.length);
assert.ok(reference[0]!.startsWith("r3-state-frame-v1|i=0|t=0|clip=axis:z,dir=1,off=0.125000|sel=-|events="));
assert.ok(reference.at(-1)!.startsWith("r3-state-frame-v1|i=8|t=850|") && reference.at(-1)!.endsWith("|events=1,2"),
  "final frame must expose both replay revisions");
assert.ok(reference.some(frame => frame.includes("clip=box:")), "sequence must cover the multi-plane box mode");
assert.ok(reference.some(frame => frame.includes("sel=pump")) && reference.some(frame => frame.includes("sel=valve")),
  "sequence must cover select transitions on both objects");
for (const [backend, matched] of Object.entries(webAppliedMatches)) assert(matched, `web ${backend} applied frames must match the contract`);
assert.deepEqual(nativeAppliedMatches, [true, true], "native applied frames must match the contract on every round");

const evidence = {
  schema: "deep-monkey.r3-state-determinism",
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  contract: {
    frame: "r3-state-frame-v1",
    ops: "deep-monkey.r3-state-ops",
    opsSchemaVersion: 1,
    floatDiscipline: "contract inputs quantized to the 1e-3 grid, |v| <= 1000; f32 player round-trip restores exact bytes",
    digestReference: "sha256(canonical frame string), one node-side implementation for all ends",
  },
  frozenPackage: {
    file: "frozen.runtime.json", sha256: frozenSha256, bytes: frozenBytes.byteLength,
    packageHash, packageId: frozenValue.packageId, packageVersion: frozenValue.packageVersion,
    schemaVersion: frozenValue.schemaVersion,
    dataReplayEvents: replayEvents,
  },
  frozenOps: {
    file: "frozen.state-ops.json", sha256: opsSha256, bytes: opsBytes.byteLength, opsId: ops.id,
    steps: ops.steps.length, sequence: ops.steps,
  },
  environment: {
    platform: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version,
    nativeExecutable: executable, nativeExecutableSha256: executableSha256,
    chromePath, chromeVersion,
  },
  native: nativeRounds.map(({ receipt }, index) => ({
    round: index + 1, clock: "real-window",
    packageHash: receipt.packageHash,
    steps: receipt.steps.map((step: { index: number; atMs: number; canonical: string; applied: string | null; appliedNote: string | null }) => ({
      index: step.index, atMs: step.atMs, canonical: step.canonical, digest: digestOf(step.canonical),
      applied: step.applied, appliedNote: step.appliedNote,
    })),
    presentations: receipt.presentations,
  })),
  web: Object.fromEntries(Object.entries(webRounds).map(([backend, runs]) => [backend, runs.map((run, index) => ({
    round: index + 1,
    steps: run.steps.map(step => ({ index: step.index, atMs: step.atMs, canonical: step.canonical, digest: digestOf(step.canonical), applied: step.applied })),
    presentations: run.presentations,
  }))])),
  determinism: { ...deterministic,
    appliedMatchesContract: { native: nativeAppliedMatches, webgl: webAppliedMatches.webgl, webgpu: webAppliedMatches.webgpu } },
  boundary: {
    realWindowPlayback: "Native=winit real window + real clock; Web=real Chrome rAF presentation scheduler; wall clock schedules step application, never changes contracted state",
    stateConsumption: "Web applies through engine.setClipping/select and reads back via getClippingState/getSelected; Native writes PlayerView.clipping (f32, real set_view GPU submission) and PlayerState.selected, then reads back through the f32 pipeline",
    unsupportedNative: [
      { mode: "box-clipping", reason: "PlayerView.clipping holds a single [f32;4] plane; the renderer section_uniform consumes one plane",
        wiring: "extend PlayerView.clipping to a plane array, arrayize section_uniform and loop the clipping test in the section shader pass" },
      { mode: "selection-highlight", reason: "Native keeps selection state (PlayerState.selected) but renders no highlight; the contract still validates state-level determinism",
        wiring: "add a selected-instance uniform/highlight pass to the native renderer keyed by PlayerState.selected" },
      { mode: "annotation-selection", reason: "Web has selectedAnnotationId but Native has no annotation selection playback consumer; excluded from this contract slice",
        wiring: "add PlayerState.selected_annotation plus an annotation highlight channel before including annotation select ops" },
    ],
  },
};
await writeFile(path.join(output, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({
  passed: true, output, frozenSha256, opsSha256, totalSteps: ops.steps.length,
  determinism: deterministic,
  nativePresentations: nativeRounds[0].receipt.presentations.length,
  webPresentations: Object.fromEntries(Object.entries(webRounds).map(([backend, runs]) => [backend, runs.map(run => run.presentations.length)])),
}, null, 2));

function sha(bytes: Uint8Array | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
