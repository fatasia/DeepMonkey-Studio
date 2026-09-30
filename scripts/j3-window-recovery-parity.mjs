import { createRequire } from "node:module";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const output = path.join(root, "test-output/interrupted-0930/window-recovery");
await mkdir(output, { recursive: true }); await rm(path.join(output, "evidence.json"), { force: true });
const files = ["packages/deep-engine/src/webgpu/deviceSession.ts", "apps/web/src/viewer/StudioDeepWebGpuBridge.ts",
  "apps/web/src/viewer/j3DeviceFallbackProbe.ts", "packages/deep-engine-native/src/app/recovery.rs",
  "packages/deep-engine-native/src/app/device_loss_probe_tests.rs", "packages/deep-engine-native/src/renderer/device_loss_probe.rs"];
const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")])));
const webOnly = process.argv.includes("--web-only");
if (process.argv.slice(2).some(argument => argument !== "--web-only")) throw new Error("supported option: --web-only");
if (!webOnly) {
  for (const round of [1, 2]) await rm(path.join(output, `native/round-${round}.json`), { force: true });
  const execution = await promisify(execFile)("cargo", ["test", "--manifest-path", "packages/deep-engine-native/Cargo.toml",
    "--bin", "deep-engine-native", "j3_gate_e_actual_window_device_loss", "--", "--ignored", "--nocapture"],
  { cwd: root, env: { ...process.env, J3_WINDOW_NATIVE_OUTPUT: path.join(output, "native") }, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  await writeFile(path.join(output, "native-run.log"), execution.stdout + execution.stderr);
  assert.match(execution.stdout, /j3_gate_e_actual_window_device_loss/);
  assert.match(execution.stdout, /test result: ok\. 1 passed/);
}
const { createServer } = await import(pathToFileURL(path.join(root, "apps/web/node_modules/vite/dist/node/index.js")));
const server = await createServer({ root: path.join(root, "apps/web"), configFile: false,
  resolve: { conditions: ["development"] }, server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "j3-window-probe-page", configureServer(server) {
    server.middlewares.use("/j3-window-probe", (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end('<html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/styles/base.css"></head><body style="background:var(--bg-0);color:var(--text-strong);padding:24px"><h2>设备丢失 · 产品回退</h2><p id="status">初始化真实 ViewerEngine 与 Deep WebGPU</p><div id="viewport" style="position:relative;width:1800px;height:880px"></div></body></html>');
    });
  } }] });
let browser;
try {
  await server.listen();
  const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
  browser = await chromium.launch({ headless: true, executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const rounds = [];
  for (let round = 1; round <= 2; round++) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
    const errors = []; page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`${server.resolvedUrls.local[0]}j3-window-probe`);
    await page.evaluate(() => { window.__j3Run = import("/src/viewer/j3DeviceFallbackProbe.ts").then(module => module.runJ3DeviceFallbackProbe()); window.__j3Run.catch(error => { window.__j3Error = String(error); }); });
    await page.waitForFunction(() => window.__j3LossReady || window.__j3Error, null, { timeout: 90000 });
    assert.equal(await page.evaluate(() => window.__j3Error), undefined);
    await page.screenshot({ path: path.join(output, `web-${round}-deep.png`) });
    await page.evaluate(() => window.__j3ContinueLoss());
    const observed = await page.evaluate(() => window.__j3Run);
    assert.equal(observed.reason, "destroyed"); assert.equal(observed.recovery, null);
    assert.equal(observed.fallback, true); assert.equal(observed.fatalCalls, 1); assert.equal(observed.failures.length, 1);
    assert.equal(observed.deepCanvasesAfter, 0); assert(observed.resourcesBefore > 0); assert.equal(observed.resourcesAfter, 0);
    assert.equal(observed.sessionAfter, "disposed"); assert.equal(observed.authorIdentityPreserved, true);
    assert.deepEqual(observed.beforeCamera, observed.afterCamera); assert.deepEqual(observed.beforeAuthor, observed.afterAuthor);
    assert(observed.afterAuthor.varyingPixels > 100); assert.equal(observed.afterDisposeBackend, "webgl"); assert.deepEqual(observed.gpuErrors, []); assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, `web-${round}-fallback.png`) });
    rounds.push(observed); await page.evaluate(() => window.__j3ReleaseViewer()); await page.close();
  }
  assert.deepEqual(rounds[0], rounds[1], "fresh product instances must repeat stably");
  const native = [];
  for (let round = 1; round <= 2; round++) {
    const receipt = JSON.parse(await readFile(path.join(output, `native/round-${round}.json`), "utf8"));
    assert.equal(receipt.passed, true); assert.equal(receipt.round, String(round)); assert.equal(receipt.realCallbacks, 1);
    assert.notEqual(receipt.oldRenderer, receipt.newRenderer); assert(receipt.beforeHdr > 1 && receipt.afterHdr > 1);
    assert(receipt.relativeHdrDifference <= 1e-6); assert(receipt.presented && receipt.viewPreserved && receipt.selectionPreserved && receipt.staleEventsRejected);
    native.push(receipt);
  }
  assert.equal(native[0].packageHash, native[1].packageHash);
  const evidence = { passed: true, stable: true, currentRun: !webOnly,
    execution: { web: "fresh-two-product-instances", native: webOnly ? "prior-explicit-receipts" : "fresh-two-child-processes" },
    sources, web: rounds, native,
    scope: "actual NativeApp window destroyed rebuild and actual StudioDeepWebGpuBridge destroyed WebGL fallback",
    excluded: ["actual unknown driver fault", "Web unknown complete resource graph reconstruction", "GPU timing or driver VRAM"] };
  await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { try { await browser?.close(); } finally { await server.close(); } }
