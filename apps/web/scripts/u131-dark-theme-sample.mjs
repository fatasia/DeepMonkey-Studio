// u131 附加:dark 主题抽验(全量两轮实证跑在 light 口径下,补 dark 键的真渲染抽验)。
// 登录后立即设 dark(真实变值路径),打开库滚动 5 屏,统计可视区卡片真渲染覆盖。
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const output = resolve("test-output/cover-performance");
mkdirSync(output, { recursive: true });

const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error?.message ?? error)));

await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
if (await page.getByLabel("用户名").count()) {
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3000);
}
await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
await page.waitForTimeout(500);
await page.getByRole("button", { name: "编辑场景" }).first().click();
await page.waitForTimeout(5000);
const resourceTab = page.getByRole("button", { name: /^资源$/ }).first();
if (await resourceTab.count()) await resourceTab.click();
await page.waitForTimeout(2500);
await page.locator(".dashboard-library-template-button").first().click();
await page.locator(".dashboard-template-grid article .dashboard-template-card-preview").first().waitFor({ timeout: 30000 });

// 滚 5 屏让 ~40 卡进入过视口(rootMargin 320px)
const body = page.locator(".dashboard-template-body").first();
for (let step = 0; step < 5; step += 1) {
  await body.evaluate((element) => { element.scrollTop += element.clientHeight * 0.85; });
  await page.waitForTimeout(1200);
}
// 等队列消化:img 数量连续稳定
let stable = 0, previous = -1, photos = 0;
for (;;) {
  photos = await page.evaluate(() => document.querySelectorAll("img.dashboard-template-cover-photo").length);
  if (photos === previous) stable += 1; else stable = 0;
  previous = photos;
  if (stable >= 4) break;
  await page.waitForTimeout(3000);
}
const stats = await page.evaluate(() => {
  const previews = [...document.querySelectorAll(".dashboard-template-card-preview")];
  const scrolled = previews.slice(0, 48); // 5 屏 + 首屏触及范围
  return {
    theme: document.documentElement.dataset.theme,
    scrolledCards: scrolled.length,
    scrolledWithPhoto: scrolled.filter((element) => element.querySelector("img.dashboard-template-cover-photo")).length,
    totalPhotos: document.querySelectorAll("img.dashboard-template-cover-photo").length,
  };
});
await page.screenshot({ path: resolve(output, "dark-theme-check.png") });
const report = { generatedAt: new Date().toISOString(), round: "dark-sample", ...stats, pageErrors };
writeFileSync(resolve(output, "dark-theme-sample.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));
await browser.close();
