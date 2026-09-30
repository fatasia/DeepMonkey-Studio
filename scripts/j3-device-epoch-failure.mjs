import { createRequire } from "node:module";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const output = path.join(root, "test-output/interrupted-0930/epoch-failure");
await mkdir(output, { recursive: true }); await rm(path.join(output, "evidence.json"), { force: true });
const files = ["packages/deep-engine/src/webgpu/pbrRenderer.ts", "packages/deep-engine/src/webgpu/rendererDeviceEpoch.ts",
  "packages/deep-engine/src/threeBridge/DeepWebGpuBackend.ts",
  "apps/web/src/viewer/StudioDeepWebGpuBridge.ts", "apps/web/src/viewer/j3DeviceEpochFailureProbe.ts", "scripts/j3-device-epoch-failure.mjs"];
const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")])));
const { createServer } = await import(pathToFileURL(path.join(root, "apps/web/node_modules/vite/dist/node/index.js")));
const server = await createServer({ root: path.join(root, "apps/web"), configFile: false,
  resolve: { conditions: ["development"] }, server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "j3-device-epoch-failure-page", configureServer(server) {
    server.middlewares.use("/j3-epoch-failure", (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end('<html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/styles/base.css"></head><body style="background:var(--bg-0);color:var(--text-strong);padding:24px"><h2>真实GPU候选失败 · 作者WebGL保留</h2><p id="status">初始化产品查看器</p><div id="viewport" style="position:relative;width:1800px;height:880px"></div></body></html>');
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
    await page.goto(server.resolvedUrls.local[0] + "j3-epoch-failure");
    await page.evaluate(() => { window.__j3Run = import("/src/viewer/j3DeviceEpochFailureProbe.ts").then(module => module.runJ3DeviceEpochFailureProbe()); window.__j3Run.catch(error => { window.__j3Error = String(error); }); });
    await page.waitForFunction(() => window.__j3FailureReady || window.__j3Error, null, { timeout: 90000 });
    assert.equal(await page.evaluate(() => window.__j3Error), undefined);
    await page.screenshot({ path: path.join(output, "web-" + round + "-before.png") });
    await page.evaluate(() => window.__j3ContinueFailure());
    const observed = await page.evaluate(() => Promise.race([window.__j3Run,
      new Promise((_, reject) => setTimeout(() => reject(new Error("candidate failure evidence timed out after 45s")), 45_000))]));
    assert.deepEqual(observed.stimulus, ["synthetic-recreated-notification", "actual-candidate-device-destroy"]); assert.equal(observed.actualUnknownDriverFault, false);
    assert.equal(observed.immediateFallback, true); assert.equal(observed.activeBackend, "webgl"); assert.equal(observed.authorOpacity, "1");
    assert.equal(observed.differentDevice, true); assert.equal(observed.createdCandidates, 2);
    assert.equal(observed.independentPacketCandidate, true);
    assert.equal(observed.candidateReadyBeforeDestroy, true); assert(observed.candidateResourcesBeforeDestroy > 0);
    assert.equal(observed.oldSession, "disposed"); assert.equal(observed.oldResources, 0);
    assert.equal(observed.failedCandidateSession, "disposed"); assert.equal(observed.failedCandidateResources, 0);
    assert.equal(observed.oldLossReason, "destroyed"); assert.equal(observed.candidateLossReason, "destroyed");
    assert.equal(observed.fatalCalls[0], 0); assert.equal(observed.failures.length, 1); assert(observed.failures[0].length > 0);
    assert.equal(observed.deepCanvases, 0); assert.equal(observed.authorIdentityPreserved, true);
    assert.deepEqual(observed.beforeCamera, observed.afterCamera); assert.deepEqual(observed.beforeAuthor, observed.afterAuthor);
    assert.deepEqual(observed.gpuErrors, []); assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, "web-" + round + "-fallback.png") });
    rounds.push(observed); await page.evaluate(() => window.__j3ReleaseViewer()); await page.close();
  }
  assert.deepEqual(rounds[0], rounds[1], "fresh product instances must repeat stably");
  const evidence = { passed: true, stable: true, currentRun: true, sources, web: rounds,
    scope: "synthetic recreated notification, actual real-GPU candidate destruction and product first-frame rejection",
    excluded: ["actual unknown driver fault", "GPU timing or driver VRAM"] };
  await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
} finally { try { await browser?.close(); } finally { await server.close(); } }
