import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadCsmBoundaryOracle } from "./lib/loadCsmBoundaryOracle.mjs";
import { compareCsmLinear } from "./lib/j2CsmLinearParity.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)), out = path.join(root, "test-output/interrupted-0930/csm-linear");
const flags = new Set(process.argv.slice(2));
for (const flag of flags) if (!["--compare", "--web-only"].includes(flag)) throw Error(`Unknown option ${flag}`);
if (flags.size > 1) throw Error("Choose --compare or --web-only");
await mkdir(out, { recursive: true });
const fixtureText = await readFile(path.join(root, "packages/deep-engine/fixtures/j2-csm-parity-v1.json"), "utf8");
const fixture = JSON.parse(fixtureText), fixtureHash = createHash("sha256").update(fixtureText).digest("hex");
const nativePath = path.join(out, "native.json"), webPath = path.join(out, "web.json"), evidencePath = path.join(out, "evidence.json");
if (!flags.has("--compare")) {
  await rm(webPath, { force: true }); await rm(evidencePath, { force: true });
  if (!flags.has("--web-only")) {
    await rm(nativePath, { force: true });
    const cargo = spawnSync("cargo", ["test", "--manifest-path", "packages/deep-engine-native/Cargo.toml", "--locked",
      "--test", "cascaded_shadow", "j2_b4_actual_native_csm_linear", "--", "--ignored"], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 600000,
    });
    const log = (cargo.stdout ?? "") + (cargo.stderr ?? ""); await writeFile(path.join(out, "native.log"), log);
    if (cargo.error || cargo.status !== 0 || !/test j2_csm_linear::j2_b4_actual_native_csm_linear \.\.\. ok/.test(log)
      || !/test result: ok\. [1-9]\d* passed/.test(log)) {
      await rm(nativePath, { force: true }); throw Error(`Current Native CSM test failed or did not execute (${cargo.status}); see native.log`);
    }
    await readFile(nativePath, "utf8");
  }
  const require = createRequire(import.meta.url), { build } = require("../packages/deep-engine/node_modules/esbuild");
  await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/j2CsmBoundaryGpuProbe.ts")],
    outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
  const source = await readFile(path.join(root, "packages/deep-engine/wgsl/cascadedShadowMath.wgsl"), "utf8") + "\n"
    + await readFile(path.join(root, "packages/deep-engine-native/assets/shaders/native_cascaded_shadow_v1.wgsl"), "utf8");
  const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
  const server = createServer(async (request, response) => {
    if (request.url === "/probe.mjs") { response.setHeader("Content-Type", "text/javascript"); response.end(await readFile(path.join(out, "probe.mjs"))); }
    else { response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<html data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body style="padding:24px;background:var(--bg-0);color:var(--text-strong)"><h1>级联阴影边界</h1><p>共同输入 · 实际比较采样 · linear 与 nearest</p><table id="results" style="font-size:12px;border-spacing:12px 5px"></table></body></html>`); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core"); let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: true, args: ["--enable-unsafe-webgpu"] });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const runs = [];
    for (let round = 0; round < 2; round++) {
      const result = await page.evaluate(async ({ source, fixture }) =>
        (await import("/probe.mjs")).runJ2CsmBoundaryGpuProbe(source, fixture), { source, fixture });
      runs.push(result);
      await page.evaluate(result => {
        const table = document.querySelector("#results"); table.replaceChildren();
        for (const row of result.results) {
          const tr = document.createElement("tr");
          for (const value of [row.id, row.filter, row.pattern, row.blendStart, row.passed ? "通过" : "失败", row.maxError.toExponential(2)]) {
            const td = document.createElement("td"); td.textContent = String(value); tr.append(td);
          }
          const td = document.createElement("td"), canvas = document.createElement("canvas");
          canvas.width = row.values.length; canvas.height = 1; canvas.style.cssText = "width:392px;height:12px;image-rendering:pixelated";
          const pixels = new Uint8ClampedArray(row.values.flatMap(value => { const gray = Math.round(value * 255); return [gray, gray, gray, 255]; }));
          canvas.getContext("2d").putImageData(new ImageData(pixels, row.values.length, 1), 0, 0); td.append(canvas); tr.append(td); table.append(tr);
        }
      }, result);
      await page.screenshot({ path: path.join(out, `frame-${round}.png`) });
    }
    const web = { fixtureHash, runs, passed: runs.every(run => run.passed) };
    await writeFile(webPath, `${JSON.stringify(web, null, 2)}\n`);
    if (!web.passed) throw Error("Actual Chrome CSM sampling failed");
  } finally { try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); } }
}
if (flags.has("--web-only")) console.log(`Web-only actual CSM evidence: ${webPath}`);
else {
  const evidence = compareCsmLinear(fixture, fixtureHash, JSON.parse(await readFile(webPath, "utf8")),
    JSON.parse(await readFile(nativePath, "utf8")), await loadCsmBoundaryOracle());
  const result = { ...evidence, currentRun: !flags.has("--compare"),
    evidenceMode: flags.has("--compare") ? "historical file comparison; no host executed" : "both actual GPU hosts executed in this run" };
  await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`); console.log(JSON.stringify(result, null, 2));
}
