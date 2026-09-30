import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { compareDerivativeVectors } from "./lib/c8DerivativeVectors.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url), hash = data => createHash("sha256").update(data).digest("hex");
const out = path.join(root, "test-output/interrupted-0930/c8-derivative-vectors");
await mkdir(out, { recursive: true });
await Promise.all(["evidence.json", "failure.json", "rounds.json", "round-1.png", "round-2.png"].map(file => rm(path.join(out, file), { force: true })));
const files = ["packages/deep-engine/lab/c8FragmentObservablesShader.ts", "packages/deep-engine/lab/c8FragmentObservablesProbe.ts", "packages/deep-engine/lab/c8SharedSceneProbe.ts",
  "packages/deep-engine/lab/c8SharedSceneFixture.ts", "packages/deep-engine/lab/c8SharedSceneReadback.ts", "packages/deep-engine/src/webgpu/pbrShader.ts", "packages/deep-engine/src/webgpu/environmentShader.ts",
  "packages/deep-engine/wgsl/brdfDirectLighting.wgsl", "scripts/c8-derivative-vectors.mjs", "scripts/lib/c8DerivativeVectors.mjs"];
const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(path.join(root, file)))])));
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/c8FragmentObservablesProbe.ts")], outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser", conditions: ["development"] });
const bundleHash = hash(await readFile(path.join(out, "probe.mjs"))), css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const html = `<html><head><meta charset="utf-8"><style>${css}</style></head><body style="padding:24px;background:var(--bg-0);color:var(--text-strong)"><h2>正式导数向量 · Three default / Deep default</h2><p>每组左：原 Three，右：Deep。观察 RGB：view-normal 编码 / abs(dx) / abs(dy)（按标签）；曝光 0.5。诊断色不代表最终画质。</p><div id="frames" style="display:grid;grid-template-columns:repeat(2,624px);gap:16px"></div></body></html>`;
const server = createServer(async (request, response) => { try { response.setHeader("Content-Type", request.url === "/probe.mjs" ? "text/javascript" : "text/html"); response.end(request.url === "/probe.mjs" ? await readFile(path.join(out, "probe.mjs")) : html); } catch (error) { response.statusCode = 500; response.end(String(error)); } });
let browser;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
  browser = await chromium.launch({ headless: true, executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark", reducedMotion: "reduce" }), rounds = [], checks = [], errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  for (let round = 1; round <= 2; round++) {
    await page.goto(`http://127.0.0.1:${server.address().port}`); const captures = [];
    for (const mode of ["view-normal", "abs-dx", "abs-dy"]) {
      const probePage = await browser.newPage(); let capture;
      try { await probePage.goto(`http://127.0.0.1:${server.address().port}`);
        capture = { mode, ...await probePage.evaluate(async mode => (await import("/probe.mjs")).runFragmentObservable(mode, 1), mode) };
      } finally { await probePage.close(); }
      captures.push(capture);
      await page.evaluate(({ mode, run }) => { const host = document.querySelector("#frames");
        for (const frame of run.frames.filter(f => f.stage === "direct-diagnostic")) { const card = document.createElement("div"), label = document.createElement("p"); label.textContent = `${mode} · ${frame.name}`; card.append(label);
          for (const key of ["three", "deep"]) { const canvas = document.createElement("canvas"); canvas.width = run.width; canvas.height = run.height; canvas.style.cssText = "width:288px;height:173px;margin-right:16px";
            canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(frame[key].display), run.width, run.height), 0, 0); card.append(canvas); } host.append(card); }
      }, { mode, run: capture.run });
    }
    checks.push(compareDerivativeVectors(captures)); rounds.push(captures);
    await page.screenshot({ path: path.join(out, `round-${round}.png`) });
  }
  assert.deepEqual(errors, []); assert.deepEqual(rounds[0], rounds[1], "fresh default derivative vector rounds drifted");
  const evidence = { passed: true, qualityCertified: false, stable: true, sources, bundleHash, checks, scope: "actual default view-normal/dx/dy observations; S5 final gate unchanged" };
  await writeFile(path.join(out, "rounds.json"), JSON.stringify(rounds)); await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
} catch (error) { await writeFile(path.join(out, "failure.json"), JSON.stringify({ passed: false, sources, bundleHash, error: String(error) }, null, 2)); throw error; }
finally { try { await browser?.close(); } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); } }
