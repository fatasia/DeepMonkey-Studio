import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForTimeout(3000);
await page.goto("http://127.0.0.1:5173/studio/d5395a30-4c29-4e8c-8bb0-b6b0d188c615", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(9000);
// 复现用户面板宽度：把左面板拉宽到 ~390px
await page.evaluate(() => { const p = document.querySelector(".left-panel"); p.style.width = "390px"; p.style.maxWidth = "390px"; });
await page.waitForTimeout(400);
await page.screenshot({ path: "test-output/nightly-2026-09-05/u111-outliner-before.png" });
// 顶栏验证
const crumb = await page.locator(".workspace-breadcrumb").count();
const modeChip = await page.locator(".workspace-context").first().textContent();
await page.screenshot({ path: "test-output/nightly-2026-09-05/u111-topbar.png", clip: { x: 0, y: 0, width: 900, height: 56 } });
console.log(JSON.stringify({ breadcrumbCount: crumb, modeChip: modeChip?.trim() }, null, 2));
await browser.close();
