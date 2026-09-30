import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { compareLocalDirect, localDirectCases } from "./lib/c8LocalDirectParity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const out = path.join(root, "test-output/interrupted-0930/c8-local-direct"), hash = data => createHash("sha256").update(data).digest("hex");
const files = ["packages/deep-engine/lab/c8LocalDirectFixture.ts", "packages/deep-engine/lab/c8LocalDirectProbe.ts",
  "packages/deep-engine/lab/c8SharedSceneProbe.ts", "packages/deep-engine/lab/c8SharedSceneFixture.ts", "packages/deep-engine/lab/c8SharedSceneReadback.ts",
  "packages/deep-engine/src/lighting/clusterLightingPbrWgsl.ts", "packages/deep-engine/src/webgpu/pbrShader.ts",
  "packages/deep-engine/src/webgpu/pbrDirectMultiscatteringWgsl.ts", "packages/deep-engine/src/webgpu/environmentShader.ts",
  "packages/deep-engine/wgsl/brdfDirectMultiscattering.wgsl", "packages/deep-engine/wgsl/directDisplay.wgsl",
  "packages/deep-engine/src/threeBridge/ThreeProjectionBridge.ts", "packages/deep-engine/src/threeBridge/DeepWebGpuBackend.ts",
  "packages/deep-engine/src/threeBridge/threeWorldLights.ts", "packages/deep-engine/src/lighting/pbrSceneLighting.ts",
  "packages/deep-engine/src/webgpu/pbrRenderer.ts", "scripts/c8-local-direct-parity.mjs", "scripts/lib/c8LocalDirectParity.mjs"];
const identities = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(path.join(root, file)))])));
await mkdir(out, { recursive: true });
await Promise.all(["evidence.json", "rounds.json", "diagnostic.json", "round-1.png", "round-2.png"].map(file => rm(path.join(out, file), { force: true })));
const sources = await identities(), { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/c8LocalDirectProbe.ts")], outfile: path.join(out, "probe.mjs"),
  bundle: true, format: "esm", platform: "browser", conditions: ["development"] });
const bundleHash = hash(await readFile(path.join(out, "probe.mjs"))), css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const html = `<html><head><meta charset="utf-8"><style>${css}</style></head><body style="padding:24px;background:var(--bg-0);color:var(--text-strong)"><h2 style="margin:0 0 8px">正式多灯材质 · 原 Three r185 / Deep</h2><p style="margin:0 0 16px">每组左：原 Three，右：Deep。点光 / 聚光 / 额外方向光，主光强度为零。固定曝光 0.5 / ACES，真实 RGBA16F；补能消融及关灯控制另存数值附件。</p><div id="frames" style="display:grid;grid-template-columns:repeat(2,624px);gap:16px"></div></body></html>`;
const server = createServer(async (request, response) => {
  try { response.setHeader("Content-Type", request.url === "/probe.mjs" ? "text/javascript" : "text/html"); response.end(request.url === "/probe.mjs" ? await readFile(path.join(out, "probe.mjs")) : html); }
  catch (error) { response.statusCode = 500; response.end(String(error)); }
});
let browser;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
  browser = await chromium.launch({ headless: true, executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark", reducedMotion: "reduce" });
  const rounds = [], checks = [], errors = []; page.on("pageerror", error => errors.push(String(error)));
  for (let round = 1; round <= 2; round++) {
    await page.goto(`http://127.0.0.1:${server.address().port}`); const captures = [];
    for (const kind of localDirectCases) for (const profile of ["formal", "single-scatter-ablation"]) {
      const realm = await browser.newPage(); let capture;
      realm.on("pageerror", error => errors.push(String(error)));
      try { await realm.goto(`http://127.0.0.1:${server.address().port}`);
        capture = await realm.evaluate(async ({ kind, profile }) => (await import("/probe.mjs")).runLocalDirect(kind, profile), { kind, profile });
      } finally { await realm.close(); }
      captures.push(capture); console.log(`round ${round}: ${kind}/${profile} actual frames complete`);
      if (profile !== "formal") continue;
      await page.evaluate(capture => {
        const host = document.querySelector("#frames");
        for (const frame of capture.run.frames.filter(frame => frame.stage === "direct-diagnostic")) {
          const card = document.createElement("div"), label = document.createElement("p"); label.textContent = `${capture.kind} · ${frame.name}`; label.style.cssText = "margin:0 0 8px"; card.append(label);
          for (const key of ["three", "deep"]) { const canvas = document.createElement("canvas"); canvas.width = capture.run.width; canvas.height = capture.run.height; canvas.style.cssText = "width:288px;height:173px;margin-right:16px";
            canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(frame[key].display), capture.run.width, capture.run.height), 0, 0); card.append(canvas); } host.append(card);
        }
      }, capture);
    }
    await writeFile(path.join(out, `attempt-round-${round}.json`), JSON.stringify(captures));
    checks.push({ round, ...compareLocalDirect(captures) }); await page.screenshot({ path: path.join(out, `round-${round}.png`) }); rounds.push(captures);
  }
  assert.deepEqual(errors, []); assert.deepEqual(rounds[0], rounds[1], "fresh formal rounds drifted"); assert.deepEqual(await identities(), sources, "source changed during actual execution");
  const evidence = { passed: true, stable: true, qualityCertified: checks.every(check => check.qualityCertified), sources, bundleHash, checks,
    scope: "formal shared-root clustered directional/point/spot direct multiscattering; primary zero; original Three baseline",
    excluded: ["Native", "LTC area lights", "experimental visibility resolve", "performance", "complete Studio scene"] };
  await writeFile(path.join(out, "rounds.json"), JSON.stringify(rounds)); await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) { await rm(path.join(out, "evidence.json"), { force: true }); throw error; }
finally { try { await browser?.close(); } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); } }
