import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { buildVisualQaArtifact, createStaticServer } from "./productBrowserSupport.mjs";
import { compareImageFiles } from "./renderImageSimilarity.mjs";
import { classifyRendererInitialization } from "./rendererGateClassification.mjs";
import { assessProductVisualQuality, FIXED_VIEWER_VISUAL_REGIONS } from "./productVisualQualityPolicy.mjs";

const { chromium } = playwright;
const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(webRoot, "../..");
const outputRoot = resolve(repositoryRoot, "test-output/product-browser");
const distRoot = resolve(outputRoot, "dist");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const requireWebGpu = process.argv.includes("--require-webgpu") || process.env.BIM_STUDIO_REQUIRE_WEBGPU === "true";
const viewerEffectsEnabled = !process.argv.includes("--viewer-effects-off");
const viewerShadowsEnabled = !process.argv.includes("--viewer-shadows-off");
// 25 次覆盖两个 12 次回收周期；避免只观察到回收后的半个锯齿周期而误判资源增长。
const sceneSwitchCycles = 25;
const viewportCases = [
  { id: "desktop-1440", width: 1440, height: 900 },
  { id: "laptop-1366", width: 1366, height: 768 },
  { id: "compact-1024", width: 1024, height: 768 }
];

if (!existsSync(chromePath)) throw new Error(`Chrome 不存在：${chromePath}`);
mkdirSync(outputRoot, { recursive: true });
buildVisualQaArtifact({ webRoot, outputRoot: distRoot });

const server = createStaticServer(distRoot);
await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
const address = server.address();
if (!address || typeof address === "string") throw new Error("无法创建浏览器验收服务器");
const origin = `http://127.0.0.1:${address.port}`;
// 暴露 GC 只用于验收采样，帮助区分“尚未回收”与“真实保留”；不影响产品运行时。
const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu", "--js-flags=--expose-gc"] });
const report = { createdAt: new Date().toISOString(), chromePath, requireWebGpu, viewerEffectsEnabled, viewerShadowsEnabled, cases: [], workflowCases: [], viewerCases: [], warnings: [], visualFailures: [] };

