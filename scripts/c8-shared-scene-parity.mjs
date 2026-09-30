import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { compareSharedScene } from "./lib/c8SharedSceneParity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const out = path.join(root, "test-output/interrupted-0930/c8-shared-scene");
const sourceFiles = ["packages/deep-engine/lab/c8SharedSceneFixture.ts", "packages/deep-engine/lab/c8SharedSceneProbe.ts",
  "packages/deep-engine/lab/c8SharedSceneReadback.ts", "packages/deep-engine/src/threeBridge/DeepWebGpuBackend.ts",
  "packages/deep-engine/src/threeBridge/ThreeProjectionBridge.ts", "packages/deep-engine/src/webgpu/pbrRenderer.ts",
  "apps/web/src/viewer/threeMaterialMath.ts", "apps/web/src/viewer/threeDisplayToneMapping.ts",
  "scripts/c8-shared-scene-parity.mjs", "scripts/lib/c8SharedSceneParity.mjs"];
const hash = data => createHash("sha256").update(data).digest("hex");
await mkdir(out, { recursive: true });
await Promise.all(["evidence.json", "rounds.json", "round-1.png", "round-2.png"].map(file => rm(path.join(out, file), { force: true })));
const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(path.join(root, file)))])));
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/c8SharedSceneProbe.ts")], outfile: path.join(out, "probe.mjs"),
  bundle: true, format: "esm", platform: "browser", conditions: ["development"] });
const bundleHash = hash(await readFile(path.join(out, "probe.mjs")));
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const html = `<html><head><meta charset="utf-8"><style>${css}</style></head><body style="padding:24px;background:var(--bg-0);color:var(--text-strong)"><h2 style="margin:0 0 8px">共同作者场景 · Three / Deep WebGPU</h2><p style="margin:0 0 16px">每组左：Three，右：Deep。自发光严格对照；直射 BRDF 差异诊断。原始附件 320 × 192。</p><div id="frames" style="display:grid;grid-template-columns:repeat(2,624px);gap:16px"></div></body></html>`;
const server = createServer(async (request, response) => {
  try { response.setHeader("Content-Type", request.url === "/probe.mjs" ? "text/javascript" : "text/html");
    response.end(request.url === "/probe.mjs" ? await readFile(path.join(out, "probe.mjs")) : html); }
  catch (error) { response.statusCode = 500; response.end(String(error)); }
});
let browser;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
  browser = await chromium.launch({ headless: true, executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce", colorScheme: "dark" });
  const errors = []; page.on("pageerror", error => errors.push(String(error)));
  const rounds = [], checks = [];
  for (let round = 1; round <= 2; round++) {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const run = await page.evaluate(async () => (await import("/probe.mjs")).runSharedSceneProbe());
    await writeFile(path.join(out, `attempt-round-${round}.json`), JSON.stringify(run));
    assert.equal(run.width, 320); assert.equal(run.height, 192);
    checks.push({ round, ...compareSharedScene(run) });
    await page.evaluate(run => {
      const host = document.querySelector("#frames");
      for (const frame of run.frames) {
        const card = document.createElement("div"), label = document.createElement("p");
        label.textContent = frame.name; label.style.cssText = "margin:0 0 8px"; card.append(label);
        for (const key of ["three", "deep"]) {
          const canvas = document.createElement("canvas"); canvas.width = run.width; canvas.height = run.height;
          canvas.style.cssText = "width:288px;height:173px;margin-right:16px";
          canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(frame[key].display), run.width, run.height), 0, 0); card.append(canvas);
        } host.append(card);
      }
    }, run);
    await page.screenshot({ path: path.join(out, `round-${round}.png`) }); rounds.push(run);
  }
  assert.deepEqual(errors, []); assert.deepEqual(rounds[0], rounds[1], "fresh realm rounds must be stable");
  const evidence = { passed: true, stable: true, sources, bundleHash, checks, profile: rounds[0].profile,
    diagnostics: rounds[0].diagnostics, scope: "same author root, formal projection, emissive HDR and output strict subset; real direct BRDF diagnostic",
    excluded: ["complete BRDF equivalence", "textures/transmission/transparency", "IBL/post-processing", "device loss", "performance"] };
  await writeFile(path.join(out, "rounds.json"), JSON.stringify(rounds));
  await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  await rm(path.join(out, "evidence.json"), { force: true }); throw error;
} finally { try { await browser?.close(); } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); } }
