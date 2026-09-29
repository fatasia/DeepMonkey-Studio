import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// C9 Clearcoat 清漆层真机验收 runner(形态沿用 whiteFurnaceGpuTest.mjs / contactShadowGpuTest.mjs):
// 材质管线 sphere(1×1 纹理 + extendedParameters)走权威 extendedShade,七腿对照:
//   1) furnace(禁灯默认腿):材质路径过 C12 守恒断言(≡E);
//   2) dark-neutral(禁灯 off/on):位级净差 0——缺省零行为 + 运行时清漆只改直射项;
//   3) transfer(太阳白炉 on/weak):逐像素转移恒等式 vs CPU 参考,无中生有上界;
//   4) dual-lobe(视觉):清漆瓣宽 < 底漆瓣宽 + 峰值增强,截图存证;
//   5) timing:全帧 GPU 毫秒 off/on 对照。
// 证据写入 test-output/clearcoat-furnace-gpu-20260929-r1/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = process.env.CLEARCOAT_GPU_OUTPUT_DIR
  ? path.resolve(process.env.CLEARCOAT_GPU_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "clearcoat-furnace-gpu-20260929-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.CLEARCOAT_GPU_TEST_ATTEMPTS ?? 3);
const LEGS = ["sun-coat-on", "sun-coat-weak", "sun-coat-off", "dark-coat-off", "dark-coat-on", "visual-coat-off", "visual-coat-on"];
const WARM_FRAMES = 6, MEASURE_FRAMES = 8;
// 阈值(首轮真机标定后冻结;rgba16float 相对精度 2^-11 ≈ 0.05% 为绝对下限)。
const T = {
  darkNeutralMax: 1e-5,
  transferCoverageMin: 4000,
  transferP95Rel: 0.03, transferMaxRel: 0.15,
  transferP95Abs: 0.002, transferMaxAbs: 0.01,
  freeEnergyMax: 0.002,
  transferSignMin: 100,
  peakRatioMin: 1.05, coatDeltaPeakMin: 0.01,
  frameCostMaxMs: 0.5,
};

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
    const summaries = [], shots = {}, errors = [];
    for (const kind of LEGS) {
      const failure = await page.evaluate(async ([legKind]) => {
        try { await (await import("./probe.bundle.mjs")).beginLeg(legKind); return null; }
        catch (error) { return String(error instanceof Error ? error.message : error); }
      }, [kind]);
      if (failure) { errors.push(`${kind}: ${failure}`); continue; }
      await page.evaluate(async ([warm, measure]) => {
        const module = await import("./probe.bundle.mjs");
        await module.stepLeg(warm);
        await module.stepLeg(measure);
      }, [WARM_FRAMES, MEASURE_FRAMES]);
      if (kind.startsWith("visual")) {
        await page.evaluate(async () => (await import("./probe.bundle.mjs")).flushPresent());
        shots[kind] = (await page.locator("canvas").screenshot({ type: "png" })).toString("base64");
      }
      summaries.push(await page.evaluate(async () => (await import("./probe.bundle.mjs")).endLeg()));
    }
    const analyses = errors.length === 0 ? await page.evaluate(async () => {
      const module = await import("./probe.bundle.mjs");
      return {
        transfer: await module.analyzeTransfer("sun-coat-on", "sun-coat-weak"),
        dark: await module.analyzeDarkPair("dark-coat-off", "dark-coat-on"),
        visual: await module.analyzeVisual("visual-coat-off", "visual-coat-on"),
      };
    }) : null;
    return { adapter, summaries, shots, errors, analyses };
  } finally { await browser.close(); }
}

