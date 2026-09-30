import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { compareDirectMaterialChain } from "./lib/c8DirectMaterialChainParity.mjs";
import { compareSharedScene } from "./lib/c8SharedSceneParity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const out = path.join(root, "test-output/interrupted-0930/c8-direct-material-chain"), hash = data => createHash("sha256").update(data).digest("hex");
await mkdir(out, { recursive: true });
await Promise.all(["evidence.json", "diagnostic.json", "rounds.json", "round-1.png", "round-2.png"].map(file => rm(path.join(out, file), { force: true })));
const files = ["packages/deep-engine/lab/c8SharedSceneProbe.ts", "packages/deep-engine/lab/c8SharedSceneFixture.ts", "packages/deep-engine/lab/c8SharedSceneReadback.ts",
  "packages/deep-engine/src/webgpu/pbrShader.ts", "packages/deep-engine/src/webgpu/pbrDirectMultiscatteringWgsl.ts",
  "packages/deep-engine/wgsl/brdfDirectMultiscattering.wgsl", "packages/deep-engine/wgsl/directDisplay.wgsl",
  "packages/deep-engine/src/webgpu/environmentShader.ts", "packages/deep-engine/src/threeBridge/threeDirectMaterialProfile.ts",
  "scripts/c8-direct-material-chain-parity.mjs", "scripts/lib/c8DirectMaterialChainParity.mjs", "scripts/lib/c8SharedSceneParity.mjs"];
const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(path.join(root, file)))])));
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/c8SharedSceneProbe.ts")], outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser", conditions: ["development"] });
const bundleHash = hash(await readFile(path.join(out, "probe.mjs"))), css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const html = `<html><head><meta charset="utf-8"><style>${css}</style></head><body style="padding:24px;background:var(--bg-0);color:var(--text-strong)"><h2 style="margin:0 0 8px">原 Three r185 / Deep · 完整直射材质链</h2><p style="margin:0 0 16px">每组左：原 Three，右：Deep。相同材质 / 作者光照，固定曝光 0.5 / ACES。真实共同 RGBA16F 附件，近景与远景控制组。</p><div id="frames" style="display:grid;grid-template-columns:repeat(2,624px);gap:16px"></div></body></html>`;
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
    for (const [view, cameraScale] of [["near", .6], ["far", 1]]) for (const attachment of ["raw", "shared-rgba16f"]) {
      const probePage = await browser.newPage(); let run;
      try { await probePage.goto(`http://127.0.0.1:${server.address().port}`);
        run = await probePage.evaluate(async ({ cameraScale, attachment }) => (await import("/probe.mjs")).runSharedSceneProbe({ exposures: [.5], directProfile: "three-r185", cameraScale, ...(attachment === "shared-rgba16f" ? { hdrAttachmentProfile: attachment } : {}) }), { cameraScale, attachment });
      } finally { await probePage.close(); }
      const observation = compareSharedScene(run, { exposures: [.5] }); let quality;
      try { quality = compareDirectMaterialChain(run, "three-r185"); }
      catch (error) { quality = { passed: false, error: String(error), finalDirectStrict: false }; }
      checks.push({ round, view, attachment, observation, quality }); captures.push({ view, attachment, run });
      if (attachment === "raw") continue;
      await page.evaluate(({ view, run }) => {
        const host = document.querySelector("#frames");
        for (const frame of run.frames) {
          const card = document.createElement("div"), label = document.createElement("p"); label.textContent = `${view} · ${frame.name}`; label.style.cssText = "margin:0 0 8px"; card.append(label);
          for (const key of ["three", "deep"]) { const canvas = document.createElement("canvas"); canvas.width = run.width; canvas.height = run.height; canvas.style.cssText = "width:288px;height:173px;margin-right:16px";
            canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(frame[key].display), run.width, run.height), 0, 0); card.append(canvas); } host.append(card);
        }
      }, { view, run });
    }
    await page.screenshot({ path: path.join(out, `round-${round}.png`) }); rounds.push(captures);
  }
  assert.deepEqual(errors, []); assert.deepEqual(rounds[0], rounds[1], "fresh production rounds drifted");
  const passed = checks.filter(check => check.attachment === "shared-rgba16f").every(check => check.quality.passed), evidence = { passed, stable: true, sources, bundleHash, checks, scope: "original Three r185 versus production Deep primary direct chain; near/far shared-rgba16f GPU attachment; original raw FP32 control separately reported", excluded: ["Native", "clustered direct", "performance", "complete Studio scene"] };
  await writeFile(path.join(out, "rounds.json"), JSON.stringify(rounds)); await writeFile(path.join(out, "diagnostic.json"), JSON.stringify(evidence, null, 2));
  if (passed) await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2)); assert(passed, "original Three strict direct gate remains unmet; inspect diagnostic.json");
} finally { try { await browser?.close(); } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); } }
