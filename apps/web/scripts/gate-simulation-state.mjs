import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const output = fileURLToPath(new URL("../../../test-output/codex-2026-09-05/simulation-state/", import.meta.url));
await mkdir(output, { recursive: true });
const report = { createdAt: new Date().toISOString(), cases: [] };
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
  for (const width of [1440, 980]) for (const theme of ["dark", "light"]) {
    const entry = { width, theme, errors: [], writes: [] };
    report.cases.push(entry);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/api/**", async route => {
      if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method())) {
        entry.writes.push(route.request().url());
        await route.fulfill({ status: 409, json: { message: "Unexpected QA write blocked" } });
      } else await route.fallback();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => { if (["warning", "error"].includes(message.type())) entry.errors.push(message.text()); });
    try {
      await page.goto(`http://127.0.0.1:5173/?__visualQa=scene-simulation&theme=${theme}`);
      const tabs = page.locator(".scene-simulation-tabs button");
      const name = page.getByRole("textbox", { name: "工况名称", exact: true });
      await name.fill("QA 面板切换保留");
      await page.getByLabel("AGV 数量", { exact: true }).fill("17");
      await tabs.nth(3).click();
      await page.getByRole("button", { name: "运行并留证", exact: true }).waitFor();
      await tabs.nth(0).click();
      assert.equal(await name.inputValue(), "QA 面板切换保留");
      assert.equal(await page.getByLabel("AGV 数量", { exact: true }).inputValue(), "17");
      await tabs.nth(2).click();
      await page.locator(".commissioning-custom-case > summary").click();
      await page.getByLabel("运行时长 ms", { exact: true }).fill("1750");
      await page.getByRole("button", { name: "添加信号", exact: true }).click();
      const bindings = await page.locator(".commissioning-bindings").locator("input,select").evaluateAll(nodes => nodes.map(node => node.value));
      await tabs.nth(1).click();
      await tabs.nth(3).click();
      await tabs.nth(2).click();
      const custom = page.locator(".commissioning-custom-case");
      if (await custom.getAttribute("open") === null) await custom.locator(":scope > summary").click();
      assert.equal(await page.getByLabel("运行时长 ms", { exact: true }).inputValue(), "1750");
      assert.deepEqual(await page.locator(".commissioning-bindings").locator("input,select").evaluateAll(nodes => nodes.map(node => node.value)), bindings);
      await page.getByRole("button", { name: "收起仿真面板", exact: true }).click();
      await page.getByRole("button", { name: "展开仿真面板", exact: true }).click();
      assert.equal(await page.getByLabel("运行时长 ms", { exact: true }).inputValue(), "1750");
      await page.screenshot({ path: `${output}${theme}-${width}-control-retained.png` });
      await tabs.nth(0).click();
      await page.screenshot({ path: `${output}${theme}-${width}-retained.png` });
      assert.deepEqual(entry.errors, []);
      assert.deepEqual(entry.writes, []);
      entry.passed = true;
    } catch (error) {
      entry.failure = String(error);
      await page.screenshot({ path: `${output}${theme}-${width}-failed.png` });
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(`${output}report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
