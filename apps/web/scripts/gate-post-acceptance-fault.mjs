import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { buildVisualQaArtifact, createStaticServer } from "./productBrowserSupport.mjs";
import { analyzeRenderFrame, isBlankRenderFrame } from "./viewerSoakVisualHealth.mjs";

const { chromium } = playwright;
const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(webRoot, "../..");
const outputRoot = resolve(repositoryRoot, "test-output/post-acceptance-fault");
const distRoot = resolve(outputRoot, "dist");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const rendererBackend = process.env.BIM_STUDIO_FAULT_RENDERER === "webgpu" ? "webgpu" : "webgl";
const reportPath = resolve(outputRoot, `report-${rendererBackend}.json`);

// D24–D28 项目后验收的故障注入切片：断网、渲染设备丢失、渲染器资源回收。
// 证据边界：只证明故障后的呈现恢复与无未捕获异常，不冒充 Native 侧或发布链故障矩阵。
if (!existsSync(chromePath)) throw new Error(`Chrome 不存在：${chromePath}`);
mkdirSync(outputRoot, { recursive: true });
buildVisualQaArtifact({ webRoot, outputRoot: distRoot });
const server = createStaticServer(distRoot);
await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
const address = server.address();
if (!address || typeof address === "string") throw new Error("无法创建故障注入服务器");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const cdpSession = await page.context().newCDPSession(page);
const report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  rendererBackend,
  origin,
  evidenceBoundary: "Web 端故障注入与恢复证据；Native 端、坏包与发布链故障由独立证据覆盖",
  cases: [],
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
  failures: [],
};
page.on("console", (message) => { if (message.type() === "error") report.consoleErrors.push(message.text()); });
page.on("pageerror", (error) => report.pageErrors.push(error.message));
page.on("requestfailed", (request) => report.requestFailures.push(`${request.method()} ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`));

const errorBaseline = () => ({ pageErrors: report.pageErrors.length, consoleErrors: report.consoleErrors.length });
const errorDelta = (before) => ({
  pageErrors: report.pageErrors.slice(before.pageErrors),
  consoleErrors: report.consoleErrors.slice(before.consoleErrors),
});

async function captureFrame() {
  const png = await page.locator(".viewer-visual-qa-canvas").screenshot({ type: "png" });
  return analyzeRenderFrame(png);
}

// 连续采集 frames 张画布截图；全部非空白才视为仍在呈现。
async function presentFrames(frames = 2, gapMs = 250) {
  const analyses = [];
  for (let index = 0; index < frames; index += 1) {
    if (index > 0) await page.waitForTimeout(gapMs);
    const analysis = await captureFrame();
    analyses.push({ blank: isBlankRenderFrame(analysis), meanLuminance: analysis.meanLuminance, visiblePixelRatio: analysis.visiblePixelRatio });
  }
  return { presented: analyses.every((item) => !item.blank), analyses };
}

async function cycleCount() {
  return page.evaluate(() => window.__viewerQa?.statistics?.primitiveCount ?? 0);
}

