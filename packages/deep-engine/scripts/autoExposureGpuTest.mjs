import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// F8 自动曝光真机对拍 runner(模式沿用 clusterLodGpuTest.mjs):headless Chrome +
// WebGPU 走完整 PbrRenderer 路径(全景环境 → postprocess → present 曝光+ACES WGSL),
// 逐帧读回 present-color 计算显示亮度。同场景亮(L=0.5)/暗(L=0.01)环境切换下:
//   1) 固定曝光档:每帧 FrameMetrics 无 autoExposure 键(默认关闭真机回归);
//   2) 自动档:遥测 active=true、亮度估计≈环境真值、曝光在 ±2 EV 包络内;
//   3) 眼适应:亮→暗切换后自动档显示亮度回稳,亮暗摆幅显著小于固定档;
//   4) 无振荡:自动档回稳窗(末 8 帧)显示亮度标准差受控。
// 证据写入 test-output/auto-exposure-gpu-20260929-r1/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = process.env.AUTO_EXPOSURE_GPU_OUTPUT_DIR
  ? path.resolve(process.env.AUTO_EXPOSURE_GPU_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "auto-exposure-gpu-20260929-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.AUTO_EXPOSURE_GPU_TEST_ATTEMPTS ?? 3);
const BRIGHT_LUMA = 0.5, DIM_LUMA = 0.01;
const BOOT_FRAMES = 24, ADAPT_FRAMES = 48;
const SWING_RATIO_LIMIT = 0.5;
const STABILITY_CV_LIMIT = 0.05;

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

async function runInBrowser(origin, luminances) {
  const require = createRequire(import.meta.url);
  const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
    args: ["--enable-unsafe-webgpu"] });
  try {
    const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
    page.on("pageerror", (error) => console.error(`[pageerror] ${error.message}`));
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const adapter = await page.evaluate(async () => (await import("./probe.bundle.mjs")).probeAdapterInfo());
    const legs = [], errors = [];
    for (const mode of ["fixed", "auto"]) {
      const beginError = await page.evaluate(async ([legMode, legLuminances]) => {
        try { await (await import("./probe.bundle.mjs")).beginLeg(legMode, legLuminances); return null; }
        catch (error) { return String(error instanceof Error ? error.message : error); }
      }, [mode, luminances]);
      if (beginError) { errors.push(`${mode}: ${beginError}`);
        legs.push({ mode, frames: [], display: [], error: beginError }); continue; }
      await page.evaluate(async ([count]) => (await import("./probe.bundle.mjs")).stepLeg(count),
        [BOOT_FRAMES]);
      await page.evaluate(async () => (await import("./probe.bundle.mjs")).flushPresent());
      const brightShot = await page.locator("canvas").screenshot({ type: "png" });
      const brightDisplay = await page.evaluate(async ([png]) =>
        (await import("./probe.bundle.mjs")).decodeDisplayShot(png, "bright"),
      [brightShot.toString("base64")]);
      await page.evaluate(async (luma) => (await import("./probe.bundle.mjs")).stageLegEnvironment(luma),
        luminances[1]);
      await page.evaluate(async ([count]) => (await import("./probe.bundle.mjs")).stepLeg(count),
        [ADAPT_FRAMES]);
      await page.evaluate(async () => (await import("./probe.bundle.mjs")).flushPresent());
      const dimShot = await page.locator("canvas").screenshot({ type: "png" });
      const dimDisplay = await page.evaluate(async ([png]) =>
        (await import("./probe.bundle.mjs")).decodeDisplayShot(png, "dim"),
      [dimShot.toString("base64")]);
      const leg = await page.evaluate(async () => (await import("./probe.bundle.mjs")).endLeg());
      legs.push({ ...leg, display: [brightDisplay, dimDisplay] });
    }
    return { legs, adapter, errors };
  } finally { await browser.close(); }
}

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const stdev = (values) => {
  if (values.length < 2) return 0;
  const center = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - center) ** 2)));
};

