// 2D 看板编辑器资源面板(dashboardComponentLibrary)视觉验证:VisualQa 路由直开 DashboardWorkspace。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const output = resolve("test-output/asset-page-aesthetic", "round3");
mkdirSync(output, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto("http://127.0.0.1:5173/?__visualQa=dashboard", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(6000);
if (await page.getByLabel("用户名").count()) {
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(4000);
}
await page.waitForTimeout(3000);
// 左侧面板切到“资源”tab(dashboard-library-browser 所在)
await page.getByRole("button", { name: "资源" }).first().click().catch(() => undefined);
await page.waitForTimeout(1800);
const lib = page.locator(".dashboard-library-browser");
if (await lib.count()) {
  await lib.scrollIntoViewIfNeeded().catch(() => undefined);
}
await page.screenshot({ path: resolve(output, "dark-2d-editor-panel.png") });
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
await page.waitForTimeout(800);
await page.screenshot({ path: resolve(output, "light-2d-editor-panel.png") });
console.log(JSON.stringify({ libraryVisible: await lib.count() > 0 }));
await browser.close();
