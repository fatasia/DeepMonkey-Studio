import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cpus, platform, release, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { createStaticServer } from "./productBrowserSupport.mjs";
import { compareBackendImages } from "./renderImageSimilarity.mjs";
import { assessFirstClassWebGpuEvidence } from "./renderEngineBenchmarkEvidence.mjs";

const { chromium } = playwright;
const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(webRoot, "../..");
const benchmarkRoot = resolve(webRoot, "benchmarks/render-engine");
const outputRoot = resolve(repositoryRoot, "test-output/render-engine-comparison");
const distRoot = resolve(outputRoot, "dist");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const runs = finiteEnvironment("BIM_STUDIO_RENDER_BENCHMARK_RUNS", 5, 1, 7);
const rebuildCycles = finiteEnvironment("BIM_STUDIO_RENDER_BENCHMARK_CYCLES", 20, 1, 30);
const engines = ["three-webgl", "three-webgpu"];
const workloads = ["static", "dynamic"];
const objectCounts = [120, 1000];
const geometryParityTolerance = 0.01;
const hostCpus = cpus();
const webManifest = JSON.parse(readFileSync(resolve(webRoot, "package.json"), "utf8"));

if (!existsSync(chromePath)) throw new Error(`Chrome 不存在：${chromePath}`);
mkdirSync(outputRoot, { recursive: true });
buildArtifact();
const server = createStaticServer(distRoot);
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const address = server.address();
if (!address || typeof address === "string") throw new Error("无法创建渲染引擎基准服务器");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--js-flags=--expose-gc"],
});
const report = {
  schemaVersion: 2,
  createdAt: new Date().toISOString(),
  chromePath,
  runs,
  rebuildCycles,
  host: {
    platform: platform(),
    release: release(),
    cpu: hostCpus[0]?.model ?? "unknown",
    logicalCpuCount: hostCpus.length,
    totalMemoryBytes: totalmem(),
    graphics: graphicsDeviceEvidence(),
  },
  source: sourceRevisionEvidence(),
  dependencies: {
    three: webManifest.dependencies?.three,
    playwright: "cloud-render-worker workspace dependency",
  },
  protocol: {
    decisionScope: "isolation-signal-only",
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    workloads,
    objectCounts,
    colorPipeline: "sRGB + ACES",
    shadowMapSize: 1024,
    geometryParityTolerance,
    frameWarmupSamples: 180,
    featureCoverage: {
      measured: ["PBR", "ACES", "directional-shadow", "static-transform", "200-object-dynamic-transform"],
      releaseDeferred: ["transparent-clipping", "skinned-animation", "particles", "postprocessing", "Rapier-R5", "device-loss"],
    },
    comparisonDimensions: {
      performance: "isolated-static-and-transform-signal",
      visualQuality: "partial-pbr-shadow-only",
      animation: "transform-only",
      physics: "product-r5-pending",
      renderPipeline: "feature-audit-only",
    },
    webGpuFirstClassEvidence: ["adapter-and-limits", "timestamp-query-when-supported", "WebGL/WebGPU-visual-consistency", "heap-after-rebuild", "long-task"],
    webGpuPromotion: { requiredR1ToR5Wins: 4, p95Improvement: 0.15, maximumOtherRegression: 0.05 },
  },
  artifactBytes: directoryBytes(distRoot),
  cases: [],
  failures: [],
  warnings: [],
  promotionDecision: {
    eligible: false,
    status: "blocked-incomplete-release-coverage",
    reason: "隔离夹具尚未覆盖完整 R1–R5、产品适配层和 Unity Release Player，不能据此把 WebGPU 提升为默认后端",
  },
};

