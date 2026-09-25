import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

/** 固定内存夹具，不登录、不编辑用户场景；断言失败必须返回非零。 */
export async function runDashboardGate(name, inspect, prepare) {
  const outputRoot = fileURLToPath(new URL(`../../../test-output/runs/2026-09-05/${name}/`, import.meta.url));
  await mkdir(outputRoot, { recursive: true });
  const browser = await playwright.chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const report = { name, createdAt: new Date().toISOString(), cases: [] };
  try {
    for (const width of [1440, 980]) for (const theme of ["dark", "light"]) {
      const id = `${width}-${theme}`;
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(10000);
      const errors = [], writes = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (["error", "warning"].includes(message.type())) errors.push(message.text()); });
      page.on("request", (request) => { if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) writes.push(`${request.method()} ${request.url()}`); });
      const result = { id, passed: false };
      report.cases.push(result);
      try {
        await prepare?.(page);
        const origin = process.env.BIM_STUDIO_QA_ORIGIN ?? "http://127.0.0.1:5173";
        await page.goto(`${origin}/?__visualQa=dashboard&theme=${theme}`, { waitUntil: "domcontentloaded" });
        await waitCount(page, ".dashboard-node", 9);
        await page.getByRole("button", { name: "完整显示看板", exact: true }).click();
        await settleFrames(page);
        Object.assign(result, await inspect(page, `${outputRoot}${id}`));
        assert.deepEqual(errors, [], "浏览器不应产生错误或警告");
        assert.deepEqual(writes, [], "视觉夹具不得写入服务器");
        result.passed = true;
      } catch (error) {
        result.error = error.stack ?? String(error);
        result.browserErrors = errors;
        await page.screenshot({ path: `${outputRoot}${id}-failed.png` });
      } finally { await page.close(); }
    }
  } finally {
    await browser.close();
    await writeFile(`${outputRoot}report.json`, JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.cases.length === 4 && report.cases.every((item) => item.passed), `${name} failed; see ${outputRoot}report.json`);
}

export async function waitCount(page, selector, expected) {
  await page.waitForFunction(({ selector, expected }) => document.querySelectorAll(selector).length === expected, { selector, expected });
}

export async function settleFrames(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

export async function blankPoint(page) {
  const box = await page.locator(".dashboard-canvas-scroll").boundingBox();
  assert.ok(box);
  return { x: box.x + 30, y: box.y + box.height - 30, box };
}
