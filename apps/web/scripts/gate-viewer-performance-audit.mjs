import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { buildVisualQaArtifact, createStaticServer } from "./productBrowserSupport.mjs";

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const parent = resolve(webRoot, "../../test-output/runs/2026-09-05");
mkdirSync(parent, { recursive: true });
// 每轮独立目录，保留以往性能证据；不替换正式 dist 或用户浏览器实例。
const output = mkdtempSync(resolve(parent, "viewer-performance-"));
const dist = resolve(output, "dist");
buildVisualQaArtifact({ webRoot, outputRoot: dist });
const server = createStaticServer(dist);
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu"] });
const report = { createdAt: new Date().toISOString(), boundary: "Production-built QA primitives, no API/industrial model; local headless Chrome, 1440x900 DPR1, effects/shadows on; diagnostic baseline, not Unity parity or 10k acceptance", cases: [] };
try {
  const browserCdp = await browser.newBrowserCDPSession();
  const info = await browserCdp.send("SystemInfo.getInfo");
  report.gpu = info.gpu.devices;
  report.browser = browser.version();
  for (const objects of [120, 1000]) for (const renderer of ["webgl", "webgpu"]) {
    const entry = { objects, renderer, errors: [], warnings: [] };
    report.cases.push(entry);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page.on("console", m => { if (m.type() === "error") entry.errors.push(m.text()); else if (m.type() === "warning") entry.warnings.push(m.text()); });
    page.on("pageerror", e => entry.errors.push(e.message));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const started = performance.now();
    try {
      await page.goto(`${origin}/?__visualQa=viewer&renderer=${renderer}&objects=${objects}&effects=on&shadows=on`, { waitUntil: "commit" });
      await page.waitForFunction(() => window.__viewerQa?.ready || window.__viewerQa?.error, undefined, { timeout: 60000 });
      entry.qaReadyMs = Math.round(performance.now() - started);
      const initial = await page.evaluate(() => window.__viewerQa);
      assert.equal(initial.error, undefined);
      assert.equal(initial.statistics.primitiveCount, objects);
      await page.waitForTimeout(6000);
      const events = [];
      cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value));
      await cdp.send("Tracing.start", { categories: "devtools.timeline,toplevel,disabled-by-default-devtools.timeline", transferMode: "ReportEvents" });
      const metricsBefore = await cdp.send("Performance.getMetrics");
      const canvas = page.locator(".viewer-visual-qa-canvas canvas");
      const bounds = await canvas.boundingBox();
      assert.ok(bounds);
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      for (let step = 0; step < 60; step += 1) {
        await page.mouse.move(bounds.x + bounds.width / 2 + Math.sin(step / 10) * 100, bounds.y + bounds.height / 2 + Math.cos(step / 10) * 60);
        await page.waitForTimeout(40);
      }
      await page.mouse.up();
      await page.waitForTimeout(600);
      const metricsAfter = await cdp.send("Performance.getMetrics");
      const complete = new Promise(done => cdp.once("Tracing.tracingComplete", done));
      await cdp.send("Tracing.end");
      await complete;
      entry.state = await page.evaluate(() => window.__viewerQa);
      entry.renderBudget33ms = entry.state.performance.frameTimeMs.p95 <= 33.34;
      entry.metrics = Object.fromEntries(metricsAfter.metrics.map(metric => [metric.name, metric.value - (metricsBefore.metrics.find(m => m.name === metric.name)?.value ?? 0)]));
      const main = events.find(event => event.name === "thread_name" && event.args?.name === "CrRendererMain");
      const tasks = main ? events.filter(event => event.pid === main.pid && event.tid === main.tid && event.ph === "X" && /^(ThreadControllerImpl::RunTask|RunTask)$/.test(event.name)) : [];
      entry.mainThreadTasks = tasks.length || null;
      entry.longTasksOver50ms = tasks.length ? tasks.filter(event => event.dur > 50000).map(event => Math.round(event.dur / 100) / 10) : null;
      writeFileSync(resolve(output, `${renderer}-${objects}-trace.json`), JSON.stringify({ traceEvents: events }));
      await page.screenshot({ path: resolve(output, `${renderer}-${objects}.png`) });
      entry.rendered = true;
    } catch (error) {
      entry.failure = String(error);
      await page.screenshot({ path: resolve(output, `${renderer}-${objects}-failed.png`) }).catch(() => undefined);
    } finally { await page.close(); }
  }
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
  writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ output, cases: report.cases.map(({ renderer, objects, rendered, qaReadyMs, renderBudget33ms, longTasksOver50ms, errors, warnings, failure, state }) => ({ renderer, objects, rendered, qaReadyMs, renderBudget33ms, longTasksOver50ms, errors, warnings, failure, frames: state?.performance?.frameTimeMs, draws: state?.performance?.renderer?.drawCalls })) }, null, 2));
assert.ok(report.cases.every(item => item.rendered && !item.errors.length), `Rendering failure; inspect ${output}`);
