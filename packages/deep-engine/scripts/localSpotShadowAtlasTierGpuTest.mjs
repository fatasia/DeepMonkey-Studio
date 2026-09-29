import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// F7b 产品渲染器图集档位真机验收 runner(驱动形态同 contactShadowGpuTest.mjs;
// 被驱动的是产品 PbrRenderer,腿差仅 PbrRendererOptions.localSpotShadowAtlasTier):
//   standard@16    = 默认档(2×2 tile,4 灯有影,12 灯拒绝,ABI 4→16 扩容前后的行为不变)
//   multi-light@16 = F7b 扩容后可达(4×4 tile,16 灯全覆盖,uniform 1536B)
// 画质判据与 F7 同口径(RMSE/渗漏对照 CPU 解析硬影;每补丁 P95 归一);
// gate:ABI 预算、覆盖 4/16、RMSE ≥2× 改善、渗漏 ≥30pp 改善、帧复现、场景健全性。
// 证据写入 test-output/local-spot-shadow-atlas-tier-gpu-*/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = process.env.ATLAS_TIER_GPU_OUTPUT_DIR
  ? path.resolve(process.env.ATLAS_TIER_GPU_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "local-spot-shadow-atlas-tier-gpu-20260929-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.ATLAS_TIER_GPU_TEST_ATTEMPTS ?? 3);
const TIERS = ["standard", "multi-light"];
const WARM_FRAMES = 4, MEASURE_FRAMES = 8;
const RMSE_IMPROVEMENT_MIN = 2, LEAK_IMPROVEMENT_PP_MIN = 30;

async function startServer(directory) {
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace("/", "");
    if (request.method !== "GET" || !["probe.html", "probe.bundle.mjs"].includes(name)) {
      response.writeHead(404).end(); return;
    }
    response.writeHead(200, { "Content-Type": name.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript" })
      .end(await readFile(path.join(directory, name)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function runInBrowser(origin) {
  const require = createRequire(import.meta.url);
  const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
    args: ["--enable-unsafe-webgpu"] });
  try {
    const page = await browser.newPage({ viewport: { width: 512, height: 384 } });
    page.on("pageerror", (error) => console.error(`[pageerror] ${error.message}`));
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const adapter = await page.evaluate(async () => (await import("./probe.bundle.mjs")).probeAdapterInfo());
    const abi = await page.evaluate(async () => (await import("./probe.bundle.mjs")).probeAbiBudget());
    const legs = {}, shots = {}, errors = [];
    for (const tier of TIERS) {
      const failure = await page.evaluate(async (legTier) => {
        try { await (await import("./probe.bundle.mjs")).beginLeg(legTier); return null; }
        catch (error) { return String(error instanceof Error ? error.message : error); }
      }, tier);
      if (failure) { errors.push(`${tier}: ${failure}`); legs[tier] = { tier, error: failure }; continue; }
      await page.evaluate(async ([warm, measure]) => {
        const module = await import("./probe.bundle.mjs");
        await module.stepLeg(warm);
        await module.stepLeg(measure);
      }, [WARM_FRAMES, MEASURE_FRAMES]);
      await page.evaluate(async () => (await import("./probe.bundle.mjs")).flushPresent());
      shots[tier] = (await page.locator("canvas").screenshot({ type: "png" })).toString("base64");
      legs[tier] = await page.evaluate(async () => (await import("./probe.bundle.mjs")).endLeg());
    }
    return { legs, adapter, abi, errors, shots };
  } finally { await browser.close(); }
}

function analyse(probe) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });
  add("adapter", Boolean(probe.adapter?.vendor || probe.adapter?.architecture), JSON.stringify(probe.adapter));
  add("abi-budget", probe.abi?.maxLights === 16 && probe.abi?.uniformBytes === 1536
    && probe.abi?.withinUniformBudget, JSON.stringify(probe.abi));
  const standard = probe.legs["standard"], multi = probe.legs["multi-light"];
  add("legs-ran", Boolean(standard && multi && !standard.error && !multi.error),
    standard?.error ?? multi?.error ?? `frames standard=${standard?.frames} multi=${multi?.frames}`);
  if (!standard || !multi || standard.error || multi.error) return { checks, gate: false };
  add("standard-default-coverage", standard.coveredLights === 4,
    `covered=${standard.coveredLights}/16 (默认档 4 灯有影/12 拒绝)`);
  add("multi-light-full-coverage", multi.coveredLights === 16,
    `covered=${multi.coveredLights}/16 (ABI 扩容后 16 灯全覆盖)`);
  const ratio = standard.aggregate.rmse > 0 ? standard.aggregate.rmse / multi.aggregate.rmse : 0;
  add("rmse-improvement", ratio >= RMSE_IMPROVEMENT_MIN,
    `rmse ${standard.aggregate.rmse.toFixed(4)} → ${multi.aggregate.rmse.toFixed(4)} (${ratio.toFixed(2)}×,门 ≥${RMSE_IMPROVEMENT_MIN}×)`);
  const leakPp = (standard.aggregate.leakFraction - multi.aggregate.leakFraction) * 100;
  add("leak-improvement", leakPp >= LEAK_IMPROVEMENT_PP_MIN,
    `leak ${(standard.aggregate.leakFraction * 100).toFixed(1)}% → ${(multi.aggregate.leakFraction * 100).toFixed(1)}% `
    + `(${leakPp.toFixed(1)}pp,门 ≥${LEAK_IMPROVEMENT_PP_MIN}pp)`);
  add("scene-sanity", standard.referenceShadowedSamples > 0 && multi.referenceShadowedSamples > 0
    && standard.repeatFrameIdentical && multi.repeatFrameIdentical,
    `reference=${standard.referenceShadowedSamples}/${multi.referenceShadowedSamples} `
    + `repeat identical=${standard.repeatFrameIdentical}/${multi.repeatFrameIdentical}`);
  return { checks, gate: checks.every((check) => check.passed) };
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "atlas-tier-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/localSpotShadowAtlasTierGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>Local spot shadow atlas tier GPU probe</title></head><body></body></html>`);

  const require = createRequire(import.meta.url);
  const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin);
      if (probe.errors.length === 0) break;
    } catch (error) {
      probe = { legs: {}, adapter: {}, abi: null, errors: [String(error instanceof Error ? error.message : error)], shots: {} };
    } finally { server.close(); }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error(`Atlas tier GPU probe failed after ${maxAttempts} attempts.`);

  const analysis = analyse(probe);
  await mkdir(outputDirectory, { recursive: true });
  const screenshotHashes = {};
  for (const [tier, base64] of Object.entries(probe.shots)) {
    const file = `scene-${tier}.png`;
    await writeFile(path.join(outputDirectory, file), Buffer.from(base64, "base64"));
    screenshotHashes[file] = createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
  }
  const evidence = {
    schema: "deep-engine.f7b-local-spot-shadow-atlas-tier-gpu", date: new Date().toISOString(),
    chrome: { path: chromePath }, adapter: probe.adapter, abi: probe.abi,
    errors: probe.errors, tiers: TIERS, warmFrames: WARM_FRAMES, measureFrames: MEASURE_FRAMES,
    legs: probe.legs, screenshotSha256: screenshotHashes, checks: analysis.checks, gate: analysis.gate,
  };
  await writeFile(path.join(outputDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`adapter: ${JSON.stringify(probe.adapter)}`);
  console.log(`abi: ${JSON.stringify(probe.abi)}`);
  for (const tier of TIERS) {
    const leg = probe.legs[tier];
    if (!leg || leg.error) { console.log(`${tier}: ERROR ${leg?.error ?? "missing"}`); continue; }
    console.log(`${tier} | covered ${leg.coveredLights}/16 | rmse ${leg.aggregate.rmse.toFixed(4)}`
      + ` | leak ${(100 * leg.aggregate.leakFraction).toFixed(1)}%`
      + ` | edge p50/p95 ${leg.aggregate.edgeWidthP50}/${leg.aggregate.edgeWidthP95}`
      + ` | cpuMs ${leg.frameCpuMs.toFixed(3)} | gpuMs ${leg.totalGpuMs ?? "null"}`
      + ` | draws ${leg.drawCalls}`);
  }
  for (const check of analysis.checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`gate: ${analysis.gate ? "PASS" : "FAIL"} — ${path.join(outputDirectory, "evidence.json")}`);
  if (!analysis.gate) process.exitCode = 1;
}

await main();
