import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { baselineOf, evaluateParityRun, measureFrame, PARITY_TIERS } from "./lib/parityGateMetrics.mjs";

// three ↔ Deep(WebGPU) 像素一致性门：五个标准场景（PBR 矩阵 / IBL / 方向光阴影 / AA+Bloom / 透明），
// 复用 c8SharedScene 的作者根投影、真实生产 PbrRenderer 与 HDR/表面读回。无硬件 WebGPU 时 fail-closed，绝不静默通过。
const only = process.argv.find(arg => arg.startsWith("--only="))?.slice(7).split(",");
const calibrate = process.argv.includes("--calibrate") || only !== undefined;
const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const out = path.join(root, "test-output/parity-gate");
const sourceFiles = ["packages/deep-engine/lab/parityGateScenes.ts", "packages/deep-engine/lab/parityGateThree.ts", "packages/deep-engine/lab/parityGateProbe.ts",
  "packages/deep-engine/lab/c8SharedSceneFixture.ts", "packages/deep-engine/lab/c8SharedSceneReadback.ts", "packages/contracts/src/displayContract.ts",
  "scripts/gate-parity.mjs", "scripts/lib/parityGateMetrics.mjs", "scripts/lib/parityGateThresholds.mjs"];
const hash = data => createHash("sha256").update(data).digest("hex");
const fail = message => { console.error(`gate:parity FAILED — ${message}`); process.exitCode = 1; };

await mkdir(out, { recursive: true });
await rm(path.join(out, "evidence.json"), { force: true });
const { PARITY_EXPECTATIONS } = calibrate ? { PARITY_EXPECTATIONS: undefined } : await import("./lib/parityGateThresholds.mjs");
const sources = Object.fromEntries(await Promise.all(sourceFiles.filter(file => existsSync(path.join(root, file))).map(async file => [file, hash(await readFile(path.join(root, file)))])));
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/parityGateProbe.ts")], outfile: path.join(out, "probe.mjs"),
  bundle: true, format: "esm", platform: "browser", conditions: ["development"], logLevel: "error" });
