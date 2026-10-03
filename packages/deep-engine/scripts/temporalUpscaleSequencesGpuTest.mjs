import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// F4 67% 档四序列画质 runner(模式沿用 temporalUpscaleGpuTest.mjs):headless Chrome +
// WebGPU 走完整 PbrRenderer 生产路径。5 序列(静态/平移/旋转/缩放/透明掩码)× 3 腿
// (truth=1.0 真值 / upscale=2/3 档 + F4 时域上采样核 / stretched=2/3 档无核现状口径),
// 每腿 12 帧(0-7 运动、8-11 静止;static 全程静止),逐帧 SSIM + PSNR + 边缘能量对拍真值。
// 判据(全部可证伪;画质门限沿 2026-09-29 非劣口径,SSIM 无既有绝对门 → 登记实测值):
//   1) 腿齐:15 腿 × 12 帧,无错误;
//   2) 默认关闭回归:truth/stretched 腿不得出现 temporalUpscale 遥测;
//   3) upscale 遥测每帧在;静止收敛窗(末 2 帧)historyUsed=true;
//   4) F1 coverage:upscale 腿每帧 temporal-upscale 在 executed 集;
//   5) SSIM 非劣:pan/orbit/zoom 收敛末帧 upscale SSIM ≥ stretched SSIM − 0.005;
//   6) 静态时域收益:static 末帧 upscale SSIM > stretched SSIM(时域累积判别点,严格占优);
//   7) 读回完整性:全腿 nanCount=0;
//   8) 透明掩码腿:telemetry 每帧在 + history 收敛 + NaN=0 + SSIM/PSNR 可登记(无绝对门)。
// 帧时:本轮禁测(并行 GPU 负载),不开 gpuPassTiming,证据帧时列恒空。
// 证据写入 test-output/f4-upscale-20261002/gpu-r<N>/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = process.env.TEMPORAL_UPSCALE_SEQ_GPU_OUTPUT_DIR
  ? path.resolve(process.env.TEMPORAL_UPSCALE_SEQ_GPU_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "f4-upscale-20261002", "gpu-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.TEMPORAL_UPSCALE_SEQ_GPU_ATTEMPTS ?? 3);
const SEQUENCES = ["static", "pan", "orbit", "zoom", "transparency"];
const LEGS = ["truth", "upscale", "stretched"];
const FRAMES = 12;
const SSIM_TOLERANCE = 0.005;

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
    const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
    page.on("pageerror", (error) => console.error(`[pageerror] ${error.message}`));
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const adapter = await page.evaluate(async () => (await import("./probe.bundle.mjs")).probeAdapterInfo());
    const legs = [], errors = [];
    for (const sequence of SEQUENCES) {
      for (const mode of LEGS) {
        const beginError = await page.evaluate(async ([seq, legMode]) => {
          try { await (await import("./probe.bundle.mjs")).beginSequenceLeg(seq, legMode); return null; }
          catch (error) { return String(error instanceof Error ? error.message : error); }
        }, [sequence, mode]);
        if (beginError) { errors.push(`${sequence}/${mode}: ${beginError}`);
          legs.push({ sequence, mode, frames: [], error: beginError }); continue; }
        await page.evaluate(async ([count]) =>
          (await import("./probe.bundle.mjs")).stepSequenceLeg(count), [FRAMES]);
        legs.push(await page.evaluate(async () => (await import("./probe.bundle.mjs")).endSequenceLeg()));
      }
    }
    return { legs, adapter, errors };
  } finally { await browser.close(); }
}

const last = (leg) => leg?.frames?.[leg.frames.length - 1] ?? null;
const settled = (leg) => leg?.frames?.slice(-2) ?? [];

