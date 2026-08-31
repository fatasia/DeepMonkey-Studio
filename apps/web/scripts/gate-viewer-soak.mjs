import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { buildVisualQaArtifact, createStaticServer } from "./productBrowserSupport.mjs";
import { analyzeRenderFrame, isBlankRenderFrame } from "./viewerSoakVisualHealth.mjs";

const { chromium } = playwright;
const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(webRoot, "../..");
const outputRoot = resolve(repositoryRoot, "test-output/viewer-soak");
const distRoot = resolve(outputRoot, "dist");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const durationMinutes = finiteEnvironment("BIM_STUDIO_SOAK_MINUTES", 480, 0.1, 24 * 60);
const sampleSeconds = finiteEnvironment("BIM_STUDIO_SOAK_SAMPLE_SECONDS", 30, 0.1, 60);
const rendererBackend = enumEnvironment("BIM_STUDIO_SOAK_RENDERER", "webgl", ["webgl", "webgpu"]);
const sceneObjectCount = Math.round(finiteEnvironment("BIM_STUDIO_SOAK_OBJECTS", 120, 120, 5_000));
const effectsEnabled = process.env.BIM_STUDIO_SOAK_EFFECTS !== "off";
const shadowsEnabled = process.env.BIM_STUDIO_SOAK_SHADOWS !== "off";
const effectVariant = process.env.BIM_STUDIO_SOAK_EFFECT_VARIANT ?? "all";
const repeatEffects = process.env.BIM_STUDIO_SOAK_REPEAT_EFFECTS === "1";
const heapSamplingEnabled = process.env.BIM_STUDIO_SOAK_HEAP_SAMPLING === "1";
const requiredSamples = Math.max(3, Math.ceil(durationMinutes * 60 / sampleSeconds));
const reportPath = resolve(outputRoot, `report-${rendererBackend}.json`);

if (!existsSync(chromePath)) throw new Error(`Chrome 不存在：${chromePath}`);
mkdirSync(outputRoot, { recursive: true });
buildVisualQaArtifact({ webRoot, outputRoot: distRoot });
const server = createStaticServer(distRoot);
await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
const address = server.address();
if (!address || typeof address === "string") throw new Error("无法创建长稳验收服务器");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--js-flags=--expose-gc"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const cdpSession = await page.context().newCDPSession(page);
const report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  requestedDurationMinutes: durationMinutes,
  rendererBackend,
  sceneObjectCount,
  sampleSeconds,
  requiredSamples,
  completedSamples: 0,
  samples: [],
  visualSamples: [],
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
  failures: []
};

page.on("console", (message) => { if (message.type() === "error") report.consoleErrors.push(message.text()); });
page.on("pageerror", (error) => report.pageErrors.push(error.message));
page.on("requestfailed", (request) => report.requestFailures.push(`${request.method()} ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`));