try {
  for (const viewport of viewportCases) report.cases.push(await inspectViewport(browser, origin, viewport));
  report.workflowCases.push(await inspectCommissioning(browser, origin, { id: "commissioning-1440", width: 1440, height: 900 }));
  report.workflowCases.push(await inspectCommissioning(browser, origin, { id: "commissioning-1024", width: 1024, height: 768 }));
  report.viewerCases.push(await inspectViewer(browser, origin, { id: "viewer-webgl-1440", width: 1440, height: 900, backend: "webgl", required: true }));
  report.viewerCases.push(await inspectViewer(browser, origin, { id: "viewer-webgpu-1440", width: 1440, height: 900, backend: "webgpu", required: requireWebGpu }));
  const comparableViewerCases = report.viewerCases.filter((item) => !item.environmentBlocked && item.failures.length === 0);
  if (comparableViewerCases.length === 2) {
    report.viewerVisualComparison = await compareImageFiles(
      resolve(outputRoot, "viewer-webgl-1440-canvas.png"),
      resolve(outputRoot, "viewer-webgpu-1440-canvas.png"),
      "product-webgl",
      "product-webgpu",
      {
        differencePath: resolve(outputRoot, "viewer-webgl-vs-webgpu-diff.png"),
        regions: FIXED_VIEWER_VISUAL_REGIONS,
      }
    );
    const visualAssessment = assessProductVisualQuality(report.viewerVisualComparison);
    report.visualFailures.push(...visualAssessment.failures);
    report.warnings.push(...visualAssessment.warnings);
  }
  report.warnings.push(...buildRendererWarnings(report.viewerCases));
  writeFileSync(resolve(outputRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const failures = [
    ...report.visualFailures,
    ...[...report.cases, ...report.workflowCases, ...report.viewerCases].flatMap((item) => item.failures.map((failure) => `${item.id}: ${failure}`))
  ];
  if (failures.length > 0) throw new Error(`产品浏览器门禁失败：\n- ${failures.join("\n- ")}`);
  const webGpu = report.viewerCases.find((item) => item.backend === "webgpu");
  for (const warning of report.warnings) console.warn(`[product-browser] 警告：${warning}`);
  console.log(`[product-browser] 通过：${report.cases.length} 个二维视口 + WebGL 三维；WebGPU ${webGpu?.environmentBlocked ? "环境阻断" : "已验证"}；报告 ${resolve(outputRoot, "report.json")}`);
} finally {
  await browser.close();
  await new Promise((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
}

async function inspectCommissioning(browserInstance, origin, viewport) {
  const page = await browserInstance.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/?__visualQa=commissioning`, { waitUntil: "networkidle" });
  await page.locator(".commissioning-workbench").waitFor({ state: "visible" });
  await page.screenshot({ path: resolve(outputRoot, `${viewport.id}.png`), fullPage: true });
  const metrics = await page.evaluate(() => {
    const root = document.querySelector(".commissioning-visual-qa");
    const selectors = [".commissioning-titlebar", ".workcell-audit-panel", ".commissioning-layout"];
    const elements = root ? [...root.querySelectorAll("button,input,select,small,span,strong,code")] : [];
    const visible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    return {
      horizontalOverflow: Boolean(root && root.scrollWidth > root.clientWidth + 1),
      hiddenPrimaryRegions: selectors.filter((selector) => {
        const element = document.querySelector(selector);
        if (!element) return true;
        const bounds = element.getBoundingClientRect();
        return bounds.width < 1 || bounds.height < 1;
      }),
      smallUiText: elements.filter((element) => visible(element) && element.textContent?.trim() && Number.parseFloat(getComputedStyle(element).fontSize) < 9.5)
        .slice(0, 8).map((element) => `${element.tagName.toLowerCase()}=${getComputedStyle(element).fontSize}[${element.textContent?.trim().slice(0, 18)}]`),
      smallUiTargets: elements.filter((element) => {
        if (!visible(element) || !["BUTTON", "INPUT", "SELECT"].includes(element.tagName)) return false;
        if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) return false;
        const bounds = element.getBoundingClientRect();
        return bounds.width < 24 || bounds.height < 24;
      }).slice(0, 8).map((element) => element.tagName.toLowerCase()),
    };
  });
  const failures = [
    ...consoleErrors.map((value) => `console error: ${value}`),
    ...pageErrors.map((value) => `page error: ${value}`),
    ...(metrics.horizontalOverflow ? ["虚拟验收页产生横向溢出"] : []),
    ...(metrics.hiddenPrimaryRegions.length ? [`关键区域不可见：${metrics.hiddenPrimaryRegions.join(", ")}`] : []),
    ...(metrics.smallUiText.length ? [`存在小于 9.5px 的界面文字：${metrics.smallUiText.join(", ")}`] : []),
    ...(metrics.smallUiTargets.length ? [`存在小于 24px 的点击目标：${metrics.smallUiTargets.join(", ")}`] : []),
  ];
  await page.close();
  return { ...viewport, metrics, consoleErrors, pageErrors, failures };
}

function buildRendererWarnings(viewerCases) {
  const webGl = viewerCases.find((item) => item.backend === "webgl" && !item.environmentBlocked);
  const webGpu = viewerCases.find((item) => item.backend === "webgpu" && !item.environmentBlocked);
  if (!webGl?.state?.performance || !webGpu?.state?.performance) return [];

  const warnings = [];
  const webGlFrames = webGl.state.performance.frameTimeMs;
  const webGpuFrames = webGpu.state.performance.frameTimeMs;
  const webGlDrawCalls = webGl.state.performance.renderer?.drawCalls ?? 0;
  const webGpuDrawCalls = webGpu.state.performance.renderer?.drawCalls ?? 0;
  if ((webGpuFrames?.p99 ?? 0) > Math.max(33.3, (webGlFrames?.p99 ?? 0) * 2)) {
    warnings.push(`WebGPU P99 ${formatMetric(webGpuFrames?.p99)}ms 明显劣于 WebGL ${formatMetric(webGlFrames?.p99)}ms，保持实验后端`);
  }
  if ((webGpuFrames?.maximum ?? 0) > Math.max(50, (webGlFrames?.maximum ?? 0) * 2)) {
    warnings.push(`WebGPU 最大帧时间 ${formatMetric(webGpuFrames?.maximum)}ms 明显劣于 WebGL ${formatMetric(webGlFrames?.maximum)}ms`);
  }
  if (webGlDrawCalls > 0 && webGpuDrawCalls > webGlDrawCalls * 1.5) {
    warnings.push(`WebGPU Draw Call ${webGpuDrawCalls} 高于 WebGL ${webGlDrawCalls}，需先统一统计口径并优化管线`);
  }
  const webGpuHeap = readHeapTrend(webGpu.sceneSwitchSamples);
  if (webGpuHeap && webGpuHeap.deltaBytes > Math.max(5 * 1024 * 1024, webGpuHeap.firstBytes * 0.25)) {
    warnings.push(`WebGPU 20 次场景切换后 JS 堆增加 ${formatMebibytes(webGpuHeap.deltaBytes)} MiB，需用长稳采样和强制 GC 复核`);
  }
  return warnings;
}

function readHeapTrend(samples) {
  const firstBytes = samples?.[0]?.postGcUsedJsHeapBytes ?? samples?.[0]?.usedJsHeapBytes;
  const lastBytes = samples?.at(-1)?.postGcUsedJsHeapBytes ?? samples?.at(-1)?.usedJsHeapBytes;
  if (!Number.isFinite(firstBytes) || !Number.isFinite(lastBytes)) return undefined;
  return { firstBytes, lastBytes, deltaBytes: lastBytes - firstBytes };
}

function formatMebibytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function formatMetric(value) {
  return Number.isFinite(value) ? Number(value).toFixed(1) : "无数据";
}

async function inspectViewer(browserInstance, origin, testCase) {
  const page = await browserInstance.newPage({ viewport: { width: testCase.width, height: testCase.height }, deviceScaleFactor: 1 });
  const cdpSession = await page.context().newCDPSession(page);
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => requestFailures.push(`${request.method()} ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`));
  await page.goto(`${origin}/?__visualQa=viewer&renderer=${testCase.backend}&effects=${viewerEffectsEnabled ? "on" : "off"}&shadows=${viewerShadowsEnabled ? "on" : "off"}`, { waitUntil: "networkidle" });
  const environment = await page.evaluate(async () => {
    const gpu = navigator.gpu;
    let adapterAvailable = false;
    if (gpu && window.isSecureContext) {
      try { adapterAvailable = Boolean(await gpu.requestAdapter({ powerPreference: "high-performance" })); }
      catch { adapterAvailable = false; }
    }
    return { secureContext: window.isSecureContext, webGpuApi: Boolean(gpu), webGpuAdapter: adapterAvailable };
  });
  await page.waitForFunction(() => window.__viewerQa?.ready || window.__viewerQa?.error, undefined, { timeout: 30_000 });
  const initialState = await page.evaluate(() => window.__viewerQa);
  if (initialState?.error) {
    await page.screenshot({ path: resolve(outputRoot, `${testCase.id}-blocked.png`), fullPage: true });
    const classification = classifyRendererInitialization(testCase, environment, initialState.error);
    const failures = [
      ...consoleErrors.map((value) => `console error: ${value}`),
      ...pageErrors.map((value) => `page error: ${value}`),
      ...requestFailures.map((value) => `request failed: ${value}`),
      ...classification.failures
    ];
    await page.close();
    return { ...testCase, state: initialState, environment, environmentBlocked: classification.environmentBlocked, consoleErrors, pageErrors, requestFailures, failures };
  }
  await page.evaluate(async () => { for (let index = 0; index < 180; index += 1) await new Promise(requestAnimationFrame); });
  await page.locator(".viewer-visual-qa-canvas").screenshot({ path: resolve(outputRoot, `${testCase.id}-initial-canvas.png`) });

  const sceneSwitchSamples = [];
  for (let cycle = 1; cycle <= sceneSwitchCycles; cycle += 1) {
    const before = await page.evaluate(async (sceneCycle) => {
      const state = await window.__viewerQaControl?.cycleScene(sceneCycle);
      const memory = performance.memory;
      return {
        cycle: sceneCycle,
        primitiveCount: state?.statistics?.primitiveCount ?? 0,
        geometries: state?.performance?.renderer?.geometries ?? 0,
        textures: state?.performance?.renderer?.textures ?? 0,
        rendererLifecycle: state?.rendererLifecycle,
        usedJsHeapBytes: memory?.usedJSHeapSize,
      };
    }, cycle);
    await cdpSession.send("HeapProfiler.collectGarbage");
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)));
    await cdpSession.send("HeapProfiler.collectGarbage");
    const postGc = await page.evaluate(() => ({
      usedJsHeapBytes: performance.memory?.usedJSHeapSize,
      primitiveRetention: window.__viewerQaControl?.retainedPrimitiveObjects()
    }));
    sceneSwitchSamples.push({ ...before, postGcUsedJsHeapBytes: postGc.usedJsHeapBytes, primitiveRetention: postGc.primitiveRetention, gcSupported: true });
    if (cycle === 1 || cycle === sceneSwitchCycles) {
      await page.locator(".viewer-visual-qa-canvas").screenshot({ path: resolve(outputRoot, `${testCase.id}-cycle-${cycle}-canvas.png`) });
    }
  }

  // 资源切换阶段包含测试主动触发的 GC；稳定帧预算必须单独采样，避免把测试工具开销归因于渲染器。
  await page.evaluate(async () => {
    window.__viewerQaControl?.resetPerformanceSamples();
    for (let index = 0; index < 180; index += 1) await new Promise(requestAnimationFrame);
  });

  const canvas = page.locator(".viewer-visual-qa-canvas canvas");
  const visualSurface = page.locator(".viewer-visual-qa-canvas");
  await canvas.waitFor({ state: "visible" });
  const beforeResize = await canvas.boundingBox();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.evaluate(async () => { for (let index = 0; index < 30; index += 1) await new Promise(requestAnimationFrame); });
  const compactCanvas = await canvas.boundingBox();
  await visualSurface.screenshot({ path: resolve(outputRoot, `${testCase.id}-compact-canvas.png`) });
  await page.setViewportSize({ width: testCase.width, height: testCase.height });
  await page.waitForFunction(({ width, height }) => window.__viewerQa?.performance?.renderer?.viewportPixels === width * height, { width: testCase.width, height: testCase.height }, { timeout: 5_000 });
  // WebGPU 恢复尺寸时会重配交换链；DOM 像素已更新不代表新画面已经提交。
  await page.evaluate(async () => { for (let index = 0; index < 30; index += 1) await new Promise(requestAnimationFrame); });
  const restoredCanvas = await canvas.boundingBox();
  await page.screenshot({ path: resolve(outputRoot, `${testCase.id}.png`), fullPage: true });
  // 截取承载层而非裸 canvas，把 Three Sprite 标签等产品视觉也纳入双后端比较。
  await visualSurface.screenshot({ path: resolve(outputRoot, `${testCase.id}-canvas.png`) });
  const state = await page.evaluate(() => window.__viewerQa);
  let deviceLossRecovery;
  const deviceLossFailures = [];
  if (testCase.backend === "webgpu") {
    const triggered = await page.evaluate(() => window.__viewerQaControl?.simulateDeviceLoss() ?? false);
    if (!triggered) {
      deviceLossFailures.push("无法触发真实 GPUDevice 丢失");
    } else {
      try {
        await page.waitForFunction(
          () => window.__viewerQa?.deviceLossRecovery?.recoveredBackend === "webgl",
          undefined,
          { timeout: 30_000 }
        );
        const recoveredState = await page.evaluate(() => window.__viewerQa);
        deviceLossRecovery = recoveredState?.deviceLossRecovery;
        await page.screenshot({ path: resolve(outputRoot, `${testCase.id}-device-recovered.png`), fullPage: true });
        if (deviceLossRecovery?.primitiveCount !== 120) {
          deviceLossFailures.push(`设备丢失恢复后对象数量异常：${deviceLossRecovery?.primitiveCount ?? 0}/120`);
        }
      } catch (reason) {
        deviceLossFailures.push(`设备丢失后未在 30 秒内恢复 WebGL：${reason instanceof Error ? reason.message : String(reason)}`);
      }
    }
  }
  const resourceRegression = findResourceRegression(sceneSwitchSamples);
  const webGpuLifecycleFailure = testCase.backend === "webgpu" ? findWebGpuLifecycleFailure(sceneSwitchSamples) : undefined;
  const failures = [
    ...consoleErrors.map((value) => `console error: ${value}`),
    ...pageErrors.map((value) => `page error: ${value}`),
    ...requestFailures.map((value) => `request failed: ${value}`),
    ...(state?.error ? [`渲染器初始化失败：${state.error}`] : []),
    ...(state?.statistics?.primitiveCount !== 120 ? [`对象数量异常：${state?.statistics?.primitiveCount ?? 0}/120`] : []),
    ...(sceneSwitchSamples.some((sample) => sample.primitiveCount !== 120) ? [`${sceneSwitchCycles} 次场景切换后对象数量不稳定`] : []),
    ...retainedObjectFailures(sceneSwitchSamples),
    ...deviceLossFailures,
    ...(resourceRegression ? [resourceRegression] : []),
    ...(webGpuLifecycleFailure ? [webGpuLifecycleFailure] : []),
    ...(state?.performance?.renderer?.pipelineWarmup?.status === "failed" ? [`渲染管线预热失败：${state.performance.renderer.pipelineWarmup.lastError ?? "未知错误"}`] : []),
    ...((state?.performance?.renderer?.pipelineWarmup?.completedRuns ?? 0) < 1 ? ["渲染管线未完成自动预热"] : []),
    ...(testCase.backend === "webgl" && state?.performance?.renderer?.shadowUpdates?.mode !== "cached" ? [`WebGL 静态阴影未进入缓存模式：${state?.performance?.renderer?.shadowUpdates?.mode ?? "无状态"}`] : []),
    ...(testCase.backend === "webgl" && (state?.performance?.renderer?.shadowUpdates?.requestedUpdates ?? 0) < 1 ? ["WebGL 静态阴影缓存没有记录有效刷新"] : []),
    ...(testCase.backend === "webgpu" && state?.performance?.renderer?.shadowUpdates?.mode !== "backend-managed" ? [`WebGPU 阴影状态错误：${state?.performance?.renderer?.shadowUpdates?.mode ?? "无状态"}`] : []),
    ...((state?.statistics?.triangleCount ?? 0) <= 0 ? ["场景没有可统计三角面"] : []),
    ...((state?.performance?.renderer?.sharedPrimitiveGeometries ?? Number.POSITIVE_INFINITY) > 6 ? [`基础体几何缓存异常：${state?.performance?.renderer?.sharedPrimitiveGeometries ?? "无数据"} 个唯一基础几何`] : []),
    ...((state?.performance?.frameTimeMs?.p95 ?? Number.POSITIVE_INFINITY) > 33.3 ? [`P95 帧时间 ${state?.performance?.frameTimeMs?.p95 ?? "无数据"}ms 超过 33.3ms`] : []),
    ...(!canvasFits(beforeResize, testCase.width, testCase.height) ? ["初始 Canvas 未覆盖视口"] : []),
    ...(!canvasFits(compactCanvas, 1024, 768) ? ["紧凑视口调整后 Canvas 尺寸错误"] : []),
    ...(!canvasFits(restoredCanvas, testCase.width, testCase.height) ? ["恢复视口后 Canvas 尺寸错误"] : [])
  ];
  await page.close();
  return { ...testCase, state, environment, deviceLossRecovery, sceneSwitchSamples, canvas: { beforeResize, compact: compactCanvas, restored: restoredCanvas }, consoleErrors, pageErrors, requestFailures, failures };
}

function findResourceRegression(samples) {
  if (samples.length < 2) return "场景切换资源样本不足";
  const baseline = samples[0];
  const final = samples.at(-1);
  if (final.geometries > baseline.geometries + 2) return `${sceneSwitchCycles} 次切换并跨过两个回收周期后，几何资源从 ${baseline.geometries} 增长到 ${final.geometries}`;
  if (final.textures > baseline.textures + 2) return `${sceneSwitchCycles} 次切换并跨过两个回收周期后，纹理资源从 ${baseline.textures} 增长到 ${final.textures}`;
  return undefined;
}

function findWebGpuLifecycleFailure(samples) {
  const finalLifecycle = samples.at(-1)?.rendererLifecycle;
  if ((finalLifecycle?.recycleCount ?? 0) < 2) return `未在 ${sceneSwitchCycles} 次切换中完成两次 WebGPU 资源回收`;
  if ((finalLifecycle?.lastRecycledCycle ?? 0) < 24) return `第二次 WebGPU 资源回收时机异常：${finalLifecycle?.lastRecycledCycle ?? 0}`;
  return undefined;
}

function retainedObjectFailures(samples) {
  const leaked = samples.find((sample) => {
    const alive = sample.primitiveRetention?.alive;
    return Number.isFinite(alive) && alive > sample.primitiveCount + Math.max(12, sample.primitiveCount * 0.1);
  });
  if (!leaked) return [];
  return [`第 ${leaked.cycle} 次切换后仍存活 ${leaked.primitiveRetention.alive}/${leaked.primitiveCount} 个基础对象，存在旧场景强引用`];
}

function canvasFits(bounds, width, height) {
  return Boolean(bounds && Math.abs(bounds.width - width) <= 1 && Math.abs(bounds.height - height) <= 1);
}

async function inspectViewport(browserInstance, origin, viewport) {
  const page = await browserInstance.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => requestFailures.push(`${request.method()} ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`));
  await page.addInitScript(() => {
    window.__productQa = { longTasks: [], layoutShifts: [] };
    new PerformanceObserver((list) => window.__productQa.longTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((list) => window.__productQa.layoutShifts.push(...list.getEntries().filter((entry) => !entry.hadRecentInput).map((entry) => entry.value))).observe({ type: "layout-shift", buffered: true });
  });

  await page.goto(`${origin}/?__visualQa=dashboard`, { waitUntil: "networkidle" });
  await page.locator(".dashboard-workspace").waitFor({ state: "visible" });
  await page.screenshot({ path: resolve(outputRoot, `${viewport.id}-editor.png`), fullPage: true });
  const editorMetrics = await collectMetrics(page, [".dashboard-workspace-topbar", ".dashboard-pages-panel", ".dashboard-design-surface"]);
  const editorFocus = await page.locator(".dashboard-artboard").evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    const viewport = element.closest(".dashboard-canvas-scroll")?.getBoundingClientRect();
    const visibleNodes = [...element.querySelectorAll(":scope > .dashboard-node")].filter((node) => {
      const bounds = node.getBoundingClientRect();
      return viewport && bounds.right > viewport.left && bounds.left < viewport.right && bounds.bottom > viewport.top && bounds.top < viewport.bottom;
    });
    return { zoom: matrix.a, visibleNodeCount: visibleNodes.length };
  });

  await page.getByRole("button", { name: "浏览" }).click();
  await page.locator(".dashboard-runtime-preview").waitFor({ state: "visible" });
  await page.screenshot({ path: resolve(outputRoot, `${viewport.id}-runtime.png`), fullPage: true });
  const runtimeMetrics = await collectMetrics(page, [".dashboard-runtime-preview", ".dashboard-runtime-surface", ".dashboard-runtime-controller-trigger"]);
  const navigation = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0];
    return entry ? { domContentLoadedMs: entry.domContentLoadedEventEnd, loadMs: entry.loadEventEnd, transferBytes: entry.transferSize } : undefined;
  });
  const observed = await page.evaluate(() => ({
    longTaskCount: window.__productQa.longTasks.length,
    maxLongTaskMs: Math.max(0, ...window.__productQa.longTasks),
    cumulativeLayoutShift: window.__productQa.layoutShifts.reduce((sum, value) => sum + value, 0)
  }));
  const failures = [
    ...consoleErrors.map((value) => `console error: ${value}`),
    ...pageErrors.map((value) => `page error: ${value}`),
    ...requestFailures.map((value) => `request failed: ${value}`),
    ...(editorMetrics.documentOverflow ? ["编辑态产生页面级横向或纵向溢出"] : []),
    ...(runtimeMetrics.documentOverflow ? ["运行态产生页面级横向或纵向溢出"] : []),
    ...(editorMetrics.hiddenPrimaryRegions.length ? [`编辑态关键区域不可见：${editorMetrics.hiddenPrimaryRegions.join(", ")}`] : []),
    ...(runtimeMetrics.hiddenPrimaryRegions.length ? [`运行态关键区域不可见：${runtimeMetrics.hiddenPrimaryRegions.join(", ")}`] : []),
    ...(editorMetrics.smallUiText.length ? [`编辑态存在小于 9.5px 的界面文字：${editorMetrics.smallUiText.join(", ")}`] : []),
    ...(editorMetrics.smallUiTargets.length ? [`编辑态存在小于 24px 的可点击目标：${editorMetrics.smallUiTargets.join(", ")}`] : []),
    ...(editorFocus.zoom < 0.5 ? [`超宽页面默认聚焦过小：${editorFocus.zoom.toFixed(3)}，应优先聚焦业务内容`] : []),
    ...(editorFocus.visibleNodeCount < 3 ? [`默认聚焦仅显示 ${editorFocus.visibleNodeCount} 个业务组件`] : []),
    ...(editorMetrics.p95FrameMs > 33.3 ? [`编辑态 P95 帧时间 ${editorMetrics.p95FrameMs.toFixed(1)}ms 超过 33.3ms`] : []),
    ...(runtimeMetrics.p95FrameMs > 33.3 ? [`运行态 P95 帧时间 ${runtimeMetrics.p95FrameMs.toFixed(1)}ms 超过 33.3ms`] : []),
    ...(observed.maxLongTaskMs > 200 ? [`最大 Long Task ${observed.maxLongTaskMs.toFixed(1)}ms 超过 200ms`] : []),
    ...(observed.cumulativeLayoutShift > 0.1 ? [`CLS ${observed.cumulativeLayoutShift.toFixed(3)} 超过 0.1`] : [])
  ];
  await page.close();
  return { ...viewport, editorMetrics, editorFocus, runtimeMetrics, navigation, observed, consoleErrors, pageErrors, requestFailures, failures };
}

async function collectMetrics(page, primarySelectors) {
  return page.evaluate(async (selectors) => {
    const frameTimes = [];
    let previous = performance.now();
    for (let index = 0; index < 120; index += 1) {
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      frameTimes.push(now - previous);
      previous = now;
    }
    const sorted = [...frameTimes].sort((left, right) => left - right);
    const percentile = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
    const hiddenPrimaryRegions = selectors.filter((selector) => {
      const element = document.querySelector(selector);
      if (!element) return true;
      const bounds = element.getBoundingClientRect();
      return bounds.width < 1 || bounds.height < 1 || bounds.right < 0 || bounds.left > innerWidth;
    });
    const surface = document.querySelector(".dashboard-workspace, .dashboard-runtime-preview");
    const uiElements = surface ? [...surface.querySelectorAll("button,input,select,summary,label,small,span,strong")] : [];
    const isVisibleUi = (element) => {
      if (element.closest(".dashboard-artboard") || element.closest(".dashboard-ruler") || element.closest("[hidden]")) return false;
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const smallUiText = uiElements.filter((element) => isVisibleUi(element) && element.textContent?.trim() && Number.parseFloat(getComputedStyle(element).fontSize) < 9.5)
      .slice(0, 8).map((element) => `${element.tagName.toLowerCase()}.${String(element.className || "").split(" ")[0]}=${getComputedStyle(element).fontSize}[${element.textContent?.trim().slice(0, 18)}]`);
    const smallUiTargets = uiElements.filter((element) => {
      if (!isVisibleUi(element) || !["BUTTON", "INPUT", "SELECT", "SUMMARY"].includes(element.tagName)) return false;
      if (element instanceof HTMLInputElement && ["checkbox", "radio", "color", "range"].includes(element.type)) return false;
      const bounds = element.getBoundingClientRect();
      return bounds.width < 24 || bounds.height < 24;
    }).slice(0, 8).map((element) => `${element.tagName.toLowerCase()}.${String(element.className || "").split(" ")[0]}`);
    return {
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1,
      hiddenPrimaryRegions,
      smallUiText,
      smallUiTargets,
      p50FrameMs: percentile(0.5),
      p95FrameMs: percentile(0.95),
      maxFrameMs: Math.max(...frameTimes)
    };
  }, primarySelectors);
}