function analyse(probe) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });
  const key = (sequence, mode) => `${sequence}/${mode}`;
  const legs = new Map(probe.legs.map((leg) => [key(leg.sequence, leg.mode), leg]));

  // 1) 腿齐。
  for (const sequence of SEQUENCES) for (const mode of LEGS) {
    const leg = legs.get(key(sequence, mode));
    add(`legs-ran:${sequence}/${mode}`, Boolean(leg) && !leg.error && leg.frames?.length === FRAMES,
      leg?.error ?? `frames=${leg?.frames?.length ?? 0}`);
  }

  // 2) 默认关闭回归。
  const leaks = [];
  for (const sequence of SEQUENCES) for (const mode of ["truth", "stretched"]) {
    const leg = legs.get(key(sequence, mode));
    const leak = leg?.frames?.filter((frame) => frame.temporalUpscale !== null).length ?? -1;
    if (leak !== 0) leaks.push(`${sequence}/${mode}=${leak}`);
  }
  add("default-off-no-upscale-telemetry", leaks.length === 0, leaks.join(" ") || "no leaks");

  // 3) upscale 遥测 + 收敛 historyUsed。
  const telemetryGaps = [], historyGaps = [];
  for (const sequence of SEQUENCES) {
    const leg = legs.get(key(sequence, "upscale"));
    if (!leg?.frames?.length) continue;
    if (leg.frames.some((frame) => frame.temporalUpscale === null)) telemetryGaps.push(sequence);
    if (!settled(leg).every((frame) => frame.temporalUpscale?.historyUsed === true)) historyGaps.push(sequence);
  }
  add("upscale-telemetry-present", telemetryGaps.length === 0, telemetryGaps.join(",") || "all sequences");
  add("upscale-history-used-when-settled", historyGaps.length === 0,
    historyGaps.map((sequence) => `${sequence}:${settled(legs.get(key(sequence, "upscale")))
      .map((frame) => frame.temporalUpscale?.invalidation ?? "none").join("/")}`).join(" ") || "all sequences");

  // 4) F1 coverage 观测:upscale 腿每帧 temporal-upscale 在 executed 集。
  const coverageGaps = [];
  for (const sequence of SEQUENCES) {
    const leg = legs.get(key(sequence, "upscale"));
    const missed = leg?.frames?.filter((frame) => frame.upscalePassExecuted !== true).length ?? -1;
    if (missed !== 0) coverageGaps.push(`${sequence}=${missed}`);
  }
  add("coverage-observes-upscale-pass", coverageGaps.length === 0, coverageGaps.join(" ") || "all frames");

  // 5) SSIM 非劣(运动三序列)+ 6) 静态时域严格占优。
  const ssim = (sequence, mode) => {
    const leg = legs.get(key(sequence, mode));
    return last(leg)?.ssimToTruth ?? null;
  };
  const ssimDetails = [], ssimFailures = [];
  for (const sequence of ["static", "pan", "orbit", "zoom"]) {
    const upscaleSsim = ssim(sequence, "upscale"), stretchedSsim = ssim(sequence, "stretched");
    if (upscaleSsim === null || stretchedSsim === null) { ssimFailures.push(`${sequence}=null`); continue; }
    const delta = upscaleSsim - stretchedSsim;
    ssimDetails.push(`${sequence} ${upscaleSsim.toFixed(4)} vs ${stretchedSsim.toFixed(4)} (Δ${delta >= 0 ? "+" : ""}${delta.toFixed(4)})`);
    const floor = sequence === "static" ? 0 : -SSIM_TOLERANCE;
    if (delta < floor) ssimFailures.push(`${sequence} Δ${delta.toFixed(4)} < ${floor}`);
  }
  add("ssim-upscale-noninferior", ssimFailures.length === 0 && ssimDetails.length === 4,
    `${ssimDetails.join(" | ")}${ssimFailures.length ? ` FAIL: ${ssimFailures.join(",")}` : ""}`);

  // 7) 读回完整性。
  const nanLegs = probe.legs.filter((leg) => leg.frames?.some((frame) => frame.nanCount !== 0))
    .map((leg) => key(leg.sequence, leg.mode));
  add("readback-integrity-no-nan", nanLegs.length === 0, nanLegs.join(",") || "clean");

  // 8) 透明掩码腿:telemetry 在 + history 收敛 + NaN=0 + 对拍可登记(绝对值不设门,如实登记)。
  const transparency = legs.get(key("transparency", "upscale"));
  const transparencyOk = Boolean(transparency?.frames?.length)
    && transparency.frames.every((frame) => frame.temporalUpscale !== null && frame.nanCount === 0)
    && settled(transparency).every((frame) => frame.temporalUpscale?.historyUsed === true)
    && last(transparency)?.ssimToTruth !== null && last(transparency)?.psnrToTruth !== null;
  const transparentLast = last(transparency);
  add("transparency-mask-leg-healthy", transparencyOk,
    `psnr=${transparentLast?.psnrToTruth?.toFixed(2) ?? "null"} ssim=${transparentLast?.ssimToTruth?.toFixed(4) ?? "null"}`);

  // 序列画质汇总(登记,非门):各序列末帧 PSNR/SSIM/边缘能量。
  const summary = Object.fromEntries(SEQUENCES.map((sequence) => [sequence, Object.fromEntries(
    LEGS.map((mode) => {
      const frame = last(legs.get(key(sequence, mode)));
      return [mode, { psnr: frame?.psnrToTruth ?? null, ssim: frame?.ssimToTruth ?? null,
        edgeEnergyRatio: frame?.edgeEnergyRatio ?? null }];
    }))]));

  return { checks, gate: checks.every((check) => check.passed), summary };
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "temporal-upscale-seq-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/temporalUpscaleFourSequenceGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>Temporal upscale four-sequence GPU probe</title></head><body></body></html>`);

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin);
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
    schema: "deep-engine.f4-upscale-sequences-gpu-20261002", date: new Date().toISOString(),
    chrome: { path: chromePath }, scale: 2 / 3,
    internalRender: { width: 341, height: 256, note: "floor(512×2/3)×floor(384×2/3);纵横比与画布差0.1%(非整除缩放固有),相对判据无偏" },
    frameTime: "not-measured (parallel GPU load ban 2026-10-02; prior solo-run pass timings: test-output/temporal-upscale-gpu-20260929-r1)",
    adapter: probe.adapter, errors: probe.errors,
    legs: probe.legs.map((leg) => ({ ...leg,
      frames: leg.frames?.map((frame) => ({ ...frame,
        psnrToTruth: typeof frame.psnrToTruth === "number" ? Number(frame.psnrToTruth.toFixed(4)) : null,
        ssimToTruth: typeof frame.ssimToTruth === "number" ? Number(frame.ssimToTruth.toFixed(5)) : null,
        edgeEnergyRatio: typeof frame.edgeEnergyRatio === "number" ? Number(frame.edgeEnergyRatio.toFixed(4)) : null })) ?? [],
      framesSsimSha256: sha256((leg.frames ?? []).map((frame) => String(frame.ssimToTruth)).join(",")),
    })),
    sequenceSummary: analysis.summary,
    checks: analysis.checks, gate: analysis.gate,
  };
  const evidencePath = path.join(outputDirectory, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`adapter: ${JSON.stringify(probe.adapter)}`);
  if (probe.errors.length) console.log(`errors: ${JSON.stringify(probe.errors)}`);
  for (const check of analysis.checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`gate: ${analysis.gate ? "PASS" : "FAIL"} — ${evidencePath}`);
  if (!analysis.gate) process.exitCode = 1;
}

await main();
