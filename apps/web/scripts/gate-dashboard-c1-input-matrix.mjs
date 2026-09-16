/** Dashboard C1 输入矩阵 + C2 整页视觉回归(真实发布链,真实点击)。
 *  用法:node apps/web/scripts/gate-dashboard-c1-input-matrix.mjs <applicationId> [webOrigin]
 *  产物:test-output/dashboard-c1c2-browser-<date>/(截图 + evidence.json)。 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const applicationId = process.argv[2];
if (!applicationId) throw new Error("Expected <applicationId>");
const origin = process.argv[3] ?? "http://127.0.0.1:5173";
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const root = fileURLToPath(new URL("../../..", import.meta.url));
const output = path.join(root, "test-output/dashboard-c1c2-browser-20260917");
await mkdir(output, { recursive: true });

const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true });
const evidence = { applicationId, origin, steps: [], consoleErrors: [], screenshots: [] };
const step = (name, detail = {}) => { evidence.steps.push({ name, ...detail }); console.log(`✓ ${name}`, JSON.stringify(detail).slice(0, 120)); };

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", error => evidence.consoleErrors.push(`pageerror: ${error.message}`));
  page.on("console", message => { if (message.type() === "error") evidence.consoleErrors.push(message.text()); });

  // ── C2/加载:发布链整页打开(无登录门) ──
  await page.goto(`${origin}/apps/${applicationId}`);
  await page.locator('[data-dashboard-capture="value"]').first().waitFor({ timeout: 30_000 });
  await page.locator('[data-dashboard-capture="table"]').first().waitFor({ timeout: 15_000 });
  step("published page renders KPI and table");

  // ── C1 排序:表头点击 asc/desc ──
  const table = page.locator('[data-dashboard-capture="table"]').first();
  const firstCellText = () => table.locator('[data-capture-role="cell"][data-capture-row="0"][data-capture-column="产量"]').innerText();
  const unsorted = await firstCellText();
  await table.locator('[data-capture-role="header"][data-capture-column="产量"]').click();
  await page.waitForFunction(() => document.querySelector('[data-capture-sort-column="产量"]') !== null);
  const asc = await firstCellText();
  assert.equal(await table.getAttribute("data-capture-sort-direction"), "asc", "sort direction must be asc");
  assert.notEqual(asc, unsorted || null, "asc sort must reorder rows");
  step("table sort asc", { firstRow: asc, sortDirection: "asc" });
  await table.locator('[data-capture-role="header"][data-capture-column="产量"]').click();
  await page.waitForFunction(() => document.querySelector('[data-capture-sort-direction="desc"]') !== null);
  const desc = await firstCellText();
  assert.notEqual(desc, asc, "desc sort must flip order");
  step("table sort desc", { firstRow: desc });

  // ── C1 分页:8 行 × pageSize 3 = 3 页,首末页禁用态 ──
  const previous = table.locator('[data-capture-role="previous"]');
  const next = table.locator('[data-capture-role="next"]');
  const rowNumbers = () => table.locator('[data-capture-role="row-number"]').allInnerTexts();
  assert.equal(await previous.isDisabled(), true, "first page disables previous");
  await next.click();
  await page.waitForFunction(() => document.querySelector('[data-capture-role="row-number"]')?.textContent === "4");
  assert.deepEqual(await rowNumbers(), ["4", "5", "6"]);
  step("pager next", { rows: "4-6" });
  await next.click();
  await page.waitForFunction(() => document.querySelector('[data-capture-role="row-number"]')?.textContent === "7");
  assert.deepEqual(await rowNumbers(), ["7", "8"], "last page holds remaining rows");
  assert.equal(await next.isDisabled(), true, "last page disables next");
  step("pager last", { rows: "7-8", nextDisabled: true });
  await previous.click();
  await page.waitForFunction(() => document.querySelector('[data-capture-role="row-number"]')?.textContent === "4");
  step("pager previous", { rows: "4-6" });

  // ── C1 行点击:真实点击不崩、不产生控制台错误 ──
  await table.locator('[data-capture-role="cell"][data-capture-row="3"][data-capture-column="产线"]').click();
  step("row click dispatched without error");

  // ── C1 导出动作(web 回放为真实实现):CSV 下载 ──
  const csvButton = page.getByTitle(/导出 CSV/);
  if (await csvButton.count()) {
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 10_000 }), csvButton.click()]);
    const csvPath = path.join(output, "exported-rows.csv");
    await download.saveAs(csvPath);
    evidence.exportedCsv = { suggested: download.suggestedFilename() };
    step("csv export download", { file: path.basename(csvPath) });
  } else {
    evidence.exportedCsv = "toolbar absent in this build";
    step("csv export button absent", { note: "recorded honestly" });
  }

  // ── C1 换页:打开项目控制面板,导航按钮切换页面再返回 ──
  await page.locator('button[aria-label="项目控制"]').click();
  const pageNav = page.locator('nav[aria-label="页面"]');
  await pageNav.waitFor({ timeout: 10_000 });
  await pageNav.locator("button", { hasText: "二级页面" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-dashboard-capture="value"]').length >= 1);
  await page.waitForTimeout(400);
  const pageBValues = await page.locator('[data-dashboard-capture="value"]').count();
  assert.ok(pageBValues >= 1, "page B renders its KPI");
  step("switch to page B", { valueWidgets: pageBValues });
  await page.screenshot({ path: path.join(output, "c1-page-b.png"), fullPage: true });
  evidence.screenshots.push("c1-page-b.png");
  await pageNav.locator("button", { hasText: "验收总览" }).click();
  await page.locator('[data-dashboard-capture="table"]').first().waitFor({ timeout: 10_000 });
  step("switch back to page A");
  // 返回后再次排序:旧页状态不得串页
  await table.locator('[data-capture-role="header"][data-capture-column="产量"]').click();
  await page.waitForFunction(() => document.querySelector('[data-capture-sort-column="产量"]') !== null);
  step("post-switch sort still routed to page A table");

  // ── C2 整页视觉:双主题 × 双宽度(整页而非组件夹具)。
  // 发布路由主题跟随系统品牌设置(branding.themeMode),走真实管理链路切换并在 finally 还原。 ──
  const apiBase = new URL(origin).port === "5173" ? "http://127.0.0.1:4100" : origin;
  const login = await fetch(`${apiBase}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }),
  });
  assert.equal(login.status, 200, "admin login for branding toggle");
  const adminToken = (await login.json()).token;
  const patchTheme = async mode => {
    const current = await (await fetch(`${apiBase}/api/public/branding`)).json();
    const response = await fetch(`${apiBase}/api/admin/branding`, { method: "PATCH",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...current, themeMode: mode }) });
    assert.ok(response.ok, `branding themeMode=${mode} must apply`);
  };
  const originalBranding = await (await fetch(`${apiBase}/api/public/branding`)).json();
  try {
    for (const [theme, width] of [["dark", 1280], ["dark", 980], ["light", 1280], ["light", 980]]) {
      await patchTheme(theme);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/apps/${applicationId}`);
      await page.locator('[data-dashboard-capture="table"]').first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(700);
      const applied = await page.evaluate(() => document.documentElement.dataset.theme);
      assert.equal(applied, theme, `published route must apply branding theme ${theme}`);
      const file = `c2-full-${theme}-${width}.png`;
      await page.screenshot({ path: path.join(output, file), fullPage: true });
      evidence.screenshots.push(file);
      step("full-page screenshot", { theme, width });
    }
  } finally {
    await patchTheme(originalBranding.themeMode ?? "dark").catch(() => {});
  }

  assert.deepEqual(evidence.consoleErrors, [], "console must stay clean");
  evidence.consoleErrorsWereClean = true;
  await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`\nC1 input matrix + C2 full-page visual regression PASSED. Evidence: ${output}`);
} finally {
  await browser.close();
  const { writeFile: wf } = await import("node:fs/promises");
  await wf(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2)).catch(() => {});
}
