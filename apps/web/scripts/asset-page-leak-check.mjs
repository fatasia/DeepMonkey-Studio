// 零风格泄漏抽查:资源页氛围背景仅作用于 .scene-manager-page.asset-workspace-active(资源 tab)。
// 抽查管理台首页 / 3D 编辑器 / 系统设置页,并输出各页面背景 computed value 作量化证据。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const output = resolve("test-output/asset-page-aesthetic", "leak-check");
mkdirSync(output, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
if (await page.getByLabel("用户名").count()) {
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3000);
}
const evidence = {};
const readBackground = () => page.evaluate(() => {
  const main = document.querySelector(".scene-manager-page");
  return { sceneManagerBg: main ? getComputedStyle(main).backgroundImage.slice(0, 80) : "n/a", hasWorkspaceActive: Boolean(document.querySelector(".scene-manager-page.asset-workspace-active")) };
});

// 1) 管理台首页(默认 tab:项目场景)
await page.waitForTimeout(1500);
await page.screenshot({ path: resolve(output, "manager-home.png") });
evidence.managerHome = await readBackground();

// 2) 资源页(对照组:氛围背景应存在)
await page.getByRole("button", { name: "资源" }).first().click();
await page.waitForTimeout(2500);
evidence.assetsTab = await readBackground();
await page.screenshot({ path: resolve(output, "assets-tab.png") });

// 3) 系统设置页
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(2000);
evidence.settings = await readBackground();
await page.screenshot({ path: resolve(output, "settings.png") });

// 4) 3D 编辑器(示例场景)
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
await page.getByRole("button", { name: "示例场景" }).first().click().catch(async () => {
  await page.getByRole("link", { name: "示例场景" }).first().click();
});
await page.waitForTimeout(9000);
evidence.editor = await readBackground();
await page.screenshot({ path: resolve(output, "editor.png") });

console.log(JSON.stringify(evidence, null, 2));
await browser.close();