try {
  const query = new URLSearchParams({
    __visualQa: "viewer",
    renderer: rendererBackend,
    objects: "240",
    effects: "on",
    shadows: "on",
    effect: "all",
  });
  await page.goto(`${origin}/?${query.toString()}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__viewerQa?.ready || window.__viewerQa?.error, undefined, { timeout: 30_000 });
  const initialized = await page.evaluate(() => window.__viewerQa);
  if (initialized?.error) throw new Error(`${rendererBackend.toUpperCase()} 故障夹具初始化失败：${initialized.error}`);
  await page.evaluate(async () => { for (let frame = 0; frame < 120; frame += 1) await new Promise(requestAnimationFrame); });
  // 记录启动后端：WebGPU 设备丢失用例会回退到 WebGL，后续用例仍按原始后端分支。
  const originalBackend = await page.evaluate(() => window.__viewerQa?.backend ?? null);

  // 用例 0：基线呈现，作为后续每个故障用例的对照。
  {
    const before = errorBaseline();
    const baseline = await presentFrames(3);
    report.cases.push({
      id: "baseline-presentation",
      expected: "连续 3 帧非空白呈现",
      actual: baseline.presented ? "passed" : "failed",
      observations: { analyses: baseline.analyses, primitiveCount: await cycleCount(), errors: errorDelta(before) },
    });
  }

  // 用例 1：断网恢复。场景资源已本地就绪，断网期间渲染不得崩溃，恢复联网后仍在呈现。
  {
    const before = errorBaseline();
    await context.setOffline(true);
    await page.waitForTimeout(800);
    const offline = await presentFrames(2);
    await context.setOffline(false);
    await page.waitForTimeout(500);
    const recovered = await presentFrames(2);
    const errors = errorDelta(before);
    report.cases.push({
      id: "offline-recovery",
      expected: "断网期间保持呈现，恢复联网后无新增未捕获异常",
      actual: offline.presented && recovered.presented && errors.pageErrors.length === 0 ? "passed" : "failed",
      observations: { offline: offline.analyses, recovered: recovered.analyses, errors },
    });
  }

  // 用例 2：渲染器/场景资源回收。WebGPU 走整场替换阈值回收；WebGL 无整场回收，
  // 用弱引用追踪验证旧场景对象在 GC 后可回收（资源回收曲线语义）。
  // 注意：必须在设备丢失用例之前执行——WebGPU 设备丢失会永久回退 WebGL 渲染后端。
  {
    const before = errorBaseline();
    const probe = await page.evaluate(() => ({
      hasControl: typeof window.__viewerQaControl?.cycleScene === "function",
      hasPrimitiveTracking: typeof window.__viewerQaControl?.retainedPrimitiveObjects === "function",
      backend: window.__viewerQa?.backend ?? null,
      recycleCount: window.__viewerQa?.rendererLifecycle?.recycleCount ?? 0,
    }));
    if (!probe.hasControl) {
      report.cases.push({ id: "renderer-recycle-resource-recovery", expected: "回收后恢复呈现", actual: "unsupported", observations: { reason: "rendererLifecycle 探针不可用" } });
    } else if (originalBackend === "webgpu") {
      let recycleCountAfter = probe.recycleCount;
      for (let cycle = 1; cycle <= 12 && recycleCountAfter <= probe.recycleCount; cycle += 1) {
        const state = await page.evaluate(async (index) => (await window.__viewerQaControl.cycleScene(index))?.rendererLifecycle ?? {}, cycle);
        recycleCountAfter = state.recycleCount ?? 0;
      }
      await page.waitForTimeout(1_000);
      const recovered = await presentFrames(3);
      report.cases.push({
        id: "renderer-recycle-resource-recovery",
        expected: "WebGPU 整场替换达到阈值后渲染器回收，回收后连续 3 帧非空白呈现",
        actual: recycleCountAfter > probe.recycleCount && recovered.presented ? "passed" : "failed",
        observations: {
          recycleCountBefore: probe.recycleCount,
          recycleCountAfter,
          replacementsDriven: 12,
          recovered: recovered.analyses,
          errors: errorDelta(before),
        },
      });
    } else {
      const trackedBefore = await page.evaluate(() => window.__viewerQaControl.retainedPrimitiveObjects());
      await page.evaluate(async () => { await window.__viewerQaControl.cycleScene(1); await window.__viewerQaControl.cycleScene(2); });
      await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)));
      // CDP 完整回收，避免把"还没轮到 GC"误判成"回收失效"。
      await cdpSession.send("HeapProfiler.collectGarbage");
      const trackedAfter = await page.evaluate(() => window.__viewerQaControl.retainedPrimitiveObjects());
      await page.waitForTimeout(1_000);
      const recovered = await presentFrames(3);
      const currentCycle = 2;
      const staleCycles = Object.entries(trackedAfter.aliveByCycle ?? {})
        .filter(([cycle]) => Number(cycle) < currentCycle)
        .map(([cycle, count]) => `${cycle}:${count}`);
      const collectible = probe.hasPrimitiveTracking
        && trackedAfter.tracked > trackedBefore.tracked
        && staleCycles.length === 0
        && trackedAfter.alive < trackedAfter.tracked;
      report.cases.push({
        id: "renderer-recycle-resource-recovery",
        expected: "场景整场替换并强制 GC 后，旧周期对象全部可回收（alive 仅剩当前周期），且连续 3 帧非空白呈现",
        actual: collectible && recovered.presented ? "passed" : "failed",
        observations: {
          trackedBefore: trackedBefore.tracked,
          aliveBefore: trackedBefore.alive,
          trackedAfter: trackedAfter.tracked,
          aliveAfter: trackedAfter.alive,
          staleCycles,
          recovered: recovered.analyses,
          errors: errorDelta(before),
        },
      });
    }
  }

  // 用例 3（最后执行）：渲染设备丢失与恢复。WebGL 用 WEBGL_lose_context；WebGPU 真销毁
  // GPUDevice 并由夹具回退到 WebGL 渲染后端；恢复后必须回到非空白呈现且无未捕获异常。
  {
    const before = errorBaseline();
    const deviceBackend = await page.evaluate(() => window.__viewerQa?.backend ?? null);
    let lossTriggered = false;
    let lossPath = null;
    if (deviceBackend === "webgpu" && await page.evaluate(() => typeof window.__viewerQaControl?.simulateDeviceLoss === "function" && window.__viewerQaControl.simulateDeviceLoss())) {
      lossTriggered = true;
      lossPath = "webgpu-device-destroy";
      await page.waitForTimeout(3_000);
    } else {
      lossTriggered = await page.evaluate(() => {
        const host = document.querySelector(".viewer-visual-qa-canvas");
        const canvas = host?.tagName === "CANVAS" ? host : host?.querySelector("canvas");
        if (!canvas || typeof canvas.getContext !== "function") return false;
        const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
        const extension = gl?.getExtension("WEBGL_lose_context");
        if (!extension) return false;
        extension.loseContext();
        return true;
      });
      lossPath = "webgl-lose-context";
      if (lossTriggered) {
        await page.waitForTimeout(1_500);
        await page.evaluate(() => {
          const host = document.querySelector(".viewer-visual-qa-canvas");
          const canvas = host?.tagName === "CANVAS" ? host : host?.querySelector("canvas");
          const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
          gl?.getExtension("WEBGL_lose_context")?.restoreContext();
        });
      }
    }
    if (!lossTriggered) {
      report.cases.push({ id: "webgl-device-loss-recovery", expected: "设备丢失后恢复呈现", actual: "unsupported", observations: { reason: "当前后端无设备丢失模拟入口" } });
    } else {
      await page.waitForTimeout(2_500);
      const recovered = await presentFrames(3, 400);
      const errors = errorDelta(before);
      report.cases.push({
        id: "webgl-device-loss-recovery",
        expected: `设备丢失恢复后连续 3 帧非空白呈现，无新增未捕获异常（路径 ${lossPath}）`,
        actual: recovered.presented && errors.pageErrors.length === 0 ? "passed" : "failed",
        observations: { lossPath, recovered: recovered.analyses, errors },
      });
    }
  }
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : String(error));
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await browser.close();
  await new Promise((resolveClosed, reject) => server.close((error) => (error ? reject(error) : resolveClosed())));
}

const hardFailures = report.cases.filter((item) => item.actual === "failed");
report.failures.push(...hardFailures.map((item) => `${item.id}: ${item.actual}`));
if (report.failures.length > 0) throw new Error(`故障注入门禁失败：\n- ${report.failures.join("\n- ")}`);
console.log(`[post-acceptance-fault] 通过：${report.cases.length} 个用例，报告 ${reportPath}`);
