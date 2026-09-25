import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import { measurements } from "../../lib/deepBevyPairedEvidence.mjs";
import { quantiles } from "../../lib/bevy019BenchmarkEvidence.mjs";

// V4 性能基准 Babylon Web 轨道采集 harness（单侧采集切片）。
// - 夹具对齐 bevy-0.19 轨道 factory-instances/cubes-v2（语义对齐明细见 README「口径差异」）。
// - headless Chrome + 真 WebGPU/WebGL，参照 packages/deep-engine/scripts/gpuParticleRenderTest.mjs 模式。
// - 3 轮冷热交替（冷=全新 user-data-dir，热=复用上一冷轮 profile 的 shader 磁盘缓存）。
// - 进程内存：run-windows-process-tree-metrics.ps1 采样 Chrome 进程树（WorkingSet 峰值）。
// - 产出与 test-output/bevy-019-benchmark/paired-evidence.json 同 schema 的 evidence（candidate 侧留空）。
// - 聚合报告直接复用仓内 scripts/benchmarks/paired-summary.mjs（零修改，吃单侧数据如实标"未采集"）。

const harnessRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(harnessRoot, "../../..");
const outputDirectory = path.join(repoRoot, "test-output", "babylon-web-benchmark-20260922");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const totalRounds = Number(process.env.BABYLON_WEB_BENCH_ROUNDS ?? 3);
const settings = { width: 1280, height: 720, warmupFrames: 30, sampleFrames: 120, instances: 256,
  msaaSamples: 4, camera: { yaw: 0.55, pitch: 0, distance: 4, focal: 2.05, near: 0.1, far: 100 },
  qualityProfile: "pbr-forward-tonemapped" };
const fixture = { id: "factory-instances/cubes-v2", instanceCount: settings.instances,
  geometryCount: 1, materialCount: 1, triangles: settings.instances * 12,
  packetSha256: null, geometrySource: "procedural CreateBox size=0.08（Babylon 侧代码建模，无 runtime packet）" };

// 与 scripts/lib/deepBevyPairedEvidence.mjs 的 REQUIRED 清单同构（14 项）。
const REQUIRED_METRICS = ["cpu-frame-p50-ms", "cpu-frame-p95-ms", "cpu-frame-p99-ms",
  "gpu-frame-p50-ms", "gpu-frame-p95-ms", "gpu-frame-p99-ms", "frame-p99-ms",
  "input-latency-p95-ms", "cold-start-ms", "load-to-interactive-ms",
  "long-run-frame-p99-ms", "peak-host-bytes", "peak-gpu-bytes", "visual-similarity"];

const cloudWorkerRequire = createRequire(import.meta.url);
const playwright = cloudWorkerRequire(path.join(repoRoot, "apps/cloud-render-worker/node_modules/playwright-core/index.js"));
// 打包走 esbuild CLI（与 apps/web/scripts/gate-a01x-babylon-pairing.mjs 同款）：JS API 在本机有挂起记录；
// 且 Babylon 深路径 ESM 存在循环依赖，单文件 bundle 会把 class extends 顺序化成 undefined，必须 --splitting。
const esbuildBin = path.join(repoRoot, "packages/deep-engine/node_modules/esbuild/bin/esbuild");

const sha256 = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
function sortedHash(value) {
  const sort = (input) => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, sort(input[key])]));
    }
    return input;
  };
  return sha256(Buffer.from(JSON.stringify(sort(value))));
}

