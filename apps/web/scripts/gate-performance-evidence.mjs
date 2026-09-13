import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { buildVisualQaArtifact, createStaticServer } from "./productBrowserSupport.mjs";
import { compareImageFiles } from "./renderImageSimilarity.mjs";

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const parent = resolve(webRoot, "../../test-output/perf-evidence-2026-09-12");
mkdirSync(parent, { recursive: true });
const output = mkdtempSync(resolve(parent, "run-"));
const dist = resolve(output, "dist");
buildVisualQaArtifact({ webRoot, outputRoot: dist });
const server = createStaticServer(dist);
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu"] });
const report = {
  createdAt: new Date().toISOString(),
  boundary: "Production QA build, no API/backend; headless Chrome 1440x900 DPR1; virtualization uses synthetic tree data, viewer cases use deterministic primitives; CPU numbers are recorded observations, not asserted SLAs",
  cases: {},
};

async function openViewer(query, { expectOffscreen = false, renderer = "webgl" } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${origin}/?__visualQa=viewer&renderer=${renderer}&effects=on&shadows=on${query}`, { waitUntil: "commit" });
  await page.waitForFunction(() => window.__viewerQa?.ready || window.__viewerQa?.error, undefined, { timeout: 60000 });
  const initial = await page.evaluate(() => window.__viewerQa);
  assert.equal(initial.error, undefined, `viewer QA 启动失败: ${initial.error}`);
  if (expectOffscreen) {
    await page.waitForFunction(() => ["active", "fallback"].includes(window.__viewerQa?.offscreen?.mode), undefined, { timeout: 30000 });
  }
  return { page, errors };
}

const readState = page => page.evaluate(() => window.__viewerQa);
const settle = page => page.waitForTimeout(3500);

try {
  // ─── 组 1:大对象树虚拟化(真实组件 + 真实浏览器 + 合成目录数据) ───
  {
    const entry = report.cases.treeVirtualization = {};
    const readTreeMetrics = async page => JSON.parse(await page.locator('output[aria-label="目录性能指标"] pre').textContent());
    // 窗口化:10000 行只挂载可见窗口
    const win = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await win.goto(`${origin}/?__visualQa=object-tree&count=10000&mode=objects&windowed=1`, { waitUntil: "domcontentloaded" });
    await win.waitForFunction(() => document.querySelector('output[aria-label="目录性能指标"] pre')?.textContent?.includes("10000"), undefined, { timeout: 30000 });
    await win.waitForTimeout(800);
    entry.windowed10000 = await readTreeMetrics(win);
    await win.screenshot({ path: resolve(output, "tree-windowed-10000.png") });
    assert.ok(entry.windowed10000.renderedRows <= 60, `窗口化后仍挂载 ${entry.windowed10000.renderedRows} 行`);
    // End 行可达且挂载仍受限(reveal 校正)
    await win.getByRole("button", { name: "选中末行" }).click();
    await win.waitForTimeout(900);
    entry.windowedAfterReveal = await readTreeMetrics(win);
    assert.equal(entry.windowedAfterReveal.selected, "device-9999", "末行 reveal 失败");
    assert.ok(entry.windowedAfterReveal.renderedRows <= 120, `reveal 末行后挂载 ${entry.windowedAfterReveal.renderedRows} 行`);
    assert.equal(entry.windowedAfterReveal.scrollTop > 0, true, "reveal 未滚动容器");
    // 关闭窗口化:全量挂载作对照
    await win.locator('input[type="checkbox"]').uncheck();
    await win.waitForTimeout(1500);
    entry.full10000 = await readTreeMetrics(win);
    assert.ok(entry.full10000.renderedRows >= 9900, `全量模式仅 ${entry.full10000.renderedRows} 行`);
    await win.screenshot({ path: resolve(output, "tree-full-10000.png") });
    entry.domReduction = `${(100 - entry.windowed10000.domElements / entry.full10000.domElements * 100).toFixed(1)}%`;
    await win.close();
  }

  // ─── 组 2:遮挡剔除(真实夹具:实体墙 + 墙后设备) ───
  {
    const entry = report.cases.occlusion = {};
    const off = await openViewer("&fixture=occlusion&objects=600&batching=off");
    await settle(off.page);
    entry.off = { state: await readState(off.page), errors: off.errors };
    await off.page.locator(".viewer-visual-qa-canvas").screenshot({ path: resolve(output, "occlusion-off.png") });
    assert.equal(entry.off.state.occlusion.enabled, false);
    const offDraws = entry.off.state.performance.renderer.drawCalls;
    await off.page.close();

    const on = await openViewer("&fixture=occlusion&objects=600&batching=off&occlusion=on");
    await settle(on.page);
    entry.on = { state: await readState(on.page), errors: on.errors };
    await on.page.locator(".viewer-visual-qa-canvas").screenshot({ path: resolve(output, "occlusion-on.png") });
    assert.equal(entry.on.state.occlusion.enabled, true);
    assert.ok(entry.on.state.occlusion.culledMeshes > 0, "开启后没有任何网格被剔除");
    assert.ok(entry.on.state.occlusion.avoidedTriangles > 0, "没有可量化的三角形节省");
    const onDraws = entry.on.state.performance.renderer.drawCalls;
    entry.drawCallReduction = `${(100 - onDraws / offDraws * 100).toFixed(1)}%`;
    assert.ok(onDraws < offDraws, `draw calls 未下降: on=${onDraws} off=${offDraws}`);
    // 运行时关闭:回到原路径
    await on.page.getByRole("button", { name: "关闭遮挡剔除" }).click();
    await settle(on.page);
    entry.toggledOff = await readState(on.page);
    assert.equal(entry.toggledOff.occlusion.enabled, false);
    assert.ok(entry.toggledOff.performance.renderer.drawCalls >= offDraws * 0.9, "关闭后绘制数未恢复");
    await on.page.close();
    entry.pixelSimilarity = await compareImageFiles(
      resolve(output, "occlusion-off.png"), resolve(output, "occlusion-on.png"), "occlusion-off", "occlusion-on",
      { differencePath: resolve(output, "occlusion-diff.png") });
    assert.ok(entry.pixelSimilarity.ssim >= 0.98, `遮挡剔除画面与原路径 SSIM 仅 ${entry.pixelSimilarity.ssim}`,);
  }

  // ─── 组 3:OffscreenCanvas 后台线程渲染 ───
  {
    const entry = report.cases.offscreen = {};
    // 基线:主线程渲染
    const main = await openViewer("&objects=300");
    await settle(main.page);
    entry.mainThread = { state: await readState(main.page), errors: main.errors };
    await main.page.locator(".viewer-visual-qa-canvas").screenshot({ path: resolve(output, "offscreen-main.png") });
    const mainDraws = entry.mainThread.state.performance.renderer.drawCalls;
    assert.ok(mainDraws > 0, "基线主线程渲染 draw calls 为 0");
    // 场景相似度基准截图(仅视口画布区域,排除 QA 侧栏文字)
    await main.page.close();

    const worker = await openViewer("&objects=300&offscreen=on", { expectOffscreen: true });
    await settle(worker.page);
    entry.workerThread = { state: await readState(worker.page), errors: worker.errors };
    assert.equal(entry.workerThread.state.offscreen.mode, "active", `后台渲染未激活: ${JSON.stringify(entry.workerThread.state.offscreen)}`);
    assert.ok(entry.workerThread.state.offscreen.frames > 3, "后台帧计数未增长");
    entry.overlay = await worker.page.evaluate(() => {
      const canvas = document.querySelector("canvas[data-offscreen-overlay]");
      const host = canvas?.parentElement?.getBoundingClientRect();
      return canvas ? { width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, hostWidth: host?.width } : null;
    });
    assert.ok(entry.overlay && entry.overlay.width > 100, "覆盖画布缺失或尺寸异常");
    assert.equal(entry.workerThread.state.performance.renderer.drawCalls, 0, "后台模式主线程仍在绘制");
    await worker.page.locator(".viewer-visual-qa-canvas").screenshot({ path: resolve(output, "offscreen-worker.png") });
    // 结构漂移:切换场景 → 防抖重检 → 静默重启
    const framesBefore = entry.workerThread.state.offscreen.frames;
    await worker.page.getByRole("button", { name: "切换场景" }).click();
    await worker.page.waitForTimeout(2600);
    entry.afterDrift = await readState(worker.page);
    assert.equal(entry.afterDrift.offscreen.mode, "active", "结构漂移后未保持后台渲染");
    assert.ok(entry.afterDrift.offscreen.restarts >= 1, "结构漂移未触发重启");
    assert.ok(entry.afterDrift.offscreen.frames > framesBefore, "重启后帧未继续");
    // 关闭:回主线程
    await worker.page.getByRole("button", { name: "关闭后台渲染" }).click();
    await settle(worker.page);
    entry.toggledOff = await readState(worker.page);
    assert.equal(entry.toggledOff.offscreen.mode, "off");
    assert.ok(entry.toggledOff.performance.renderer.drawCalls > 0, "关闭后台渲染后主线程未恢复绘制");
    await worker.page.close();
    entry.pixelSimilarity = await compareImageFiles(
      resolve(output, "offscreen-main.png"), resolve(output, "offscreen-worker.png"), "main", "worker",
      { differencePath: resolve(output, "offscreen-diff.png") });
    assert.ok(entry.pixelSimilarity.ssim >= 0.95 && entry.pixelSimilarity.severePixelRatio <= 0.03, `后台渲染画面差异过大: ssim=${entry.pixelSimilarity.ssim} severe=${entry.pixelSimilarity.severePixelRatio}`);

    // WebGPU 回退路径:开关打开但引擎不支持 → 如实回退并给出原因
    const webgpu = await openViewer("&objects=120&offscreen=on", { expectOffscreen: true, renderer: "webgpu" });
    await settle(webgpu.page);
    entry.webgpuFallback = { state: await readState(webgpu.page), errors: webgpu.errors };
    assert.equal(entry.webgpuFallback.state.offscreen.mode, "fallback");
    assert.match(entry.webgpuFallback.state.offscreen.reason, /WebGL/);
    assert.ok(entry.webgpuFallback.state.performance.renderer.drawCalls > 0, "回退后主线程未接管绘制");
    await webgpu.page.close();
  }
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
  writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2));
}
const summary = Object.fromEntries(Object.entries(report.cases).map(([name, entry]) => [name, {
  treeWindowed: entry.treeVirtualization?.windowed10000?.renderedRows,
  treeFull: entry.treeVirtualization?.full10000?.renderedRows,
  treeDomReduction: entry.treeVirtualization?.domReduction,
  occlusionCulled: entry.occlusion?.on?.state.occlusion.culledMeshes,
  occlusionAvoidedTriangles: entry.occlusion?.on?.state.occlusion.avoidedTriangles,
  occlusionDrawReduction: entry.occlusion?.drawCallReduction,
  occlusionSsim: entry.occlusion?.pixelSimilarity?.ssim,
  offscreenFrames: entry.offscreen?.workerThread?.state.offscreen.frames,
  offscreenRestarts: entry.offscreen?.afterDrift?.offscreen.restarts,
  offscreenSsim: entry.offscreen?.pixelSimilarity?.ssim,
  webgpuFallbackReason: entry.offscreen?.webgpuFallback?.state.offscreen.reason,
}]));
console.log(JSON.stringify({ output, summary }, null, 2));