try {
  const query = new URLSearchParams({
    __visualQa: "viewer",
    renderer: rendererBackend,
    objects: String(sceneObjectCount),
    effects: effectsEnabled ? "on" : "off",
    shadows: shadowsEnabled ? "on" : "off",
    effect: effectVariant,
    repeatEffects: repeatEffects ? "true" : "false",
  });
  await page.goto(`${origin}/?${query.toString()}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__viewerQa?.ready || window.__viewerQa?.error, undefined, { timeout: 30_000 });
  const initialized = await page.evaluate(() => window.__viewerQa);
  if (initialized?.error) throw new Error(`${rendererBackend.toUpperCase()} 长稳夹具初始化失败：${initialized.error}`);
  await page.evaluate(async () => { for (let frame = 0; frame < 180; frame += 1) await new Promise(requestAnimationFrame); });
  if (heapSamplingEnabled) await cdpSession.send("HeapProfiler.startSampling", { samplingInterval: 16_384 });

  for (let index = 1; index <= requiredSamples; index += 1) {
    const sample = await collectSample(page, cdpSession, index);
    report.samples.push(sample);
    if (index === 1 || index === Math.ceil(requiredSamples / 2) || index === requiredSamples) {
      const png = await page.locator(".viewer-visual-qa-canvas").screenshot({ type: "png" });
      report.visualSamples.push({ index, ...await analyzeRenderFrame(png) });
    }
    report.completedSamples = index;
    if (index < requiredSamples) await page.waitForTimeout(sampleSeconds * 1_000);
    if (index === 1 || index === requiredSamples || index % Math.max(1, Math.round(300 / sampleSeconds)) === 0) {
      console.log(`[viewer-soak] ${index}/${requiredSamples} · heap ${formatMib(sample.postGcUsedJsHeapBytes)} MiB · P95 ${formatNumber(sample.p95FrameMs)}ms`);
    }
  }
  if (heapSamplingEnabled) {
    const { profile } = await cdpSession.send("HeapProfiler.stopSampling");
    report.allocationHotspots = summarizeAllocationProfile(profile);
  }
  report.failures.push(...assessSoak(report));
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : String(error));
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await browser.close();
  await new Promise((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
}

if (report.failures.length > 0) throw new Error(`三维长稳门禁失败：\n- ${report.failures.join("\n- ")}`);
console.log(`[viewer-soak] 通过：${report.completedSamples} 个样本，报告 ${reportPath}`);

async function collectSample(browserPage, cdp, index) {
  const before = await browserPage.evaluate(async (cycle) => {
    const state = await window.__viewerQaControl?.cycleScene(cycle);
    const memory = performance.memory;
    return {
      index: cycle,
      sampledAt: new Date().toISOString(),
      primitiveCount: state?.statistics?.primitiveCount ?? 0,
      triangleCount: state?.statistics?.triangleCount ?? 0,
      geometries: state?.performance?.renderer?.geometries ?? 0,
      textures: state?.performance?.renderer?.textures ?? 0,
      drawCalls: state?.performance?.renderer?.drawCalls ?? 0,
      p95FrameMs: state?.performance?.frameTimeMs?.p95,
      p99FrameMs: state?.performance?.frameTimeMs?.p99,
      pipelineWarmupStatus: state?.performance?.renderer?.pipelineWarmup?.status,
      pipelineWarmupRuns: state?.performance?.renderer?.pipelineWarmup?.completedRuns ?? 0,
      pipelineWarmupSkips: state?.performance?.renderer?.pipelineWarmup?.skippedRuns ?? 0,
      shadowUpdateMode: state?.performance?.renderer?.shadowUpdates?.mode,
      shadowUpdateRequests: state?.performance?.renderer?.shadowUpdates?.requestedUpdates ?? 0,
      rendererRecycled: state?.rendererLifecycle?.lastRecycledCycle === cycle,
      rendererRecycleCount: state?.rendererLifecycle?.recycleCount ?? 0,
      rendererRecycleDurationMs: state?.rendererLifecycle?.lastRecycledCycle === cycle
        ? state.rendererLifecycle.lastRecycleDurationMs
        : undefined,
      usedJsHeapBytes: memory?.usedJSHeapSize,
    };
  }, index);
  // CDP 的 HeapProfiler 会执行完整回收；页面级 gc() 在压力下可能只触发一次增量回收。
  await cdp.send("HeapProfiler.collectGarbage");
  await browserPage.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)));
  await cdp.send("HeapProfiler.collectGarbage");
  const postGc = await browserPage.evaluate(() => ({
    usedJsHeapBytes: performance.memory?.usedJSHeapSize,
    primitiveRetention: window.__viewerQaControl?.retainedPrimitiveObjects(),
    rendererCaches: window.__viewerQaControl?.rendererCacheDiagnostics()
  }));
  return {
    ...before,
    postGcUsedJsHeapBytes: postGc.usedJsHeapBytes,
    primitiveRetention: postGc.primitiveRetention,
    rendererCaches: postGc.rendererCaches,
    gcSupported: true
  };
}

function assessSoak(current) {
  const failures = [
    ...current.consoleErrors.map((value) => `console error: ${value}`),
    ...current.pageErrors.map((value) => `page error: ${value}`),
    ...current.requestFailures.map((value) => `request failed: ${value}`)
  ];
  if (current.completedSamples !== current.requiredSamples) failures.push(`采样不完整：${current.completedSamples}/${current.requiredSamples}`);
  if (current.samples.some((sample) => sample.primitiveCount !== current.sceneObjectCount)) {
    failures.push(`长稳期间对象数量偏离 ${current.sceneObjectCount}`);
  }
  const retained = current.samples.find((sample) => Number.isFinite(sample.primitiveRetention?.alive) && sample.primitiveRetention.alive > sample.primitiveCount + 12);
  if (retained) failures.push(`第 ${retained.index} 个样本仍存活 ${retained.primitiveRetention.alive}/${retained.primitiveCount} 个基础对象`);
  if (current.samples.some((sample) => sample.triangleCount <= 0)) failures.push("长稳期间出现无三角面场景");
  if (current.visualSamples.length < 3) failures.push(`画面健康采样不完整：${current.visualSamples.length}/3`);
  for (const visual of current.visualSamples) {
    if (isBlankRenderFrame(visual)) failures.push(`第 ${visual.index} 个长稳样本出现黑屏或近似纯色画面`);
  }
  const stable = current.samples.slice(Math.min(2, current.samples.length - 1));
  const first = median(stable.slice(0, Math.min(5, stable.length)).map(heapBytes));
  const last = median(stable.slice(-Math.min(5, stable.length)).map(heapBytes));
  const allowedHeapGrowth = Math.max(16 * 1024 * 1024, first * 0.35);
  if (Number.isFinite(first) && Number.isFinite(last) && last - first > allowedHeapGrowth) {
    failures.push(`强制 GC 后 JS 堆增长 ${formatMib(last - first)} MiB，超过 ${formatMib(allowedHeapGrowth)} MiB`);
  }
  const baseline = stable[0];
  const final = stable.at(-1);
  if (baseline && final && final.geometries > baseline.geometries + 2) failures.push(`几何资源从 ${baseline.geometries} 增长到 ${final.geometries}`);
  if (baseline && final && final.textures > baseline.textures + 2) failures.push(`纹理资源从 ${baseline.textures} 增长到 ${final.textures}`);
  if (stable.some((sample) => Number.isFinite(sample.p95FrameMs) && sample.p95FrameMs > 33.3)) failures.push("至少一个长稳样本 P95 帧时间超过 33.3ms");
  if (stable.some((sample) => sample.rendererRecycled && (!Number.isFinite(sample.rendererRecycleDurationMs) || sample.rendererRecycleDurationMs > 3_000))) {
    failures.push("WebGPU 自动资源回收未在 3 秒内恢复稳定画面");
  }
  if (stable.some((sample) => sample.pipelineWarmupStatus === "failed")) failures.push("长稳期间渲染管线预热失败");
  if ((stable.at(-1)?.pipelineWarmupRuns ?? 0) < 1) failures.push("长稳期间渲染管线未完成自动预热");
  const expectedShadowMode = current.rendererBackend === "webgl" ? "cached" : "backend-managed";
  if (stable.some((sample) => sample.shadowUpdateMode !== expectedShadowMode)) failures.push(`长稳 ${current.rendererBackend.toUpperCase()} 阴影模式未保持 ${expectedShadowMode}`);
  if (current.rendererBackend === "webgl" && (stable.at(-1)?.shadowUpdateRequests ?? 0) < 1) failures.push("长稳期间静态阴影缓存没有有效刷新");
  return failures;
}

function heapBytes(sample) {
  return sample.postGcUsedJsHeapBytes ?? sample.usedJsHeapBytes ?? Number.NaN;
}

function summarizeAllocationProfile(profile) {
  const frames = [];
  const visit = (node) => {
    if (node.selfSize > 0) {
      const frame = node.callFrame ?? {};
      frames.push({
        bytes: node.selfSize,
        functionName: frame.functionName || "(anonymous)",
        url: frame.url || "(unknown)",
        line: Number.isFinite(frame.lineNumber) ? frame.lineNumber + 1 : undefined
      });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(profile.head);
  return frames.sort((left, right) => right.bytes - left.bytes).slice(0, 30);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return Number.NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function finiteEnvironment(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} 必须在 ${minimum}–${maximum} 范围内`);
  return value;
}

function enumEnvironment(name, fallback, allowed) {
  const value = process.env[name] ?? fallback;
  if (!allowed.includes(value)) throw new Error(`${name} 必须是 ${allowed.join(" / ")}`);
  return value;
}

function formatMib(bytes) {
  return Number.isFinite(bytes) ? (bytes / 1024 / 1024).toFixed(1) : "无数据";
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value).toFixed(1) : "无数据";
}
