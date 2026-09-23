// Night Lane B 性能基准 harness(2026-09-23)。
// 口径与 gate-viewer-performance-audit.mjs 一致:生产 QA 构建 + 本地静态服务 + headless Chrome,
// 但统一固定 5199 端口、产物落 test-output/glm-night-20260923/perf/,供 before/after 对拍。
// 用法: node apps/web/scripts/glm-night-perf-bench.mjs --label=baseline [--skip-build]
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { buildVisualQaArtifact, createStaticServer } from "./productBrowserSupport.mjs";

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(webRoot, "../..");
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v = "true"] = a.replace(/^--/, "").split("=");
  return [k, v];
}));
const label = args.label ?? "run";
const output = resolve(repoRoot, "test-output/glm-night-20260923/perf", label);
mkdirSync(output, { recursive: true });
const dist = args.dist ? resolve(repoRoot, args.dist) : resolve(output, "dist");
if (!args["skip-build"] || !existsSync(resolve(dist, "index.html"))) {
  buildVisualQaArtifact({ webRoot, outputRoot: dist });
} else {
  console.log("[bench] 复用既有构建:", dist);
}
const PORT = 5199;
const server = createStaticServer(dist);
await new Promise(done => server.listen(PORT, "127.0.0.1", done));
const origin = `http://127.0.0.1:${PORT}`;
const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--js-flags=--expose-gc", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
});
const report = {
  createdAt: new Date().toISOString(),
  label,
  boundary: "Production QA build, headless Chrome 1440x900 DPR1, deterministic primitive scene; same-machine before/after comparison only, not cross-device SLA",
  cases: {},
};

// 打开一页 QA 夹具并等待就绪;返回 page 与启动耗时。
async function openViewer(query, { trackLongTasks = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  if (trackLongTasks) {
    await page.addInitScript(() => {
      window.__longTasks = [];
      try {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            window.__longTasks.push({ start: Math.round(entry.startTime), duration: Math.round(entry.duration), name: entry.name });
          }
        }).observe({ entryTypes: ["longtask"] });
      } catch { /* longtask 不支持时静默 */ }
    });
  }
  const started = performance.now();
  await page.goto(`${origin}/?__visualQa=viewer&shadows=on${query}`, { waitUntil: "commit" });
  await page.waitForFunction(() => window.__viewerQa?.ready || window.__viewerQa?.error, undefined, { timeout: 90000 });
  const initial = await page.evaluate(() => window.__viewerQa);
  if (initial.error) throw new Error(`viewer QA 启动失败: ${initial.error}`);
  const qaReadyMs = Math.round(performance.now() - started);
  return { page, errors, qaReadyMs };
}

const readState = page => page.evaluate(() => window.__viewerQa);
// orbit 拖拽 steps 步(每步 ~26ms),用于在采样窗口内保持连续相机运动。
async function orbitDrag(page, bounds, steps) {
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  for (let step = 0; step < steps; step += 1) {
    await page.mouse.move(bounds.x + bounds.width / 2 + Math.sin(step / 20) * 240, bounds.y + bounds.height / 2 + Math.cos(step / 20) * 140, { steps: 2 });
    await page.waitForTimeout(26);
  }
  await page.mouse.up();
}
// 重置采样窗口后等待 N ms,再读性能快照(采样窗口约 600 帧,短等待读的是累计口径,因此统一 reset+等待)。
async function measureSteady(page, waitMs) {
  await page.evaluate(() => window.__viewerQaControl?.resetPerformanceSamples());
  await page.waitForTimeout(waitMs);
  return readState(page);
}
// CDP 堆指标峰值采样:每秒取一次 JSHeapUsedSize,返回峰值(MB)。
async function sampleHeapPeak(page, durationMs) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  let peak = 0;
  const endAt = Date.now() + durationMs;
  while (Date.now() < endAt) {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const heap = metrics.find(m => m.name === "JSHeapUsedSize")?.value ?? 0;
    if (heap > peak) peak = heap;
    await page.waitForTimeout(1000);
  }
  await cdp.detach().catch(() => undefined);
  return Math.round(peak / 1024 / 1024 * 10) / 10;
}
const perfOf = state => state?.performance ?? {};
const frameOf = state => perfOf(state)?.frameTimeMs ?? {};