function analyse(probe) {
  const legs = Object.fromEntries(probe.legs.map((leg) => [leg.mode, leg]));
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });

  for (const mode of ["fixed", "auto"]) {
    const leg = legs[mode];
    add(`${mode}-leg-ran`, Boolean(leg) && !leg.error && leg.frames.length > 0,
      leg?.error ?? `frames=${leg?.frames.length ?? 0}`);
  }
  const fixed = legs.fixed, auto = legs.auto;
  if (!fixed || !auto || fixed.error || auto.error) return { checks, gate: false };

  // 1) 默认关闭真机回归:固定档每帧不得出现 autoExposure 遥测键。
  const fixedTelemetryLeak = fixed.frames.filter((frame) => frame.autoExposure !== null).length;
  add("fixed-default-off-no-telemetry", fixedTelemetryLeak === 0, `telemetryFrames=${fixedTelemetryLeak}`);

  // 2) 自动档遥测:active + 亮度估计≈环境真值 + 曝光在包络内。
  const autoFrames = auto.frames.filter((frame) => frame.autoExposure?.active);
  const luminanceErrors = autoFrames.flatMap((frame) => [
    Math.abs(frame.autoExposure.luminance - BRIGHT_LUMA) / BRIGHT_LUMA,
    Math.abs(frame.autoExposure.luminance - DIM_LUMA) / DIM_LUMA]).filter((value) => value <= 0.05);
  const envelopeViolations = autoFrames.filter((frame) => {
    const [min, max] = frame.autoExposure.evEnvelope;
    return frame.autoExposure.exposure < min - 1e-6 || frame.autoExposure.exposure > max + 1e-6;
  }).length;
  add("auto-telemetry-active", autoFrames.length > 0, `activeFrames=${autoFrames.length}/${auto.frames.length}`);
  add("auto-luminance-tracked", luminanceErrors.length > 0,
    `frames-within-5%-of-env=${luminanceErrors.length}`);
  add("auto-exposure-within-envelope", envelopeViolations === 0, `violations=${envelopeViolations}`);

  // 3) 眼适应(最终呈现像素):亮/暗稳态显示亮度摆幅,自动档必须显著小于固定档。
  const displayOf = (leg) => Object.fromEntries((leg.display ?? []).map((capture) => [capture.environment, capture]));
  const fixedDisplay = displayOf(fixed), autoDisplay = displayOf(auto);
  const captures = [fixedDisplay.bright, fixedDisplay.dim, autoDisplay.bright, autoDisplay.dim];
  add("display-captured", captures.every(Boolean),
    captures.map((capture) => capture ? `${capture.environment}:${capture.meanDisplayLuma.toFixed(4)}` : "missing").join(" "));
  if (captures.every(Boolean)) {
    const fixedSwing = Math.abs(fixedDisplay.bright.meanDisplayLuma - fixedDisplay.dim.meanDisplayLuma);
    const autoSwing = Math.abs(autoDisplay.bright.meanDisplayLuma - autoDisplay.dim.meanDisplayLuma);
    const swingRatio = fixedSwing > 1e-9 ? autoSwing / fixedSwing : Number.POSITIVE_INFINITY;
    add("eye-adaptation-swing", swingRatio < SWING_RATIO_LIMIT,
      `autoSwing=${autoSwing.toFixed(5)} fixedSwing=${fixedSwing.toFixed(5)} ratio=${swingRatio.toFixed(3)} limit=${SWING_RATIO_LIMIT}`);
    // 4) 方向正确:亮环境自动档更暗、暗环境自动档更亮(固定档同场景对照)。
    add("auto-direction-bright-dims",
      autoDisplay.bright.meanDisplayLuma < fixedDisplay.bright.meanDisplayLuma,
      `auto=${autoDisplay.bright.meanDisplayLuma.toFixed(5)} fixed=${fixedDisplay.bright.meanDisplayLuma.toFixed(5)}`);
    add("auto-direction-dim-lifts",
      autoDisplay.dim.meanDisplayLuma > fixedDisplay.dim.meanDisplayLuma,
      `auto=${autoDisplay.dim.meanDisplayLuma.toFixed(5)} fixed=${fixedDisplay.dim.meanDisplayLuma.toFixed(5)}`);
  }

  // 5) 无振荡:自动档各环境回稳窗(末 8 帧)实际下发曝光的变异系数受控。
  const windows = (leg) => ({ bright: leg.frames.slice(0, BOOT_FRAMES).slice(-8),
    dim: leg.frames.slice(BOOT_FRAMES).slice(-8) });
  const autoWindows = windows(auto);
  const exposureCv = (window) => {
    const values = window.map((frame) => frame.autoExposure?.exposure).filter((value) => value !== undefined);
    const center = mean(values);
    return center > 0 ? stdev(values) / center : Number.POSITIVE_INFINITY;
  };
  const maxExposureCv = Math.max(exposureCv(autoWindows.bright), exposureCv(autoWindows.dim));
  add("auto-settled-no-oscillation", maxExposureCv < STABILITY_CV_LIMIT,
    `maxExposureCv=${maxExposureCv.toFixed(4)} limit=${STABILITY_CV_LIMIT}`);

  return { checks, gate: checks.every((check) => check.passed) };
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "auto-exposure-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/autoExposureGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>Auto exposure GPU probe</title></head><body></body></html>`);

  const luminances = [BRIGHT_LUMA, DIM_LUMA];
  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin, luminances);
      if (probe.errors.length === 0 && probe.legs.every((leg) => !leg.error)) break;
    } catch (error) {
      probe = { legs: [], adapter: {}, errors: [String(error instanceof Error ? error.message : error)] };
    } finally { server.close(); }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error(`GPU probe failed after ${maxAttempts} attempts.`);

  const analysis = analyse(probe);
  await mkdir(outputDirectory, { recursive: true });
  const evidence = {
    schema: "deep-engine.f8-auto-exposure-gpu", date: new Date().toISOString(),
    chrome: { path: chromePath }, luminances: { bright: BRIGHT_LUMA, dim: DIM_LUMA },
    adapter: probe.adapter, errors: probe.errors,
    legs: probe.legs.map((leg) => ({ ...leg,
      frames: leg.frames.map((frame) => ({ ...frame,
        meanSceneLuma: Number.isFinite(frame.meanSceneLuma) ? Number(frame.meanSceneLuma.toFixed(6)) : null,
        exposure: frame.autoExposure?.exposure !== undefined
          ? Number(frame.autoExposure.exposure.toFixed(5)) : null })),
      display: leg.display.map((capture) => ({ ...capture,
        meanDisplayLuma: Number(capture.meanDisplayLuma.toFixed(6)),
        lumaP10: Number(capture.lumaP10.toFixed(6)), lumaP90: Number(capture.lumaP90.toFixed(6)) })),
      frameLumaSha256: sha256(leg.frames.map((frame) => frame.meanSceneLuma.toFixed(6)).join(",")),
    })),
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

await main();
