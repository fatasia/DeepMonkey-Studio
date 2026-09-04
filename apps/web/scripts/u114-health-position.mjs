import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForTimeout(3000);
await page.goto("http://127.0.0.1:5173/data", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(5000);
const card = page.locator(".data-resource-card").first();
if (await card.count() > 0) { await card.click(); await page.waitForTimeout(800); }
const pos = await page.evaluate(() => {
  const panel = document.querySelector(".data-connector-health-panel");
  const list = document.querySelector(".data-card-list");
  if (!panel || !list) return { panel: Boolean(panel), list: Boolean(list) };
  return { panelY: Math.round(panel.getBoundingClientRect().y), listY: Math.round(list.getBoundingClientRect().y), panelAboveList: panel.getBoundingClientRect().y < list.getBoundingClientRect().y };
});
await page.screenshot({ path: "test-output/nightly-2026-09-05/u114-health-position.png" });
console.log(JSON.stringify(pos, null, 2));
await browser.close();