try {
  const gpuInfo = await (await browser.newBrowserCDPSession()).send("SystemInfo.getInfo");
  report.gpu = gpuInfo.gpu?.devices;
  report.browser = browser.version();

  // ─── 1. 启动时长:每配置 3 次冷加载取中位数 ───
  {
    const entry = report.cases.startup = {};
    for (const renderer of ["webgl", "webgpu"]) for (const objects of [120, 1000]) {
      const samples = [];
      for (let i = 0; i < 3; i += 1) {
        const { page, qaReadyMs } = await openViewer(`&renderer=${renderer}&objects=${objects}&effects=on`);
        samples.push(qaReadyMs);
        await page.close();
      }
      const sorted = [...samples].sort((a, b) => a - b);
      entry[`${renderer}-${objects}`] = { samples, medianMs: sorted[1], minMs: sorted[0], maxMs: sorted[2] };
      console.log(`[startup] ${renderer} ${objects}: median ${sorted[1]}ms samples=${samples}`);
    }
  }

  // ─── 2. 交互帧统计(orbit 连续拖拽 9s,与门禁 renderBudget33ms 同口径)+ 空闲跳帧效率 ───
  for (const renderer of ["webgl", "webgpu"]) for (const objects of [120, 1000]) {
    const entry = report.cases[`interaction-${renderer}-${objects}`] = { errors: [] };
    const { page, errors } = await openViewer(`&renderer=${renderer}&objects=${objects}&effects=on`, { trackLongTasks: true });
    entry.errors.push(...errors);
    await page.waitForTimeout(2500); // 管线预热后稳定
    const canvas = page.locator(".viewer-visual-qa-canvas canvas");
    const bounds = await canvas.boundingBox();
    // 空闲效率:reset 后静置 5s,验证 renderDemand 跳帧(空闲不烧 GPU 是正确行为)
    const idleStart = await readState(page);
    await page.evaluate(() => window.__viewerQaControl?.resetPerformanceSamples());
    await page.waitForTimeout(5000);
    const idle = await readState(page);
    entry.idle = {
      sampleCount: perfOf(idle).sampleCount,
      renderDemand: idle.renderDemand ?? null,
    };
    // 交互帧统计:reset 后连续 orbit 拖拽 9 秒(320 步),覆盖采样窗口
    const heapSampler = sampleHeapPeak(page, 9000);
    await page.evaluate(() => window.__viewerQaControl?.resetPerformanceSamples());
    await orbitDrag(page, bounds, 320);
    await page.waitForTimeout(400);
    const interacting = await readState(page);
    entry.interaction = {
      fps: perfOf(interacting).fps, frameTimeMs: frameOf(interacting),
      over33msRate: perfOf(interacting).over33msRate, over50msRate: perfOf(interacting).over50msRate,
      drawCalls: perfOf(interacting).renderer?.drawCalls, triangles: perfOf(interacting).renderer?.triangles,
      heap: perfOf(interacting).heap, adaptiveRenderScale: perfOf(interacting).adaptiveRenderScale,
      pipelineWarmup: perfOf(interacting).renderer?.pipelineWarmup,
      pressureSignals: perfOf(interacting).pressureSignals,
      renderBudget33ms: (perfOf(interacting).frameTimeMs?.p95 ?? Infinity) <= 33.34,
    };
    entry.interactionHeapPeakMb = await heapSampler;
    entry.longTasks = await page.evaluate(() => window.__longTasks ?? []);
    await page.screenshot({ path: resolve(output, `${renderer}-${objects}-interaction.png`) });
    await page.close();
    console.log(`[interaction] ${renderer} ${objects}: fps ${entry.interaction.fps?.toFixed?.(1)} p50 ${entry.interaction.frameTimeMs?.p50?.toFixed?.(1)} p95 ${entry.interaction.frameTimeMs?.p95?.toFixed?.(1)} p99 ${entry.interaction.frameTimeMs?.p99?.toFixed?.(1)} budget33 ${entry.interaction.renderBudget33ms} longTasks ${entry.longTasks.length}`);
  }

  // ─── 3. 后处理栈开销:effects on vs off(拖拽 9s 期间采样,空闲帧被 renderDemand 跳过不可用) ───
  {
    const entry = report.cases.postProcessingCost = {};
    for (const renderer of ["webgl", "webgpu"]) {
      for (const effects of ["on", "off"]) {
        const { page } = await openViewer(`&renderer=${renderer}&objects=1000&effects=${effects}`);
        await page.waitForTimeout(2500);
        const bounds = await page.locator(".viewer-visual-qa-canvas canvas").boundingBox();
        await page.evaluate(() => window.__viewerQaControl?.resetPerformanceSamples());
        await orbitDrag(page, bounds, 320);
        await page.waitForTimeout(400);
        const state = await readState(page);
        entry[`${renderer}-effects-${effects}`] = { fps: perfOf(state).fps, frameTimeMs: frameOf(state), drawCalls: perfOf(state).renderer?.drawCalls };
        await page.close();
        console.log(`[postfx] ${renderer} effects=${effects}: p50 ${frameOf(state).p50?.toFixed?.(2)} p95 ${frameOf(state).p95?.toFixed?.(2)}`);
      }
    }
  }

  // ─── 3b. 极限规模:2500/5000 对象交互 + 遮挡剔除开/关 + 合批开/关(webgl) ───
  {
    const entry = report.cases.extremeScale = {};
    const dragCase = async (name, query) => {
      const { page } = await openViewer(query);
      await page.waitForFunction(() => (window.__viewerQa?.performance?.renderer?.pipelineWarmup?.status ?? "ready") === "ready", undefined, { timeout: 60000 }).catch(() => undefined);
      await page.waitForTimeout(2000);
      const bounds = await page.locator(".viewer-visual-qa-canvas canvas").boundingBox();
      await page.evaluate(() => window.__viewerQaControl?.resetPerformanceSamples());
      await orbitDrag(page, bounds, 320);
      await page.waitForTimeout(400);
      const state = await readState(page);
      entry[name] = {
        fps: perfOf(state).fps, frameTimeMs: frameOf(state),
        over33msRate: perfOf(state).over33msRate, over50msRate: perfOf(state).over50msRate,
        drawCalls: perfOf(state).renderer?.drawCalls, triangles: perfOf(state).renderer?.triangles,
        renderBudget33ms: (perfOf(state).frameTimeMs?.p95 ?? Infinity) <= 33.34,
        occlusion: state.occlusion ?? null, repeatedAssets: state.repeatedAssets ?? null,
        adaptiveRenderScale: perfOf(state).adaptiveRenderScale ?? null,
      };
      await page.close();
      const ft = entry[name].frameTimeMs;
      console.log(`[extreme] ${name}: fps ${entry[name].fps?.toFixed?.(1)} p50 ${ft?.p50?.toFixed?.(1)} p95 ${ft?.p95?.toFixed?.(1)} p99 ${ft?.p99?.toFixed?.(1)} draws ${entry[name].drawCalls} budget33 ${entry[name].renderBudget33ms}`);
    };
    await dragCase("webgl-2500", "&renderer=webgl&objects=2500&effects=on");
    await dragCase("webgl-5000", "&renderer=webgl&objects=5000&effects=on");
    await dragCase("webgpu-5000", "&renderer=webgpu&objects=5000&effects=on");
    await dragCase("webgl-5000-occlusion", "&renderer=webgl&objects=5000&effects=on&occlusion=on");
    await dragCase("webgl-5000-no-batching", "&renderer=webgl&objects=5000&effects=on&batching=off");
    await dragCase("webgl-5000-no-effects", "&renderer=webgl&objects=5000&effects=off");
  }

  // ─── 4. 内存保留:场景循环 5 次 + 多轮 GC 后残量 ───
  {
    const entry = report.cases.memoryRetention = {};
    const { page } = await openViewer("&renderer=webgl&objects=1000&effects=on");
    await page.waitForTimeout(2000);
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      await page.evaluate(c => window.__viewerQaControl.cycleScene(c), cycle);
      await page.waitForTimeout(1200);
    }
    // 多轮 GC + 间歇,避免只有一代被回收导致 WeakRef 迟迟不死
    for (let round = 0; round < 3; round += 1) {
      await page.evaluate(() => gc());
      await page.waitForTimeout(800);
    }
    entry.retained = await page.evaluate(() => window.__viewerQaControl?.retainedPrimitiveObjects());
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const { metrics } = await cdp.send("Performance.getMetrics");
    entry.heapAfterCyclesMb = Math.round((metrics.find(m => m.name === "JSHeapUsedSize")?.value ?? 0) / 1024 / 1024 * 10) / 10;
    entry.stateAfterCycles = await readState(page);
    await page.close();
    console.log(`[memory] retained tracked=${entry.retained?.tracked} alive=${entry.retained?.alive} heap=${entry.heapAfterCyclesMb}MB`);
  }
} catch (error) {
  report.failure = String(error && error.stack || error);
  console.error(report.failure);
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
  writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  console.log("[bench] 报告:", resolve(output, "report.json"));
}
if (report.failure) process.exitCode = 1;
