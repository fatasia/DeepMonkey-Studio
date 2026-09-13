// 终版对照板素材:当前实机三张(模板库真渲染封面/2D 资源页/预制体库)。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const output = resolve("test-output/visual-compare/final-state");
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
// 管理端资源页:模板 tab(真渲染封面需要等待渐进渲染)
await page.getByRole("button", { name: "资源" }).first().click().catch(async () => {
  await page.getByRole("link", { name: "资源" }).first().click();
});
await page.waitForTimeout(2500);
await page.locator(".unified-assets-browser button, .unified-assets-controls button", { hasText: "看板模板" }).first().click().catch(async () => {
  await page.getByText("看板模板", { exact: false }).first().click();
});
await page.waitForTimeout(20000);
await page.screenshot({ path: resolve(output, "final-templates.png") });
// 2D tab
await page.locator("button", { hasText: "二维资源" }).first().click().catch(() => {});
await page.waitForTimeout(4000);
await page.screenshot({ path: resolve(output, "final-2d.png") });
// 预制体 tab
await page.locator("button", { hasText: "工业预制体" }).first().click().catch(() => {});
await page.waitForTimeout(8000);
await page.screenshot({ path: resolve(output, "final-prefab.png") });
console.log("final-state captured");
await browser.close();