function analyse(probe) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });
  for (const summary of probe.summaries) {
    add(`leg-ran:${summary.kind}`, true, `frames=${summary.frames} gpuMs=${summary.totalGpuMs?.toFixed(4) ?? "null"}`);
  }
  add("legs-ran", probe.summaries.length === LEGS.length && probe.errors.length === 0,
    probe.errors.join("; ") || `legs=${probe.summaries.length}/${LEGS.length}`);
  if (!probe.analyses) return { checks, gate: false };
  const { transfer, dark, visual } = probe.analyses;
  for (const check of dark.furnaceChecks) add(`furnace:${check.name}`, check.passed, check.detail);
  add("dark-neutral", dark.maxAbsDelta <= T.darkNeutralMax,
    `maxAbsDelta=${dark.maxAbsDelta.toExponential(3)} limit=${T.darkNeutralMax}(缺省零行为:清漆在无直射时逐像素不可见)`);
  add("transfer-coverage", transfer.compared >= T.transferCoverageMin,
    `compared=${transfer.compared} limit=${T.transferCoverageMin}`);
  add("transfer-identity", transfer.p95Rel <= T.transferP95Rel && transfer.maxRel <= T.transferMaxRel
    && transfer.p95Abs <= T.transferP95Abs && transfer.maxAbs <= T.transferMaxAbs,
    `p95Rel=${(100 * transfer.p95Rel).toFixed(3)}% maxRel=${(100 * transfer.maxRel).toFixed(3)}% p95Abs=${transfer.p95Abs.toExponential(3)} maxAbs=${transfer.maxAbs.toExponential(3)} (rel 在 |expected|≥${0.01} 信号区求值, relEvaluated=${transfer.relEvaluated}/${transfer.compared})`);
  add("no-free-energy", transfer.freeEnergyMax <= T.freeEnergyMax,
    `freeEnergyMax=${transfer.freeEnergyMax.toExponential(3)} limit=${T.freeEnergyMax}(清漆增量 ≤ (f1−f2)·清漆瓣)`);
  add("transfer-signs", transfer.positive >= T.transferSignMin && transfer.negative >= T.transferSignMin,
    `positive=${transfer.positive} negative=${transfer.negative} limit=${T.transferSignMin}(增量双符号=瓣加亮+底漆衰减)`);
  add("dual-lobe", visual.coatFwhmPx < visual.baseFwhmPx && visual.peakRatio >= T.peakRatioMin
    && visual.coatDeltaPeak >= T.coatDeltaPeakMin,
    `coatFwhm=${visual.coatFwhmPx}px baseFwhm=${visual.baseFwhmPx}px peakRatio=${visual.peakRatio.toFixed(4)} coatDeltaPeak=${visual.coatDeltaPeak.toFixed(4)}`);
  const gpuOn = probe.summaries.find(s => s.kind === "sun-coat-on")?.totalGpuMs;
  const gpuOff = probe.summaries.find(s => s.kind === "sun-coat-off")?.totalGpuMs;
  const gpuDelta = gpuOn != null && gpuOff != null ? gpuOn - gpuOff : null;
  add("timing-captured", gpuOn != null && gpuOff != null, `gpuOff=${gpuOff?.toFixed(4)} gpuOn=${gpuOn?.toFixed(4)}`);
  add("frame-cost-bounded", gpuDelta != null && gpuDelta <= T.frameCostMaxMs,
    `gpuDelta=${gpuDelta?.toFixed(4) ?? "null"}ms limit=${T.frameCostMaxMs}`);
  return { checks, gate: checks.every((check) => check.passed), stats: { transfer, dark, visual, gpuDelta } };
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "clearcoat-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/clearcoatFurnaceGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>Clearcoat furnace GPU probe</title></head><body></body></html>`);

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin);
      if (probe.errors.length === 0) break;
    } catch (error) {
      probe = { adapter: {}, summaries: [], shots: {}, errors: [String(error instanceof Error ? error.message : error)], analyses: null };
    } finally { server.close(); }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error(`Clearcoat GPU probe failed after ${maxAttempts} attempts.`);

  const analysis = analyse(probe);
  await mkdir(outputDirectory, { recursive: true });
  for (const [name, base64] of Object.entries(probe.shots)) {
    await writeFile(path.join(outputDirectory, `scene-${name}.png`), Buffer.from(base64, "base64"));
  }
  const evidence = {
    schema: "deep-engine.c9-clearcoat-furnace-gpu", date: new Date().toISOString(),
    chrome: { path: chromePath }, adapter: probe.adapter, errors: probe.errors,
    thresholds: T, warmFrames: WARM_FRAMES, measureFrames: MEASURE_FRAMES,
    summaries: probe.summaries.map((summary) => ({ ...summary,
      totalGpuMs: summary.totalGpuMs == null ? null : Number(summary.totalGpuMs.toFixed(4)),
      cpuSubmitMs: summary.cpuSubmitMs == null ? null : Number(summary.cpuSubmitMs.toFixed(4)) })),
    analyses: probe.analyses === null ? null : {
      transfer: Object.fromEntries(Object.entries(probe.analyses.transfer).map(([key, value]) => [key, Number(value.toFixed(6))])),
      dark: { ...probe.analyses.dark, maxAbsDelta: probe.analyses.dark.maxAbsDelta },
      visual: probe.analyses.visual,
      gpuDeltaMs: analysis.stats?.gpuDelta ?? null,
    },
    screenshots: Object.keys(probe.shots).map((name) => `scene-${name}.png (sha256 ${createHash("sha256").update(probe.shots[name]).digest("hex").slice(0, 16)}...)`),
    checks: analysis.checks, gate: analysis.gate,
  };
  await writeFile(path.join(outputDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`adapter: ${JSON.stringify(probe.adapter)}`);
  for (const check of analysis.checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`gate: ${analysis.gate ? "PASS" : "FAIL"} — ${path.join(outputDirectory, "evidence.json")}`);
  if (!analysis.gate) process.exitCode = 1;
}

await main();
