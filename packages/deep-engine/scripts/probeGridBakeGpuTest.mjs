import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// Deep GI 探针网格烘焙真机证据 runner（F3 编排切片；模式沿用 probeRadianceGpuTest.mjs）。
// headless Chrome + 真 WebGPU 走完整生产者链：ProbeGridBakeService → ProbeSceneRadianceProducer
// 捕获（2×2×2 单层网格一次性 dispatch）→ 捕获纹理读回 → decodeProbeGridCapture →
// aggregateProbeGridBake → packNativeProbeGridRecords 编译器输入校验。断言：8 探针全
// 覆盖（validity=1）、逐 cell GPU/CPU 对拍（f16 容差 1e-3）、两次独立 bake 逐位一致
// （真机确定性）、遮挡 cell 亮度 < 开阔 cell、溢出哨兵 0、打包器接受。
// 证据写入 test-output/probe-grid-bake-20260923/（report.json + bake.json + WGSL dump）。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.join(repoRoot, "test-output", "probe-grid-bake-20260923");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.PROBE_GRID_BAKE_GPU_TEST_ATTEMPTS ?? 3);

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
    const page = await browser.newPage();
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const result = await page.evaluate(async () => {
      const module = await import("./probe.bundle.mjs");
      return module.runProbeGridBakeGpuProbe();
    });
    result.browserVersion = browser.version();
    return result;
  } finally {
    await browser.close();
  }
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "probe-grid-bake-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/probeGridBakeGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"), "<!doctype html><title>Probe grid bake GPU probe</title>");

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin);
      if (probe.errors.length === 0 && probe.runs?.length) break;
    } catch (error) {
      probe = { errors: [String(error instanceof Error ? error.message : error)], runs: [] };
    } finally {
      server.close();
    }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  if (!probe) throw new Error(`GPU probe failed after ${maxAttempts} attempts.`);

  // 从 bundle 取权威 WGSL 文本（与 producer 内部编译的模块同源）。
  const module = await import(pathToFileURL(bundlePath));
  await rm(bundleDirectory, { recursive: true, force: true });

  const runs = probe.runs ?? [];
  const comparisonsPassed = runs.length === 2
    && runs.every(run => run.comparisons.length === 8 && run.comparisons.every(entry => entry.passed));
  const coverage = runs.map(run => ({
    probeCount: run.evidence.probeCount, coveredCount: run.evidence.coveredCount,
    allCovered: run.evidence.probeCount === 8 && run.evidence.coveredCount === 8
      && run.evidence.bake.probes.every(entry => entry.validity === 1),
  }));
  const gate = runs.length === 2
    && coverage.every(entry => entry.allCovered)
    && comparisonsPassed
    && probe.identicalAcrossRuns === true
    && probe.occludedBelowOpenSky === true
    && probe.packerAccepted === true
    && runs.every(run => run.evidence.overflowSentinel === 0)
    && probe.errors.length === 0;
  const report = {
    gate, adapter: probe.adapter, browserVersion: probe.browserVersion,
    identicalAcrossRuns: probe.identicalAcrossRuns,
    occludedBelowOpenSky: probe.occludedBelowOpenSky,
    packerAccepted: probe.packerAccepted,
    coverage, validationMessages: probe.errors,
    directionCount: runs[0]?.evidence.directionCount, maxDistance: runs[0]?.evidence.maxDistance,
    sceneInstances: runs[0]?.evidence.sceneInstances,
    comparisons: runs.map((run, index) => ({ run: index + 1, entries: run.comparisons })),
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(outputDirectory, "bake.json"), JSON.stringify({
    schema: "deep-engine.probe-grid-bake-evidence", grid: { origin: [0, 0.5, 0], spacing: 2, gridSize: [2, 2, 2] },
    deterministic: probe.identicalAcrossRuns, bake: runs[0]?.evidence.bake,
  }, null, 2));
  await writeFile(path.join(outputDirectory, "probeSceneRadiance.wgsl"), module.emitProbeRadianceKernelWgsl());
  console.log(JSON.stringify({ gate, adapter: report.adapter,
    identicalAcrossRuns: report.identicalAcrossRuns,
    occludedBelowOpenSky: report.occludedBelowOpenSky, packerAccepted: report.packerAccepted,
    coverage: coverage.map(({ probeCount, coveredCount }) => ({ probeCount, coveredCount })),
    worstDelta: Math.max(...runs.flatMap(run => run.comparisons.flatMap(entry => entry.absoluteDelta))) },
    null, 2));
  if (!gate) throw new Error("Probe grid bake GPU gate failed; see report.json.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
