import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { compareFragmentObservables } from "./lib/c8FragmentObservables.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const out = path.join(root, "test-output/interrupted-0930/c8-fragment-observables"), hash = data => createHash("sha256").update(data).digest("hex");
await mkdir(out, { recursive: true });
await Promise.all(["evidence.json", "failure.json", "rounds.json", "round-1.png", "round-2.png"].map(file => rm(path.join(out, file), { force: true })));
const files = ["packages/deep-engine/lab/c8FragmentObservablesShader.ts", "packages/deep-engine/lab/c8FragmentObservablesProbe.ts",
  "packages/deep-engine/lab/c8SharedSceneProbe.ts", "packages/deep-engine/lab/c8SharedSceneFixture.ts", "packages/deep-engine/lab/c8SharedSceneReadback.ts",
  "packages/deep-engine/src/webgpu/pbrShader.ts", "packages/deep-engine/src/webgpu/environmentShader.ts", "scripts/c8-fragment-observables.mjs", "scripts/lib/c8FragmentObservables.mjs"];
const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(path.join(root, file)))])));
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/c8FragmentObservablesProbe.ts")], outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser", conditions: ["development"] });
const bundleHash = hash(await readFile(path.join(out, "probe.mjs"))), css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const html = `<html><head><meta charset="utf-8"><style>${css}</style></head><body style="padding:24px;background:var(--bg-0);color:var(--text-strong)"><h2 style="margin:0 0 8px">正式片元观测 · Three r185 / Deep</h2><p style="margin:0 0 16px">每组左：Three，右：Deep。geometry：NV / NL / 有效粗糙度；single：原单散射直射。观察色不代表最终材质效果。</p><div id="frames" style="display:grid;grid-template-columns:repeat(2,624px);gap:16px"></div></body></html>`;
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
  const errors = [], rounds = [], checks = []; page.on("pageerror", error => errors.push(String(error)));
  for (let round = 1; round <= 2; round++) {
    await page.goto(`http://127.0.0.1:${server.address().port}`); const captures = [];
    for (const [view, cameraScale] of [["near", .6], ["far", 1]]) {
      const capture = { view };
      for (const mode of ["geometry", "single"]) {
        const probePage = await browser.newPage();
        try { await probePage.goto(`http://127.0.0.1:${server.address().port}`);
          capture[mode] = await probePage.evaluate(async ({ mode, cameraScale }) => (await import("/probe.mjs")).runFragmentObservable(mode, cameraScale), { mode, cameraScale });
        } finally { await probePage.close(); }
        await page.evaluate(({ view, mode, run }) => {
          const host = document.querySelector("#frames");
          for (const frame of run.frames.filter(frame => frame.stage === "direct-diagnostic")) {
            const card = document.createElement("div"), label = document.createElement("p"); label.textContent = `${view} · ${mode} · ${frame.name}`; label.style.cssText = "margin:0 0 8px"; card.append(label);
            for (const key of ["three", "deep"]) { const canvas = document.createElement("canvas"); canvas.width = run.width; canvas.height = run.height; canvas.style.cssText = "width:288px;height:173px;margin-right:16px";
              canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(frame[key].display), run.width, run.height), 0, 0); card.append(canvas); } host.append(card);
          }
        }, { view, mode, run: capture[mode].run });
      }
      captures.push(capture);
    }
    checks.push(compareFragmentObservables(captures)); rounds.push(captures);
    await page.screenshot({ path: path.join(out, `round-${round}.png`) });
  }
  assert.deepEqual(errors, []); assert.deepEqual(rounds[0], rounds[1], "fresh fragment observation rounds drifted");
  const evidence = { passed: true, qualityCertified: false, stable: true, sources, bundleHash, checks, scope: "actual original production fragment inputs and single response; S5 quality gate unchanged" };
  await writeFile(path.join(out, "rounds.json"), JSON.stringify(rounds)); await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  await writeFile(path.join(out, "failure.json"), JSON.stringify({ passed: false, sources, bundleHash, error: String(error) }, null, 2)); throw error;
} finally { try { await browser?.close(); } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); } }
