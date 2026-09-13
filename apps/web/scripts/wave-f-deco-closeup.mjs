// 波次 F 装饰/轨迹补拍:精确名逐卡特写(每名唯一命中)+ GIS 轨迹第二组。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const output = resolve("test-output/quantity-wave-f/round1b");
mkdirSync(output, { recursive: true });
const names = ["桁架承托标题条", "彗尾流光带", "极光帷幕光带", "流萤点缀簇", "网格扫掠标注", "电路纹角框边框", "样条流线边框", "井格藻井边框", "涡轮叶栅标题条", "齿轮传动标题条", "危化品运输轨迹地图", "AGV 巡检轨迹地图"];
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on("dialog", (dialog) => dialog.accept());
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
await page.getByRole("button", { name: "资源", exact: true }).first().click();
await page.waitForTimeout(1500);
await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
await page.waitForTimeout(700);
const search = page.getByPlaceholder("搜索组件");
const results = [];
for (const name of names) {
  await search.fill(name);
  await page.waitForTimeout(700);
  const card = page.locator(".dashboard-library-card", { hasText: name }).first();
  if (!(await card.count())) {
    results.push({ name, ok: false });
    continue;
  }
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await card.screenshot({ path: resolve(output, `closeup-${name}.png`) });
  results.push({ name, ok: true });
}
await search.fill("");
await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
console.log(JSON.stringify(results, null, 2));
await browser.close();