async function startServer(directory) {
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace("/", "");
    if (request.method !== "GET" || name.includes("..") || !/\.(html|js)$/.test(name)) {
      response.writeHead(404).end(); return;
    }
    response.writeHead(200, { "Content-Type": name.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript" })
      .end(await readFile(path.join(directory, name)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function findChromeRootPidSync(userDataDir) {
  const pattern = userDataDir.replaceAll("'", "''");
  const script = `
    $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"
    $matching = @($procs | Where-Object { $_.CommandLine -like '*${pattern}*' })
    $chromeIds = @{}
    foreach ($p in $procs) { $chromeIds[[int]$p.ProcessId] = $true }
    $main = $matching | Where-Object { -not $chromeIds.ContainsKey([int]$_.ParentProcessId) } | Select-Object -First 1
    if ($main) { $main.ProcessId } else { ($matching | Sort-Object ProcessId | Select-Object -First 1).ProcessId }
  `;
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 30_000, windowsHide: true });
  const pid = Number(result.stdout.trim().split(/\r?\n/).filter(Boolean).pop());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function startTreeSampler(rootPid, metricsPath) {
  const sampler = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    path.join(harnessRoot, "run-windows-process-tree-metrics.ps1"),
    "-RootProcessId", String(rootPid), "-MetricsPath", metricsPath,
    "-TimeoutSeconds", "240", "-SampleIntervalMilliseconds", "200"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  sampler.stderr?.on("data", (data) => console.error(`[sampler stderr] ${String(data).slice(0, 400)}`));
  sampler.on("exit", (code) => console.error(`[sampler exit] code=${code}`));
  return sampler;
}

async function waitForSamplerFinish(metricsPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(metricsPath)) {
      try {
        const metrics = JSON.parse(await readFile(metricsPath, "utf8"));
        if (metrics.finished === true) return; // 采样器已确认进程树退出并写盘
      } catch { /* 增量写盘中读到半截文件，下一轮重试 */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function normalizeGpuSamples(rawValues) {
  const finite = rawValues.filter((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
  if (finite.length === 0) return { samplesMs: [], unitDecision: "no-finite-samples" };
  const median = quantiles(finite).p50;
  // Babylon perfCounter.current 原始为纳秒（WebGPU timestamp 两值相减），>1000 视为纳秒换算毫秒；
  // 若已落毫秒量级（0.01~50ms）则原样采用；越界值不采信、如实丢弃。
  if (median > 1000) return { samplesMs: finite.map((value) => value / 1e6), unitDecision: "nanoseconds->milliseconds (/1e6)" };
  if (median >= 0.01 && median <= 50) return { samplesMs: finite, unitDecision: "already-milliseconds" };
  return { samplesMs: [], unitDecision: `implausible-scale (median=${median}) discarded` };
}

async function runRound(round, mode, userDataDir, origin) {
  const launchWallclock = Date.now();
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu"],
    viewport: { width: settings.width, height: settings.height }, deviceScaleFactor: 1 });
  const rawDirectory = path.join(outputDirectory, "raw");
  const metricsPath = path.join(rawDirectory, `round-${round}-chrome-tree.process-metrics.json`);
  let sampler = null;
  try {
    const rootPid = findChromeRootPidSync(userDataDir);
    if (rootPid === null) throw new Error("chrome root pid not found for user-data-dir");
    sampler = startTreeSampler(rootPid, metricsPath);

    const page = await context.newPage();
    page.on("pageerror", (error) => console.error(`[pageerror] ${String(error).slice(0, 300)}`));
    page.on("crash", () => console.error("[crash] page crashed"));
    page.on("requestfailed", (request) => console.error(`[requestfailed] ${request.url().slice(-80)} ${request.failure()?.errorText}`));
    page.on("console", (message) => { if (message.type() === "error") console.error(`[console.error] ${message.text().slice(0, 300)}`); });
    const tLaunchWallclock2 = Date.now(); // 导航起点（冷启动口径：浏览器启动→页面 load 完成）
    await page.goto(`${origin}/bench.html`, { waitUntil: "load" });
    await page.waitForFunction(() => typeof window.__runBabylonWebBench === "function", null, { timeout: 120_000 });
    const result = await Promise.race([
      page.evaluate(async (benchSettings) => window.__runBabylonWebBench(benchSettings), settings),
      new Promise((_, reject) => setTimeout(() => reject(new Error("bench evaluate timeout (240s)")), 240_000)),
    ]);
    const userAgent = await page.evaluate(() => navigator.userAgent);
    result.userAgent = userAgent;
    result.chromeRootPid = rootPid;
    // 冷启动口径（与 bevy 对齐的两段式）：cold-start = 浏览器启动→页面 load 完成；
    // load-to-interactive = 浏览器启动→首帧渲染完成（本轨道两事件的页面内时刻不同）。
    result.coldStartMs = tLaunchWallclock2 - launchWallclock;
    result.loadToInteractiveMs = (result.pagePerfOriginWallclock + result.pageTiming.firstFrameMs) - launchWallclock;
    // 截图取证产物落盘（人工可查验的 PNG）+ 像素计数
    if (result.snapshot?.pngBase64) {
      await writeFile(path.join(rawDirectory, `round-${round}-snapshot.png`),
        Buffer.from(result.snapshot.pngBase64, "base64"));
    }
    result.snapshotPixels = result.snapshot?.pixels ?? null;
    return result;
  } finally {
    await context.close();
    if (sampler) {
      await waitForSamplerFinish(metricsPath, 30_000);
      sampler.kill();
    }
  }
}

async function main() {
  const rawDirectory = path.join(outputDirectory, "raw");
  await mkdir(rawDirectory, { recursive: true });

  // 1) esbuild CLI 打包基准页（--splitting 保持模块边界；@babylonjs/core 整包含全部 side-effect 注册）
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "babylon-web-bench-"));
  const bundleOut = path.join(bundleDirectory, "bundle");
  await mkdir(bundleOut, { recursive: true });
  const bundle = spawnSync(process.execPath, [esbuildBin, path.join(harnessRoot, "runner/bench.mjs"),
    "--bundle", "--format=esm", "--splitting", "--target=es2022", "--legal-comments=eof",
    `--outdir=${bundleOut}`, "--entry-names=bench", "--chunk-names=chunk-[hash]"],
    { cwd: harnessRoot, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (bundle.status !== 0 || !existsSync(path.join(bundleOut, "bench.js"))) {
    throw new Error(`Babylon 基准页打包失败：\n${bundle.stdout ?? ""}\n${bundle.stderr ?? ""}`);
  }
  const benchHtml = (await readFile(path.join(harnessRoot, "runner/bench.html"), "utf8"));
  await writeFile(path.join(bundleOut, "bench.html"), benchHtml);
  const { server, origin } = await startServer(bundleOut);

  // 2) 三轮冷热交替采集（冷=全新 profile；热=复用上一冷轮 profile）
  const rounds = [];
  const tempDirectories = [];
  let hotDirectory = null;
  for (let index = 1; index <= totalRounds; index += 1) {
    const mode = index % 2 === 0 ? "hot" : "cold";
    const userDataDir = mode === "hot" && hotDirectory
      ? hotDirectory
      : await mkdtemp(path.join(tmpdir(), "babylon-web-chrome-profile-"));
    if (mode === "cold") { tempDirectories.push(userDataDir); hotDirectory = userDataDir; }
    const bench = await runRound(index, mode, userDataDir, origin);
    const gpu = normalizeGpuSamples(bench.gpuMs ?? []);
    const reference = measurements(bench.renderMs, gpu.samplesMs, {
      coldStartMs: bench.coldStartMs,
      loadToInteractiveMs: bench.loadToInteractiveMs,
      peakGpuBytes: null, // 见 processMetrics.peakGpuBytes；系统无 GPU Process Memory 计数器时保持 null
    });
    const processMetrics = existsSync(path.join(rawDirectory, `round-${index}-chrome-tree.process-metrics.json`))
      ? JSON.parse(await readFile(path.join(rawDirectory, `round-${index}-chrome-tree.process-metrics.json`), "utf8"))
      : null;
    reference["peak-host-bytes"] = processMetrics?.peakHostBytes ?? null;
    reference["peak-gpu-bytes"] = processMetrics?.peakGpuBytes ?? null;

    const rawRun = { schema: "deep-engine.babylon-web-raw-run", schemaVersion: 1,
      engine: { reference: "babylon", version: "9.26.1", renderer: bench.backend, track: "babylon-web" },
      environment: { platform: process.platform, arch: process.arch, headless: true,
        chromeRootPid: bench.chromeRootPid, userAgent: bench.userAgent, adapter: bench.adapter,
        glInfo: bench.glInfo, dpr: bench.dpr, canvasSize: bench.canvasSize },
      fixture: { id: fixture.id, instanceCount: bench.fixture.instanceCount, geometryCount: fixture.geometryCount,
        materialCount: fixture.materialCount, triangles: bench.fixture.triangles,
        activeMeshCount: bench.fixture.activeMeshCount },
      settings: { ...settings, backendRequested: "webgpu-preferred", backendActual: bench.backend,
        frameClock: "synchronous scene.render() loop（无 rAF/vsync 钳制）", lightIntensity: 3.0,
        shadowMapSize: bench.shadowEnabled ? 1024 : 0, gpuTimestamps: bench.gpuTimestamps,
        gpuUnitDecision: gpu.unitDecision },
      samples: { frameRenderMs: bench.renderMs, gpuFrameRawValues: bench.gpuMs, heapSamples: bench.heapSamples,
        heapFinalBytes: bench.heapFinal },
      observations: { coldStartMs: bench.coldStartMs, loadToInteractiveMs: bench.loadToInteractiveMs,
        snapshotPixels: bench.snapshotPixels, snapshotError: bench.snapshot?.error ?? null,
        cameraFront: bench.cameraFront, engineReady: bench.engineReady, activeMeshCount: bench.fixture.activeMeshCount,
        materialReadyAfterFirstRender: bench.materialReadyAfterFirstRender,
        sceneReadyAfterFirstRender: bench.sceneReadyAfterFirstRender,
        materialReadyAtEnd: bench.materialReadyAtEnd,
        sceneReadyAtEnd: bench.sceneReadyAtEnd,
        cubeVisible: bench.cubeVisible,
        shadowEnabled: bench.shadowEnabled, shadowError: bench.shadowError,
        gpuTimestamps: bench.gpuTimestamps, gpuTimestampError: bench.gpuTimestampError,
        engineType: bench.engineType, unavailableReason: bench.unavailableReason },
      processMetrics };
    const rawPath = path.join(rawDirectory, `round-${index}-babylon.json`);
    await writeFile(rawPath, `${JSON.stringify(rawRun, null, 2)}\n`);
    rounds.push({ round: index, order: ["reference"], mode, candidate: null, reference,
      raw: { reference: rawRun } });
    console.log(`round ${index} (${mode}, ${bench.backend}): render p50=${quantiles(bench.renderMs).p50.toFixed(3)}ms ` +
      `p99=${quantiles(bench.renderMs).p99.toFixed(3)}ms gpu=${gpu.samplesMs.length ? quantiles(gpu.samplesMs).p50.toFixed(4) : "n/a"} ` +
      `pixels=${bench.snapshotPixels} peakHostBytes=${reference["peak-host-bytes"]}`);
  }
  server.close();

  // 3) 组装与 bevy 轨道同 schema 的 paired evidence（candidate 侧留待后续切片）
  const firstRaw = rounds[0].raw.reference;
  const environment = { platform: process.platform, arch: process.arch,
    candidate: null,
    reference: { browser: { name: "chrome-headless", version: (firstRaw.environment.userAgent ?? "").match(/Chrome\/([\d.]+)/)?.[1] ?? "unknown" },
      gpu: firstRaw.environment.adapter ?? { renderer: firstRaw.environment.glInfo?.renderer ?? "unknown", source: "WEBGL_debug_renderer_info fallback" },
      backend: firstRaw.engine.renderer, headless: true },
    viewport: [settings.width, settings.height] };
  const missingRequiredMetrics = REQUIRED_METRICS.filter((metric) => rounds.some((round) =>
    !Number.isFinite(round.candidate?.[metric]) || !Number.isFinite(round.reference[metric])));
  const evidence = { schema: "deep-engine.competitive-benchmark.paired-raw", schemaVersion: 2,
    case: { id: `${fixture.id}/babylon-web`, track: "babylon-web", reference: "babylon",
      referenceVersion: "9.26.1", environmentHash: sortedHash(environment),
      fixtureHash: sortedHash(fixture), settingsHash: sortedHash(settings) },
    environment, fixture, settings, rounds,
    provenance: { runner: "scripts/benchmarks/babylon-web/run-babylon-web-benchmark.mjs",
      babylonPackage: "@babylonjs/core@9.26.1",
      babylonSource: "npm registry，独立基准目录自带 node_modules（package-lock.json 固定版本）",
      chromePath, chromeArgs: ["--enable-unsafe-webgpu"], headless: true,
      playwrightVersion: "apps/cloud-render-worker/node_modules/playwright-core",
      evidenceSchemaMirror: "scripts/lib/deepBevyPairedEvidence.mjs（measurements/REQUIRED/hash 语义同构）",
      rawFiles: rounds.flatMap((round) => [path.join(rawDirectory, `round-${round.round}-babylon.json`),
        path.join(rawDirectory, `round-${round.round}-chrome-tree.process-metrics.json`)]),
      generatedAt: new Date().toISOString(),
      caveats: [
        "单侧采集轮：candidate（Deep 对应轨道）未采集，配对与胜出判定留后续切片，eligibleForBenchmarkVerdict=false。",
        "cpu-frame-* 为同步 scene.render() 墙钟（循环驱动）；bevy 轨道 cpu-frame-* 为帧间隔 delta，两者语义相近但非同一口径。",
        "材质/光照口径差异：Babylon PBRMaterial + ACES tonemapping + 1024 PCF 阴影 vs Bevy StandardMaterial(18000 lux) + 默认阴影；单位体系不同，仅做同夹具规模对齐，不做画质对齐。",
        "Babylon WebGPU 后端在 Windows Chrome 上经 Dawn 走 D3D 层，与 Bevy Vulkan 后端不构成同一图形 API 口径。",
        "GPU 帧时依赖 Babylon timestamp-query；引擎或驱动不支持时该轮如实为空。",
      ] },
    readiness: { status: "incomplete", pairedAlternatingRounds: 0, missingRequiredMetrics,
      environmentIssues: [], eligibleForBenchmarkVerdict: false },
    claim: { status: "not-evaluated", passed: false,
      reason: "Babylon 单侧采集完成；candidate（Deep）侧未采集，配对评估留后续切片。" } };
  const evidencePath = path.join(outputDirectory, "paired-evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  // 4) 复用仓内聚合脚本（零修改）出报告——同时验证单侧数据兼容性
  const summaryPath = path.join(outputDirectory, "paired-summary.md");
  const summary = spawnSync(process.execPath, [path.join(repoRoot, "scripts/benchmarks/paired-summary.mjs"),
    evidencePath, summaryPath], { encoding: "utf8", timeout: 60_000 });
  if (summary.status !== 0) throw new Error(`paired-summary failed: ${summary.stderr || summary.stdout}`);

  // 5) 门禁自检：非空样本 + schema 同构
  const gate = rounds.length === totalRounds
    && rounds.every((round) => round.reference["cpu-frame-p50-ms"] > 0
      && round.raw.reference.samples.frameRenderMs.length === settings.sampleFrames
      && round.raw.reference.samples.frameRenderMs.every((value) => Number.isFinite(value) && value > 0)
      && Number.isFinite(round.raw.reference.observations.snapshotPixels)
      && round.raw.reference.observations.snapshotPixels > 0
      && round.raw.reference.processMetrics?.peakHostBytes > 0);
  console.log(JSON.stringify({ gate, outputDirectory, evidencePath, summaryPath,
    rounds: rounds.length, schema: evidence.schema,
    caseId: evidence.case.id, track: evidence.case.track,
    sampleFramesPerRound: rounds.map((round) => round.raw.reference.samples.frameRenderMs.length),
    missingRequiredMetrics }, null, 2));
  if (!gate) { process.exitCode = 2; }

  for (const directory of tempDirectories) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  await rm(bundleDirectory, { recursive: true, force: true }).catch(() => {});
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
