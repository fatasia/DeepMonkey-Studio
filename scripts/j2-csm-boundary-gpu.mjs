import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test-output/interrupted-0930/csm-boundary");
const baseline = process.argv.includes("--baseline");
await mkdir(out, { recursive: true });
const require = createRequire(import.meta.url);
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/j2CsmBoundaryGpuProbe.ts")],
  outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
const native = await readFile(path.join(root, "packages/deep-engine-native/assets/shaders/native_cascaded_shadow_v1.wgsl"), "utf8");
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const server = createServer(async (request, response) => {
  if (request.url === "/probe.mjs") { response.setHeader("Content-Type", "text/javascript"); response.end(await readFile(path.join(out, "probe.mjs"))); }
  else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<html><head><meta charset="utf-8"><style>${css}</style></head><body style="padding:24px;background:var(--bg-0);color:var(--text-strong)"><h1>CSM 边界采样</h1><div id="results"></div></body></html>`);
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true, args: ["--enable-unsafe-webgpu"] });
  const page = await browser.newPage({ viewport: { width: 980, height: 800 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const runs = [];
  for (let round = 1; round <= 2; round++) {
    const result = await page.evaluate(async source => (await import("/probe.mjs")).runJ2CsmBoundaryGpuProbe(source), native);
    runs.push(result);
    await page.evaluate(result => {
      const root = document.querySelector("#results"); root.replaceChildren();
      for (const row of result.results) {
        const label = document.createElement("p"); label.textContent = `${row.id} · blendStart=${row.blendStart} · ${row.passed ? "通过" : "失败"}`; root.append(label);
        const canvas = document.createElement("canvas"); canvas.width = row.values.length; canvas.height = 1;
        canvas.style.cssText = "width:560px;height:32px;image-rendering:pixelated";
        const pixels = new Uint8ClampedArray(row.values.flatMap(value => { const gray = Number.isFinite(value) ? Math.round(value * 255) : 0; return [gray, gray, gray, 255]; }));
        canvas.getContext("2d").putImageData(new ImageData(pixels, row.values.length, 1), 0, 0); root.append(canvas);
      }
    }, result);
    await page.screenshot({ path: path.join(out, `${baseline ? "baseline" : "after"}-round-${round}.png`) });
  }
  const stable = JSON.stringify(runs[0]) === JSON.stringify(runs[1]);
  let beforeAfterValuesEqual = null;
  if (!baseline) {
    const previous = await readFile(path.join(out, "baseline.json"), "utf8").then(JSON.parse).catch(error => {
      if (error.code === "ENOENT") return undefined; throw error;
    });
    if (previous) {
      const values = evidence => evidence.runs.map(run => run.results.map(row => ({ id: row.id,
        blendStart: row.blendStart, depths: row.depths, values: row.values })));
      beforeAfterValuesEqual = JSON.stringify(values(previous)) === JSON.stringify(values({ runs }));
    }
  }
  const evidence = { passed: stable && runs.every(result => result.passed), stable, beforeAfterValuesEqual, runs };
  await writeFile(path.join(out, `${baseline ? "baseline" : "evidence"}.json`), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  if (!baseline && !evidence.passed) process.exitCode = 1;
} finally { try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); } }
