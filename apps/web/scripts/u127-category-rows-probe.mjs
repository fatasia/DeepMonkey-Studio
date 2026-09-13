// 资源中心分类行验证:三个 tab 的 chips 渲染与过滤行为截图。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const output = resolve("test-output/category-rows");
mkdirSync(output, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
if (await page.getByLabel("用户名").count()) {
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3000);
}
// 进入资源页:管理台顶部导航"资源"
await page.getByRole("button", { name: "资源" }).first().click().catch(async () => {
  await page.getByRole("link", { name: "资源" }).first().click();
});
await page.waitForTimeout(3000);
const result = {};
for (const [tab, chipLabel] of [["二维资源", "图表"], ["看板模板", "生产制造"], ["工业预制体", "工业机器人"]]) {
  const tabButton = page.getByRole("button", { name: new RegExp(tab) }).first();
  if (await tabButton.count()) {
    await tabButton.click();
    await page.waitForTimeout(1500);
    const chips = page.locator(".built-in-category-row button");
    result[`${tab}-chipCount`] = await chips.count();
    await chips.filter({ hasText: chipLabel }).first().click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: resolve(output, `${tab}-filtered.png`) });
    result[`${tab}-summaryAfterFilter`] = await page.locator(".unified-assets-summary").textContent().catch(() => "");
  } else {
    result[`${tab}-tab`] = "not found";
  }
}
console.log(JSON.stringify({ result, errors: errors.slice(0, 4) }, null, 2));
await browser.close();