try {
  for (const objectCount of objectCounts) {
    for (const workload of workloads) {
      for (const engine of engines) {
        for (let run = 1; run <= runs; run += 1) {
          const result = await inspectCase(browser, origin, { engine, workload, objectCount, run });
          report.cases.push(result);
          console.log(`[render-engine] ${engine} · ${workload} · ${objectCount} objects · ${run}/${runs} · ${summary(result)}`);
        }
      }
    }
  }
  report.failures.push(...assessValidity(report.cases));
  report.warnings.push(...assessPerformanceSignals(report.cases));
  report.visualComparisons = await compareBackendImages(outputRoot);
  report.failures.push(...assessFirstClassWebGpuEvidence(report.cases, report.visualComparisons, rebuildCycles));
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(resolve(outputRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(resolve(outputRoot, "report.md"), renderMarkdown(report), "utf8");
  await browser.close();
  await new Promise((closed, reject) => server.close((error) => (error ? reject(error) : closed())));
}

if (report.failures.length > 0) throw new Error(`渲染引擎对比基准无效：\n- ${report.failures.join("\n- ")}`);
console.log(`[render-engine] 对比完成：${resolve(outputRoot, "report.md")}`);

async function inspectCase(browserInstance, baseUrl, testCase) {
  const context = await browserInstance.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("requestfailed", (request) => errors.push(`request: ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`));
  const url = `${baseUrl}/?engine=${testCase.engine}&workload=${testCase.workload}&count=${testCase.objectCount}`;
  let initial;
  let final;
  let environment;
  let observations;
  const heapSamples = [];

  try {
    await page.addInitScript(() => {
      const longTasks = [];
      window.__renderBenchmarkObservations = { longTasks, supported: PerformanceObserver.supportedEntryTypes.includes("longtask") };
      if (window.__renderBenchmarkObservations.supported) {
        new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: "longtask", buffered: true });
      }
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    await page.waitForFunction(() => window.__renderEngineBenchmark?.ready || window.__renderEngineBenchmark?.error, undefined, { timeout: 45_000 });
    const state = await page.evaluate(() => window.__renderEngineBenchmark);
    if (state?.error) throw new Error(state.error);
    initial = state?.snapshot;
    environment = await page.evaluate(async () => {
      const resources = performance.getEntriesByType("resource");
      const adapter = "gpu" in navigator ? await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }) : null;
      const webGl2 = document.createElement("canvas").getContext("webgl2");
      return {
        userAgent: navigator.userAgent,
        webGpuAdapter: adapter?.info ? { ...adapter.info } : undefined,
        webGpuFeatures: adapter ? [...adapter.features].sort() : undefined,
        webGpuLimits: adapter
          ? {
              maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
              maxBindGroups: adapter.limits.maxBindGroups,
              maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
              maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
            }
          : undefined,
        webGlTimerQuery: Boolean(webGl2?.getExtension("EXT_disjoint_timer_query_webgl2")),
        loadedTransferBytes: resources.reduce((total, item) => total + (item.transferSize || item.encodedBodySize || 0), 0),
        loadedResourceCount: resources.length,
      };
    });
    await collectGarbage(page, cdp);
    heapSamples.push(await usedHeap(page));
    for (let cycle = 1; cycle <= rebuildCycles; cycle += 1) {
      final = await page.evaluate((value) => window.__renderEngineBenchmark.rebuild(value), cycle);
      await collectGarbage(page, cdp);
      heapSamples.push(await usedHeap(page));
    }
    observations = await page.evaluate(() => {
      const values = window.__renderBenchmarkObservations?.longTasks ?? [];
      return {
        supported: window.__renderBenchmarkObservations?.supported ?? false,
        count: values.length,
        totalMs: values.reduce((total, value) => total + value, 0),
        maximumMs: Math.max(0, ...values),
      };
    });
    if (testCase.workload === "static" && testCase.run === 1 && testCase.objectCount === 120) {
      await page.locator("#viewport").screenshot({ path: resolve(outputRoot, `${testCase.engine}-canvas.png`) });
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    await context.close();
  }

  return {
    ...testCase,
    initial,
    final,
    environment,
    observations,
    heapSamples,
    heapDeltaBytes: heapSamples.length > 1 ? heapSamples.at(-1) - heapSamples[0] : undefined,
    errors,
  };
}

async function collectGarbage(page, cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  await page.evaluate(() => new Promise((next) => requestAnimationFrame(next)));
  await cdp.send("HeapProfiler.collectGarbage");
}

async function usedHeap(page) {
  return page.evaluate(() => performance.memory?.usedJSHeapSize ?? Number.NaN);
}

function assessValidity(cases) {
  const failures = [];
  for (const item of cases) {
    const prefix = `${item.engine}/${item.workload}/${item.objectCount}/run-${item.run}`;
    failures.push(...item.errors.map((error) => `${prefix}: ${error}`));
    if (!item.initial || !item.final) failures.push(`${prefix}: 缺少初始或最终快照`);
    if (item.final?.objectCount !== item.objectCount) failures.push(`${prefix}: 对象数量不一致`);
    if (item.final?.workload !== item.workload) failures.push(`${prefix}: 工作负载标识不一致`);
    if ((item.final?.frames?.samples ?? 0) < 120) failures.push(`${prefix}: 有效帧样本少于 120`);
    if ((item.final?.triangles ?? 0) <= 0) failures.push(`${prefix}: 三角面统计无效`);
    if (item.engine.endsWith("webgpu") && !item.environment?.webGpuAdapter) failures.push(`${prefix}: 未记录到 WebGPU 适配器`);
    const gpuTimerExpected = item.engine.endsWith("webgpu") ? item.environment?.webGpuFeatures?.includes("timestamp-query") : item.environment?.webGlTimerQuery;
    if (gpuTimerExpected && (item.final?.gpuFrames?.samples ?? 0) < 1) failures.push(`${prefix}: 设备支持 GPU 计时但没有取得样本`);
  }
  for (const objectCount of objectCounts) {
    for (const workload of workloads) {
      for (let run = 1; run <= runs; run += 1) {
        const comparable = cases.filter(
          (item) => item.objectCount === objectCount && item.workload === workload && item.run === run && item.final,
        );
        if (comparable.length !== engines.length) continue;
        const triangles = comparable.map((item) => item.final.triangles);
        const smallest = Math.min(...triangles);
        const largest = Math.max(...triangles);
        const difference = largest > 0 ? (largest - smallest) / largest : Number.POSITIVE_INFINITY;
        if (difference > geometryParityTolerance) {
          const evidence = comparable.map((item) => `${item.engine}=${item.final.triangles}`).join("，");
          failures.push(
            `${workload}/${objectCount}/run-${run}: WebGL/WebGPU 三角面差异 ${(difference * 100).toFixed(2)}%，超过 ${(geometryParityTolerance * 100).toFixed(0)}% 门槛（${evidence}）`,
          );
        }
      }
    }
  }
  return failures;
}

function assessPerformanceSignals(cases) {
  const warnings = [];
  for (const objectCount of objectCounts) {
    for (const workload of workloads) {
      const webGl = cases.filter((item) => item.engine === "three-webgl" && item.workload === workload && item.objectCount === objectCount && item.initial);
      const webGpu = cases.filter((item) => item.engine === "three-webgpu" && item.workload === workload && item.objectCount === objectCount && item.initial);
      const webGlP99 = median(webGl.map((item) => item.initial.frames?.p99Ms));
      const webGpuP99 = median(webGpu.map((item) => item.initial.frames?.p99Ms));
      if (Number.isFinite(webGlP99) && webGpuP99 > Math.max(33.3, webGlP99 * 2)) {
        warnings.push(`${workload}/${objectCount}: WebGPU P99 ${fixed(webGpuP99)}ms 明显劣于 WebGL ${fixed(webGlP99)}ms`);
      }
      const heapGrowth = maximum(webGpu.map((item) => item.heapDeltaBytes));
      if (heapGrowth > 32 * 1024 * 1024) {
        warnings.push(`${workload}/${objectCount}: WebGPU 最差重建堆增长 ${fixed(heapGrowth / 1024 / 1024)} MiB，需结合长稳报告排查`);
      }
      const webGlBlocking = median(webGl.map((item) => item.observations?.totalMs));
      const webGpuBlocking = median(webGpu.map((item) => item.observations?.totalMs));
      if (Number.isFinite(webGlBlocking) && webGpuBlocking > Math.max(500, webGlBlocking * 2)) {
        warnings.push(`${workload}/${objectCount}: WebGPU Long Task 总阻塞 ${fixed(webGpuBlocking)}ms，明显高于 WebGL ${fixed(webGlBlocking)}ms`);
      }
      const webGlGpuP95 = median(webGl.map((item) => item.final?.gpuFrames?.p95Ms));
      const webGpuGpuP95 = median(webGpu.map((item) => item.final?.gpuFrames?.p95Ms));
      if (webGlGpuP95 > 0 && webGpuGpuP95 > Math.max(webGlGpuP95 * 1.2, webGlGpuP95 + 1)) {
        warnings.push(`${workload}/${objectCount}: WebGPU GPU P95 ${fixed(webGpuGpuP95)}ms 高于 WebGL ${fixed(webGlGpuP95)}ms`);
      }
    }
  }
  return warnings;
}

function renderMarkdown(current) {
  const rows = [];
  for (const count of objectCounts) {
    for (const workload of workloads) {
      for (const engine of engines) {
        const cases = current.cases.filter((item) => item.engine === engine && item.workload === workload && item.objectCount === count && item.final);
        rows.push([
          engine,
          workload,
          count,
          fixed(median(cases.map((item) => item.final?.triangles)), 0),
          fixed(median(cases.map((item) => item.initial?.initializedMs))),
          fixed(median(cases.map((item) => item.initial?.firstFrameMs))),
          fixed(median(cases.map((item) => item.initial?.frames?.averageMs))),
          fixed(median(cases.map((item) => item.initial?.frames?.p50Ms))),
          fixed(median(cases.map((item) => item.initial?.frames?.p95Ms))),
          fixed(maximum(cases.map((item) => item.initial?.frames?.p95Ms))),
          fixed(median(cases.map((item) => item.initial?.frames?.p99Ms))),
          fixed(median(cases.map((item) => item.initial?.frames?.maximumMs))),
          fixed(maximum(cases.map((item) => item.initial?.frames?.maximumMs))),
          fixed(median(cases.map((item) => item.final?.gpuFrames?.p50Ms))),
          fixed(median(cases.map((item) => item.final?.gpuFrames?.p95Ms))),
          fixed(median(cases.map((item) => item.final?.lastRebuildMs))),
          fixed(median(cases.map((item) => item.final?.drawCalls)), 0),
          fixed(median(cases.map((item) => item.environment?.loadedTransferBytes / 1024))),
          fixed(median(cases.map((item) => item.heapDeltaBytes / 1024 / 1024))),
          fixed(maximum(cases.map((item) => item.heapDeltaBytes / 1024 / 1024))),
          fixed(median(cases.map((item) => item.observations?.count)), 0),
          fixed(median(cases.map((item) => item.observations?.totalMs))),
          fixed(maximum(cases.map((item) => item.observations?.maximumMs))),
        ]);
      }
    }
  }
  const visualRows = (current.visualComparisons ?? []).map(
    (item) =>
      `| ${item.reference} | ${item.candidate} | ${fixed(item.ssim, 3)} | ${fixed(item.meanAbsoluteError * 100, 2)}% | ${fixed(item.changedPixelRatio * 100, 2)}% | ${fixed(item.severePixelRatio * 100, 2)}% | ${Number.isFinite(item.psnrDb) ? fixed(item.psnrDb, 1) : "∞"} |`,
  );
  const webGpuEnvironment = current.cases.find((item) => item.environment?.webGpuAdapter)?.environment;
  const adapter = webGpuEnvironment?.webGpuAdapter;
  const hostDescription = [
    current.host.cpu,
    `${current.host.logicalCpuCount} logical CPUs`,
    `${(current.host.totalMemoryBytes / 1024 ** 3).toFixed(1)} GiB`,
    current.host.platform,
    current.host.release,
  ].join(" · ");
  const gpuDescription =
    current.host.graphics
      ?.map((item) => `${item.name} / ${item.driverVersion} / ${item.memoryMiB} MiB`)
      .join("；") || "未由 nvidia-smi 提供";
  const adapterDescription = adapter
    ? [adapter.vendor, adapter.architecture, adapter.device, adapter.description].filter(Boolean).join(" · ")
    : "无数据";
  const timestampSupport = webGpuEnvironment?.webGpuFeatures?.includes("timestamp-query")
    ? "支持"
    : "不支持或未暴露";
  const limitsDescription = webGpuEnvironment?.webGpuLimits
    ? JSON.stringify(webGpuEnvironment.webGpuLimits)
    : "无数据";
  return [
    "# Three.js WebGL / WebGPU 同场景基准",
    "",
    `生成时间：${current.createdAt}；每组 ${current.runs} 次冷上下文运行；固定 1440×900、DPR 1、ACES、PBR、1024 阴影。`,
    "",
    `运行主机：${hostDescription}；GPU：${gpuDescription}。`,
    "",
    `源码：${current.source.revision}${current.source.workingTreeDirty ? "（工作区有未提交变更）" : ""}；Three ${current.dependencies.three}。`,
    "",
    "> 帧时间来自浏览器 RAF 节拍，包含主线程与提交抖动，并非 GPU timestamp；夹具比较裸引擎行为，不注入产品私有补丁；Draw Call 为各引擎原生计数，统计口径不完全相同。",
    "",
    `WebGPU 适配器：${adapterDescription}；timestamp-query：${timestampSupport}；关键 limits：${limitsDescription}。`,
    "",
    `本轮决策范围：${current.protocol.decisionScope}；WebGPU 独立证据：${current.protocol.webGpuFirstClassEvidence.join("、")}。`,
    "",
    `本轮已测能力：${current.protocol.featureCoverage.measured.join("、")}；仍需产品 R4/R5 验收：${current.protocol.featureCoverage.releaseDeferred.join("、")}。本报告不能单独批准 WebGPU 成为默认后端。`,
    "",
    `晋级结论：${current.promotionDecision.status}；${current.promotionDecision.reason}。`,
    "",
    `五维覆盖：${Object.entries(current.protocol.comparisonDimensions)
      .map(([name, status]) => `${name}=${status}`)
      .join("；")}。`,
    "",
    `| 后端 | 负载 | 对象 | 三角面 | 初始化 ms | 首帧 ms | 平均帧 ms | P50 ms | P95 中位 ms | P95 最差 ms | P99 中位 ms | 最大帧中位 ms | 最大帧最差 ms | GPU P50 ms | GPU P95 ms | 重建 ms | Draw Calls* | 冷加载 KiB | ${current.rebuildCycles} 次重建堆增中位 MiB | 堆增最差 MiB | Long Task 数 | Long Task 总 ms | Long Task 最大 ms |`,
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
    "## WebGL / WebGPU 画质一致性",
    "",
    "| 基准 | 候选 | SSIM | 归一化 MAE | 变化像素 | 严重变化像素 | PSNR dB |",
    "|---|---|---:|---:|---:|---:|---:|",
    ...visualRows,
    "",
    "> 只比较同一引擎的 WebGL/WebGPU，同一相机、场景与画布；SSIM 低于 0.7 视为严重画质回归。跨引擎画风差异不作为失败依据。",
    "",
    current.warnings.length ? `性能风险（不影响基准有效性）：${current.warnings.join("；")}` : "未发现超过当前工程阈值的性能风险。",
    "",
    current.failures.length ? `基准有效性失败：${current.failures.join("；")}` : "基准有效性检查通过。",
    "",
  ].join("\n");
}

function buildArtifact() {
  const pnpmEntry = process.env.npm_execpath;
  if (!pnpmEntry) throw new Error("当前进程缺少 npm_execpath，无法定位 pnpm 入口");
  const result = spawnSync(process.execPath, [pnpmEntry, "exec", "vite", "build", benchmarkRoot, "--outDir", distRoot, "--emptyOutDir"], {
    cwd: webRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`渲染引擎基准构建失败：\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

function directoryBytes(root) {
  return readdirSync(root, { withFileTypes: true }).reduce((total, entry) => {
    const path = resolve(root, entry.name);
    return total + (entry.isDirectory() ? directoryBytes(path) : statSync(path).size);
  }, 0);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return Number.NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function maximum(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : Number.NaN;
}

function finiteEnvironment(name, fallback, minimum, maximum) {
  const value = process.env[name] ? Number(process.env[name]) : fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} 必须在 ${minimum}–${maximum} 范围内`);
  return Math.round(value);
}

function fixed(value, digits = 1) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "无数据";
}
function summary(item) {
  return item.errors.length ? `失败 ${item.errors.join("; ")}` : `P95 ${fixed(item.initial?.frames?.p95Ms)}ms · 首帧 ${fixed(item.initial?.firstFrameMs)}ms`;
}

function sourceRevisionEvidence() {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8" });
  return {
    revision: revision.status === 0 ? revision.stdout.trim() : "unknown",
    workingTreeDirty: status.status === 0 ? Boolean(status.stdout.trim()) : undefined,
  };
}

function graphicsDeviceEvidence() {
  const result = spawnSync("nvidia-smi", ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, driverVersion, memoryMiB] = line.split(",").map((value) => value.trim());
      return { name, driverVersion, memoryMiB: Number(memoryMiB) };
    });
}
