// 资源中心页面级审美升级·视觉闭环探针:四个资源 tab × 深浅双主题整页截图。
// 用法:node scripts/asset-page-aesthetic-probe.mjs <round>
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const round = process.argv[2] ?? "round1";
const output = resolve("test-output/asset-page-aesthetic", round);
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
// 进入资源页
await page.getByRole("button", { name: "资源" }).first().click().catch(async () => {
  await page.getByRole("link", { name: "资源" }).first().click();
});
await page.waitForTimeout(3000);
// 等头部模型计数就绪(轻量目录请求返回)
await page.waitForFunction(() => {
  const node = document.querySelector(".unified-assets-kind-count");
  return node && node.textContent && node.textContent !== "—";
}, undefined, { timeout: 20000 }).catch(() => errors.push("model count not ready"));

const tabs = [["model", "模型与环境"], ["2d", "二维资源"], ["template", "看板模板"], ["prefab", "工业预制体"]];
for (const theme of ["dark", "light"]) {
  // 深色是默认主题(无 data-theme 属性);浅色显式设置,两个方向都从属性层生效,CSS 只读属性。
  await page.evaluate((t) => { if (t === "dark") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", "light"); }, theme);
  await page.waitForTimeout(600);
  for (const [key, label] of tabs) {
    const tabButton = page.getByRole("button", { name: new RegExp(label) }).first();
    if (!(await tabButton.count())) { errors.push(`tab not found: ${label}`); continue; }
    await tabButton.click();
    await page.waitForTimeout(key === "model" ? 3000 : 1800);
    await page.screenshot({ path: resolve(output, `${theme}-${key}.png`) });
  }
}
console.log(JSON.stringify({ round, errors: errors.slice(0, 6) }, null, 2));
await browser.close();
