import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// C12 白炉测试验收 runner(headless Chrome WebGPU,模式沿用 autoExposureGpuTest.mjs):
// 完整 PbrRenderer 管线下,白 Lambert + 均匀恒定辐射度环境 + 关闭方向灯,断言能量守恒:
//   1) background 腿:全帧 ≡ E(采样/显示链);
//   2) geometry 腿:白粗糙球几何域 ≡ E(IBL 能量链,解析轮廓分割);
//   3) ssr-box-off/on 腿:闭合白盒内 SSR 关/开两态均 ≡ E,且逐像素净差 p99 受控(C11 捆绑);
//   4) 门禁 = 全部判定通过,证据写入 test-output/white-furnace-gpu-*/evidence.json。
// 白炉守恒误差即引擎着色能量缺陷的量化基线;任何新的着色路径都必须过本门禁。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = process.env.WHITE_FURNACE_GPU_OUTPUT_DIR
  ? path.resolve(process.env.WHITE_FURNACE_GPU_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "white-furnace-gpu-20260928-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.WHITE_FURNACE_GPU_TEST_ATTEMPTS ?? 3);
const LEGS = ["background", "geometry", "ssr-box-off", "ssr-box-on"];
const WARM_FRAMES = 4, MEASURE_FRAMES = 3;

const sha256 = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

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
    const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
    page.on("pageerror", (error) => console.error(`[pageerror] ${error.message}`));
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const adapter = await page.evaluate(async () => (await import("./probe.bundle.mjs")).probeAdapterInfo());
    const legs = [], errors = [], firstFrames = new Map();
    for (const kind of LEGS) {
      const failure = await page.evaluate(async ([legKind]) => {
        try { await (await import("./probe.bundle.mjs")).beginLeg(legKind); return null; }
        catch (error) { return String(error instanceof Error ? error.message : error); }
      }, [kind]);
      if (failure) { errors.push(`${kind}: ${failure}`);
        legs.push({ kind, frames: 0, analysis: null, checks: [{ name: "leg-ran", passed: false, detail: failure }] });
        continue; }
      await page.evaluate(async ([count]) => (await import("./probe.bundle.mjs")).stepLeg(count), [WARM_FRAMES]);
      await page.evaluate(async () => (await import("./probe.bundle.mjs")).armMeasurement());
      await page.evaluate(async ([count]) => (await import("./probe.bundle.mjs")).stepLeg(count), [MEASURE_FRAMES]);
      const ssrLeg = kind === "ssr-box-off" || kind === "ssr-box-on";
      if (ssrLeg) firstFrames.set(kind, await page.evaluate(async () =>
        (await import("./probe.bundle.mjs")).exportFirstFrame()));
      const leg = await page.evaluate(async () => (await import("./probe.bundle.mjs")).endLeg());
      legs.push(leg);
    }
    let toggleChecks = null;
    const offFirst = firstFrames.get("ssr-box-off"), onFirst = firstFrames.get("ssr-box-on");
    if (offFirst && onFirst) {
      toggleChecks = await page.evaluate(async ([offFrame, onFrame]) =>
        (await import("./probe.bundle.mjs")).compareSsrToggle(offFrame, onFrame),
      [offFirst, onFirst].map((frame) => ({ pixels: Array.from(frame.pixels), segmentation: frame.segmentation })));
    } else if (!legs.some((leg) => leg.kind === "ssr-box-off" && leg.analysis === null)) {
      errors.push("ssr-toggle: first-frame exports unavailable");
    }
    return { legs, adapter, errors, toggleChecks };
  } finally { await browser.close(); }
}

function analyse(probe) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });
  for (const leg of probe.legs) {
    for (const check of leg.checks) add(`${leg.kind}:${check.name}`, check.passed, check.detail);
  }
  if (probe.toggleChecks) for (const check of probe.toggleChecks) add(`ssr-toggle:${check.name}`, check.passed, check.detail);
  else add("ssr-toggle:present", false, "toggle comparison missing");
  return { checks, gate: checks.every((check) => check.passed) };
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "white-furnace-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/whiteFurnaceGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>White furnace GPU probe</title></head><body></body></html>`);

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin);
      if (probe.errors.length === 0) break;
    } catch (error) {
      probe = { legs: [], adapter: {}, errors: [String(error instanceof Error ? error.message : error)], toggleChecks: null };
    } finally { server.close(); }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error(`White furnace GPU probe failed after ${maxAttempts} attempts.`);

  const analysis = analyse(probe);
  await mkdir(outputDirectory, { recursive: true });
  const evidence = {
    schema: "deep-engine.c12-white-furnace-gpu", date: new Date().toISOString(),
    chrome: { path: chromePath }, legs: LEGS, warmFrames: WARM_FRAMES, measureFrames: MEASURE_FRAMES,
    adapter: probe.adapter, errors: probe.errors,
    legs: probe.legs.map((leg) => ({ ...leg,
      analysis: leg.analysis ? { ...leg.analysis,
        background: roundStats(leg.analysis.background),
        geometry: leg.analysis.geometry ? roundStats(leg.analysis.geometry) : null,
        global: roundStats(leg.analysis.global) } : null,
      checkSha256: sha256(leg.checks.map((check) => `${check.name}=${check.passed}`).join(",")) })),
    toggleChecks: probe.toggleChecks,
    checks: analysis.checks, gate: analysis.gate,
  };
  const evidencePath = path.join(outputDirectory, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`adapter: ${JSON.stringify(probe.adapter)}`);
  for (const check of analysis.checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`gate: ${analysis.gate ? "PASS" : "FAIL"} — ${evidencePath}`);
  if (!analysis.gate) process.exitCode = 1;
}

function roundStats(stats) {
  const round = (value) => Number.isFinite(value) ? Number(value.toFixed(6)) : null;
  return { region: stats.region, pixels: stats.pixels,
    meanRadiance: round(stats.meanRadiance), meanRelativeError: round(stats.meanRelativeError),
    maxAbsRelativeError: round(stats.maxAbsRelativeError), p99AbsRelativeError: round(stats.p99AbsRelativeError),
    channelGain: stats.channelGain.map(round) };
}

await main();
