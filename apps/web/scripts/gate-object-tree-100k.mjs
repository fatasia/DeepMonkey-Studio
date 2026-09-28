import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { buildVisualQaArtifact, createStaticServer } from "./productBrowserSupport.mjs";

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputRoot = resolve(webRoot, "../../test-output/t21-object-tree");
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(resolve(outputRoot, "run-"));
const dist = resolve(output, "dist");
buildVisualQaArtifact({ webRoot, outputRoot: dist });
const server = createStaticServer(dist);
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const report = { browser: browser.version(), viewport: "1280x800 DPR1", rows: 100_000, trials: [], status: "running" };
const read = page => page.evaluate(() => JSON.parse(document.querySelector('output[aria-label="目录性能指标"] pre').textContent));
const waitSelected = (page, id) => page.waitForFunction(value => JSON.parse(document.querySelector('output[aria-label="目录性能指标"] pre').textContent).selected === value, id);

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(`${origin}/?__visualQa=object-tree&count=100000&mode=objects&windowed=1&theme=dark`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector('[data-total-rows]')?.getAttribute("data-total-rows") === "100000", undefined, { timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('output[aria-label="目录性能指标"] pre')?.textContent.includes("fixtureItems"), undefined, { timeout: 30_000 });
  report.initial = await read(page);
  assert.ok(report.initial.renderedRows <= 30, `100,000 行时挂载 ${report.initial.renderedRows} 行`);
  await page.screenshot({ path: resolve(output, "100k-dark-1280.png") });

  for (let trial = 0; trial < 3; trial++) {
    if (trial) {
      await page.getByRole("button", { name: /工业设备 99998/ }).click();
      await waitSelected(page, "device-99998");
    }
    await page.getByRole("button", { name: "选中末行" }).click();
    await waitSelected(page, "device-99999");
    const metrics = await read(page);
    assert.ok(metrics.renderedRows <= 30 && metrics.scrollTop > 0, `末行定位后挂载 ${metrics.renderedRows} 行，scrollTop=${metrics.scrollTop}`);
    report.trials.push(metrics.updateToTwoFramesMs);
  }
  assert.ok(report.trials.every(ms => ms <= 100), `末行选择超过 100 ms：${report.trials.join("/")}`);

  await page.getByRole("button", { name: /工业设备 99998/ }).focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => document.activeElement?.textContent?.includes("99999"));
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => document.activeElement?.textContent?.includes("99998"));
  report.keyboard = "End → 99999, ArrowUp → 99998";

  await page.getByRole("button", { name: /工业设备 99999/ }).click();
  await page.getByRole("button", { name: "删除选中" }).click();
  await page.waitForFunction(() => document.querySelector('[data-total-rows]')?.getAttribute("data-total-rows") === "99999");
  report.delete = await read(page);
  assert.ok(report.delete.updateToTwoFramesMs <= 100, `删除末行超过 100 ms：${report.delete.updateToTwoFramesMs}`);
  assert.ok((await page.evaluate(() => document.activeElement?.textContent))?.includes("99998"), "删除后焦点未回退到相邻行");
  assert.equal(report.delete.selected, null);
  await page.close();

  const mobile = await browser.newPage({ viewport: { width: 480, height: 800 }, deviceScaleFactor: 1 });
  await mobile.goto(`${origin}/?__visualQa=object-tree&count=1000&mode=objects&windowed=1&theme=light`, { waitUntil: "domcontentloaded" });
  await mobile.waitForFunction(() => document.querySelector('[data-total-rows]')?.getAttribute("data-total-rows") === "1000", undefined, { timeout: 30_000 });
  report.mobile = await mobile.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, theme: document.documentElement.dataset.theme }));
  assert.ok(report.mobile.scrollWidth <= report.mobile.viewportWidth, "480 px 页面出现横向溢出");
  assert.equal(report.mobile.theme, "light");
  await mobile.screenshot({ path: resolve(output, "1k-light-480.png") });
  await mobile.close();
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  throw error;
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
  writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, report }, null, 2));
}
