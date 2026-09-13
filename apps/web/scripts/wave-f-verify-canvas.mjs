// 只读核查:清理后画布截图 + 图层清单(确认原始组件完好、取证残留清零)。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const output = resolve("test-output/quantity-wave-f/cleanup");
mkdirSync(output, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
if (await page.getByLabel("用户名").count()) {
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3000);
}
await page.getByRole("button", { name: "编辑场景" }).first().click();
await page.waitForTimeout(6000);
await page.waitForTimeout(4000); // 等自动保存落盘
const names = await page.evaluate(() => [...document.querySelectorAll(".dashboard-layer-row .dashboard-layer-select span")].map((el) => el.textContent?.trim()));
await page.screenshot({ path: resolve(output, "canvas-after-cleanup.png") });
console.log(JSON.stringify({ count: names.length, names }, null, 2));
await browser.close();