const bundleHash = hash(await readFile(path.join(out, "probe.mjs")));
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const html = `<html><head><meta charset="utf-8"><style>${css}</style></head><body style="height:auto;min-height:0;overflow:visible;padding:20px;background:var(--bg-0);color:var(--text-strong);font:13px/1.4 var(--font-sans,system-ui)"><h2 style="margin:0 0 6px">three ↔ Deep 像素一致性门 · 320×192 · 深色</h2><p style="margin:0 0 14px;color:var(--text-muted,#9aa)">每卡左→右：three / Deep / |Δ|×4。分级：严格 · 容许 · 诊断（已知缺口 = 基线 + 回归守卫）。</p><div id="frames" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 18px"></div></body></html>`;
const server = createServer(async (request, response) => {
  try { response.setHeader("Content-Type", request.url === "/probe.mjs" ? "text/javascript" : "text/html");
    response.end(request.url === "/probe.mjs" ? await readFile(path.join(out, "probe.mjs")) : html); }
  catch (error) { response.statusCode = 500; response.end(String(error)); }
});
let browser;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
  const executablePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  if (!existsSync(executablePath)) throw Error(`Chrome not found at ${executablePath}; set BIM_STUDIO_CHROME_PATH`);
  browser = await chromium.launch({ headless: true, executablePath, args: process.env.BIM_STUDIO_CHROME_ARGS?.split(" ").filter(Boolean) ?? [] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce", colorScheme: "dark" });
  const errors = []; page.on("pageerror", error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const adapter = await page.evaluate(async () => {
    const found = await navigator.gpu?.requestAdapter(); if (!found) return null;
    const info = found.info ?? {}; return { vendor: info.vendor, architecture: info.architecture, description: info.description, isFallbackAdapter: found.isFallbackAdapter === true };
  });
  if (!adapter || adapter.isFallbackAdapter) {
    throw Error(`no hardware WebGPU adapter (${adapter ? "software fallback adapter only" : "navigator.gpu unavailable"}). Pixel parity needs a real GPU; this gate never passes silently without one.`);
  }
  const rounds = [];
  for (let round = 1; round <= 2; round++) {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    rounds.push(await page.evaluate(async options => (await import("/probe.mjs")).runParityGateProbe(options), only ? { scenarios: only } : {}));
  }
  assert.deepEqual(errors, [], "page errors"); assert.deepEqual(rounds[0].errors, []);
  const run = rounds[0], stable = JSON.stringify(rounds[0].scenarios) === JSON.stringify(rounds[1].scenarios);
  const scenarios = run.scenarios.map(scenario => ({ id: scenario.id, drawCalls: { three: scenario.three.drawCalls, deep: scenario.deep.drawCalls },
    triangles: { three: scenario.three.triangles, deep: scenario.deep.triangles }, deepShadow: { tier: scenario.deep.shadowTier, mapSize: scenario.deep.shadowMapSize },
    metrics: measureFrame({ width: run.width, height: run.height, three: scenario.three.display, deep: scenario.deep.display, threeHdr: scenario.three.hdr, deepHdr: scenario.deep.hdr }) }));
  await page.evaluate(({ run, scenarios }) => {
    const host = document.querySelector("#frames");
    const paint = (canvas, data) => canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), run.width, run.height), 0, 0);
    for (const frame of run.scenarios) {
      const card = document.createElement("div"), label = document.createElement("p"), metrics = scenarios.find(item => item.id === frame.id).metrics;
      label.textContent = `${frame.id} · RMSE ${metrics.rmse.toFixed(2)} · ΔE00 ${metrics.deltaE2000.mean.toFixed(2)} (p99 ${metrics.deltaE2000.p99.toFixed(1)}) · SSIM ${metrics.ssim.mean.toFixed(4)}`;
      label.style.cssText = "margin:0 0 6px;font-variant-numeric:tabular-nums"; card.append(label);
      const diff = frame.three.display.map((value, index) => index % 4 === 3 ? 255 : Math.min(255, Math.abs(value - frame.deep.display[index]) * 4));
      for (const [key, data] of [["three", frame.three.display], ["deep", frame.deep.display], ["diff", diff]]) {
        const canvas = document.createElement("canvas"); canvas.width = run.width; canvas.height = run.height; canvas.dataset.name = `${frame.id}-${key}`;
        canvas.style.cssText = `width:300px;height:180px;margin-right:6px;image-rendering:pixelated`; paint(canvas, data); card.append(canvas);
      }
      host.append(card);
    }
  }, { run, scenarios });
  for (const item of await page.evaluate(() => [...document.querySelectorAll("canvas")].map(canvas => ({ name: canvas.dataset.name, url: canvas.toDataURL("image/png") })))) {
    await writeFile(path.join(out, `${item.name}.png`), Buffer.from(item.url.split(",")[1], "base64"));
  }
  await page.screenshot({ path: path.join(out, "overview.png"), fullPage: true });
  const base = { stable, sources, bundleHash, adapter, width: run.width, height: run.height, profile: run.profile, tiers: PARITY_TIERS,
    metricsDefinition: "RGB8 whole-frame RMSE; ΔE = CIEDE2000 and ΔE76 on sRGB(D65)→Lab; SSIM = 20×16 block luma SSIM; byteMax over RGBA",
    extendedLobeGaps: run.extendedLobeGaps };
  if (calibrate) {
    const candidate = Object.fromEntries(scenarios.map(item => [item.id, baselineOf(item.metrics)]));
    await writeFile(path.join(out, "calibration.json"), JSON.stringify({ ...base, scenarios, candidate }, null, 2));
    console.log(JSON.stringify({ calibration: true, stable, adapter, scenarios: scenarios.map(item => ({ id: item.id, metrics: item.metrics })), extendedLobeGaps: run.extendedLobeGaps }, null, 2));
  } else {
    const verdicts = evaluateParityRun(scenarios.map(item => ({ id: item.id, metrics: item.metrics })), PARITY_EXPECTATIONS);
    const passed = stable && verdicts.every(verdict => verdict.passed);
    const lobeGapsOk = run.extendedLobeGaps.every(gap => gap.projected === false && gap.issues.length > 0);
    const evidence = { passed: passed && lobeGapsOk, ...base, lobeGapsStillFailClosed: lobeGapsOk,
      scenarios: scenarios.map(item => ({ ...item, ...verdicts.find(verdict => verdict.id === item.id), knownGap: PARITY_EXPECTATIONS[item.id].knownGap ?? null })),
      scope: "same author root through ThreeProjectionBridge; real production PbrRenderer vs real three WebGLRenderer; 320x192 dark theme",
      excluded: ["texture sampling parity", "transmission/sheen/iridescence/clearcoat/anisotropy (bridge fail-closed, see lobe gaps)", "device loss", "performance"] };
    await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ passed: evidence.passed, stable, adapter, lobeGapsStillFailClosed: lobeGapsOk, scenarios: evidence.scenarios.map(item => ({ id: item.id, tier: item.tier, expectedTier: item.expectedTier, passed: item.passed, failures: item.failures,
      ratchet: item.ratchet, rmse: +item.metrics.rmse.toFixed(3), deltaE2000: +item.metrics.deltaE2000.mean.toFixed(3), ssim: +item.metrics.ssim.mean.toFixed(5) })) }, null, 2));
    if (!evidence.passed) fail(stable ? "one or more scenarios regressed or fell below the declared tier (see evidence.json)" : "round-to-round instability");
  }
} catch (error) {
  await rm(path.join(out, "evidence.json"), { force: true });
  fail(error instanceof Error ? error.message : String(error));
} finally { try { await browser?.close(); } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); } }
