import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

// 仅内存视觉夹具；验证四个真实面板的布局/折叠，不把它当成仿真正确性验收。
const output = fileURLToPath(new URL("../../../test-output/codex-2026-09-05/simulation-panels/", import.meta.url));
await mkdir(output, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const report = { createdAt: new Date().toISOString(), cases: [] };
try {
  for (const viewport of [1440, 980]) for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: viewport, height: 900 } });
    page.setDefaultTimeout(12000);
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['warning', 'error'].includes(message.type())) errors.push(message.text()); });
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url()); });
    const entry = { id: `${viewport}-${theme}`, passed: false, panels: [] };
    report.cases.push(entry);
    try {
      await page.goto(`${process.env.BIM_STUDIO_QA_ORIGIN ?? 'http://127.0.0.1:5173'}/?__visualQa=scene-simulation&theme=${theme}`);
      const panel = page.locator('.scene-simulation-panel');
      const body = page.locator('.scene-simulation-body');
      await body.locator('.operations-content').waitFor();
      for (const width of [520, 420]) {
        const before = await panel.boundingBox();
        if (Math.abs(before.width - width) > 1) {
          const handle = await page.getByRole('button', { name: '调整仿真面板大小', exact: true }).boundingBox();
          await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
          await page.mouse.down();
          await page.mouse.move(handle.x + handle.width / 2 + width - before.width, handle.y + handle.height / 2, { steps: 8 });
          await page.mouse.up();
        }
        for (const [index, name] of ['logistics', 'workcell', 'commissioning', 'whatif'].entries()) {
          await page.locator('.scene-simulation-tabs button').nth(index).click();
          await body.locator('.operations-content').waitFor();
          await page.locator('.scene-simulation-loading').waitFor({ state: 'hidden' });
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const dimensions = await body.evaluate(e => ({ client: e.clientWidth, scroll: e.scrollWidth }));
          const bounds = await panel.boundingBox();
          entry.panels.push({ name, width, dimensions, bounds });
          assert.ok(Math.abs(bounds.width - width) <= 1);
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport && bounds.y + bounds.height <= 900);
          assert.ok(dimensions.scroll <= dimensions.client + 1, `${name} ${width}: ${JSON.stringify(dimensions)}`);
          if (name === 'whatif') assert.equal(await body.getByRole('button', { name: '运行并留证', exact: true }).evaluate(e => getComputedStyle(e).whiteSpace), 'nowrap');
          const values = () => body.locator('input, select, textarea').evaluateAll(elements => elements.map(e => e.value));
          const initial = await values();
          await page.getByRole('button', { name: '收起仿真面板', exact: true }).click();
          assert.ok(!await body.isVisible());
          assert.ok((await panel.boundingBox()).height <= 49);
          await page.getByRole('button', { name: '展开仿真面板', exact: true }).click();
          assert.deepEqual(await values(), initial, '折叠不应卸载/重置表单');
          await page.screenshot({ path: `${output}${entry.id}-${width}-${name}.png` });
        }
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(writes, []);
      entry.passed = true;
    } catch (error) {
      entry.error = error.stack;
      entry.browserErrors = errors;
      await page.screenshot({ path: `${output}${entry.id}-failed.png` });
    } finally { await page.close(); }
  }
} finally {
  await browser.close();
  await writeFile(`${output}report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
assert.ok(report.cases.length === 4 && report.cases.every(entry => entry.passed), `See ${output}report.json`);
