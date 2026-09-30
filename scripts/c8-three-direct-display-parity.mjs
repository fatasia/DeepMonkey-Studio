import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const out = path.join(root, "test-output/interrupted-0930/c8-three-direct");
await mkdir(out, { recursive: true }); await rm(path.join(out, "evidence.json"), { force: true });
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/threeDirectDisplayProbe.ts")], outfile: path.join(out, "probe.mjs"),
  bundle: true, format: "esm", platform: "browser", conditions: ["development"] });
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const html = `<html><head><meta charset="utf-8"><style>${css}</style></head><body style="padding:24px;background:var(--bg-0);color:var(--text-strong)"><h2>Three 直渲显示数学 · 原 Three / 公共拟合</h2><div id="frames"></div></body></html>`;
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
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
  const errors = []; page.on("pageerror", error => errors.push(String(error)));
  const rounds = [], checks = [];
  for (let round = 1; round <= 2; round++) {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const run = await page.evaluate(async () => (await import("/probe.mjs")).runThreeDirectDisplayProbe());
    assert.equal(run.width, 96); assert.equal(run.height, 32); assert.equal(run.frames.length, 20); assert.deepEqual(run.errors, []);
    checks.push({ round, frames: run.frames.map(frame => {
      assert.equal(frame.baseline.length, 96 * 32 * 4); assert.equal(frame.adapted.length, frame.baseline.length);
      assert(frame.adapted.some((value, lane) => lane % 4 !== 3 && value > 0), "all-black geometry must fail");
      let maxByteDifference = 0;
      for (let lane = 0; lane < frame.adapted.length; lane++) {
        const value = frame.adapted[lane]; assert(Number.isInteger(value) && value >= 0 && value <= 255);
        maxByteDifference = Math.max(maxByteDifference, Math.abs(value - frame.baseline[lane]));
      }
      assert(maxByteDifference <= (frame.aces ? 1 : 0), `${frame.name}: byte difference ${maxByteDifference}`);
      return { name: frame.name, maxByteDifference };
    }) });
    await page.evaluate(run => {
      const host = document.querySelector("#frames");
      for (const frame of run.frames) {
        const row = document.createElement("div"); row.style.cssText = "display:flex;gap:16px;align-items:center;margin-bottom:12px";
        const label = document.createElement("span"); label.style.width = "200px"; label.textContent = frame.name; row.append(label);
        for (const key of ["baseline", "adapted"]) {
          const canvas = document.createElement("canvas"); canvas.width = run.width; canvas.height = run.height;
          canvas.style.cssText = "width:384px;height:32px;image-rendering:pixelated";
          canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(frame[key]), run.width, run.height), 0, 0); row.append(canvas);
        }
        host.append(row);
      }
    }, run);
    await page.screenshot({ path: path.join(out, `round-${round}.png`) }); rounds.push(run);
  }
  assert.deepEqual(errors, []); assert.deepEqual(rounds[0], rounds[1], "fresh realm and renderer rounds must be stable");
  const evidence = { passed: true, stable: true, scope: "actual Three Basic/Standard/Physical default framebuffer tone mapping and composed S2 guard", checks,
    identities: rounds[0].identities, excluded: ["full scenes", "lighting integration", "performance", "material hook expansion"] };
  await writeFile(path.join(out, "rounds.json"), JSON.stringify(rounds)); await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { try { await browser?.close(); } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); } }
