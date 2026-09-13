// Round2:头部高度量化 + 空态 + 卡片 hover + 分页行 + 1280 宽度验证。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const output = resolve("test-output/asset-page-aesthetic", "round2");
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
await page.getByRole("button", { name: "资源" }).first().click().catch(async () => {
  await page.getByRole("link", { name: "资源" }).first().click();
});
await page.waitForTimeout(3000);
await page.waitForFunction(() => {
  const node = document.querySelector(".unified-assets-kind-count");
  return node && node.textContent && node.textContent !== "—";
}, undefined, { timeout: 20000 }).catch(() => errors.push("model count not ready"));

// 1) 头部高度量化(头部行 + 统计 tab 行)
const metrics = await page.evaluate(() => {
  const head = document.querySelector(".unified-assets-head");
  const kinds = document.querySelector(".unified-assets-kinds");
  return { headHeight: head?.getBoundingClientRect().height ?? 0, kindsHeight: kinds?.getBoundingClientRect().height ?? 0, total: (head?.getBoundingClientRect().height ?? 0) + (kinds?.getBoundingClientRect().height ?? 0) };
});
// 2) 收紧后的深色整页
await page.screenshot({ path: resolve(output, "dark-model.png") });

// 3) 卡片 hover 态
const firstCard = page.locator(".unified-asset-card").first();
await firstCard.hover();
await page.waitForTimeout(400);
await page.screenshot({ path: resolve(output, "dark-model-hover.png") });

// 4) 空态(模型库搜乱词)
await page.getByRole("textbox", { name: "搜索资源" }).fill("zzzzqqq");
await page.waitForTimeout(1500);
await page.screenshot({ path: resolve(output, "dark-model-empty.png") });
await page.getByRole("textbox", { name: "搜索资源" }).fill("");
await page.waitForTimeout(1200);

// 5) 分页行(滚动到底)
await page.evaluate(() => { const el = document.querySelector(".scene-manager-page"); if (el) el.scrollTop = el.scrollHeight; });
await page.waitForTimeout(700);
await page.screenshot({ path: resolve(output, "dark-model-pagination.png") });
await page.evaluate(() => { const el = document.querySelector(".scene-manager-page"); if (el) el.scrollTop = 0; });

// 6) 内置库空态(2D tab 搜乱词)
await page.getByRole("button", { name: "二维资源" }).first().click();
await page.waitForTimeout(1500);
await page.getByRole("textbox", { name: "搜索内置资源" }).fill("zzzzqqq");
await page.waitForTimeout(900);
await page.screenshot({ path: resolve(output, "dark-2d-empty.png") });

// 7) 1280 宽度(工作台主流档)
await page.setViewportSize({ width: 1280, height: 800 });
await page.getByRole("textbox", { name: "搜索内置资源" }).fill("");
await page.waitForTimeout(1200);
await page.screenshot({ path: resolve(output, "dark-2d-1280.png") });

console.log(JSON.stringify({ metrics, errors: errors.slice(0, 6) }, null, 2));
await browser.close();
