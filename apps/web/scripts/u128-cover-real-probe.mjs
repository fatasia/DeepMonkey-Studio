// 真实渲染封面管线验证:模板库打开后 SVG 先行 → 真渲染截帧替换。三个时点截图 + 抽样特写。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const output = resolve("test-output/cover-real");
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
// 进入一个项目 → 二维看板 → 模板按钮打开模板库
await page.getByRole("button", { name: "编辑场景" }).first().click();
await page.waitForTimeout(5000);
const templateButton = page.locator(".dashboard-library-template-button").first();
await templateButton.click();
await page.waitForTimeout(1200);
await page.screenshot({ path: resolve(output, "t0-svg-first.png") });
await page.waitForTimeout(6000);
await page.screenshot({ path: resolve(output, "t1-mid.png") });
await page.waitForTimeout(15000);
await page.screenshot({ path: resolve(output, "t2-settled.png") });
// 统计真渲染封面数量(真渲染 img vs SVG 兜底)
const counts = await page.evaluate(() => {
  const root = document.querySelector(".dashboard-template-library, [class*=template-library]");
  const scope = root ?? document;
  const real = scope.querySelectorAll("img[data-template-cover-real], img[class*=cover-real], img[src^=\"data:image\"]").length;
  const svg = scope.querySelectorAll("svg").length;
  return { real, svg };
});
console.log(JSON.stringify({ counts, errors: errors.slice(0, 5) }, null, 2));
await browser.close();
