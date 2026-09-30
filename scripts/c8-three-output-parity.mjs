import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url), root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test-output/interrupted-0930/c8-three-output");
await mkdir(out, { recursive: true });
await rm(path.join(out, "evidence.json"), { force: true });
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/threeDisplayOutputProbe.ts")],
  outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const html = `<html><head><meta charset="utf-8"><style>${css}</style></head><body style="background:var(--bg-0);color:var(--text-strong);font:15px sans-serif;margin:24px"><h2>C8 Three OutputPass: original / paired ACES</h2><div id="frames"></div></body></html>`;
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/probe.mjs") { response.setHeader("Content-Type", "text/javascript"); response.end(await readFile(path.join(out, "probe.mjs"))); }
    else response.end(html);
  } catch (error) { response.statusCode = 500; response.end(String(error)); }
});
const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
let browser;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1100 } });
  const consoleErrors = [];
  page.on("pageerror", error => consoleErrors.push(String(error)));
  const rounds = [], results = [];
  for (let round = 1; round <= 2; round++) {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const run = await page.evaluate(async () => (await import("/probe.mjs")).runThreeDisplayOutputProbe());
    assert.equal(run.es100, true); assert.equal(run.es300, true); assert.deepEqual(run.errors, []);
    assert.equal(run.width, 96); assert.equal(run.height, 32); assert.equal(run.frames.length, 10);
    const checks = run.frames.map(frame => {
      assert.equal(frame.baseline.length, 96 * 32 * 4); assert.equal(frame.adapted.length, frame.baseline.length);
      assert(frame.adapted.some((v, i) => i % 4 !== 3 && v > 0), "black output must fail");
      assert(frame.adapted.every(v => Number.isInteger(v) && v >= 0 && v <= 255));
      const maxByteDifference = Math.max(...frame.adapted.map((value, i) => Math.abs(value - frame.baseline[i])));
      assert(maxByteDifference <= (frame.aces ? 1 : 0), `${frame.name} difference ${maxByteDifference}`);
      return { name: frame.name, maxByteDifference };
    });
    await page.evaluate(run => {
      const host = document.querySelector("#frames");
      for (const frame of run.frames) {
        const row = document.createElement("div"), label = document.createElement("div");
        label.textContent = frame.name; row.append(label); row.style.marginBottom = "12px";
        for (const key of ["baseline", "adapted"]) {
          const canvas = document.createElement("canvas"); canvas.width = run.width; canvas.height = run.height;
          canvas.style.cssText = "width:480px;height:48px;image-rendering:pixelated;margin-right:8px";
          canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(frame[key]), run.width, run.height), 0, 0); row.append(canvas);
        }
        host.append(row);
      }
    }, run);
    await page.screenshot({ path: path.join(out, `round-${round}.png`), fullPage: true });
    rounds.push(run); results.push({ round, checks });
  }
  assert.deepEqual(consoleErrors, []); assert.deepEqual(rounds[0], rounds[1], "fresh renderer rounds must be stable");
  const evidence = { passed: true, stable: true, scope: "actual Three OutputPass fixed HDR color output only", results,
    identities: rounds[0].identities, es100: true, es300: true,
    excluded: ["full scenes", "lighting/materials", "combined grading/bloom/SSAO", "performance benchmark"] };
  await writeFile(path.join(out, "rounds.json"), JSON.stringify(rounds));
  await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  try { await browser?.close(); }
  finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
}
