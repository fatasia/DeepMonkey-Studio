// 管理端资源页 2D tab 双主题补拍(登录后切 data-theme,非 visualQa 入口)。
import path from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "load" });
  await page.waitForTimeout(1200);
  await page.getByLabel(/用户名|Username/).first().fill("admin");
  await page.getByLabel(/密码|Password/).first().fill("admin");
  await page.getByRole("button", { name: /登录|Sign in/i }).first().click();
  await page.waitForTimeout(2200);
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  await page.waitForTimeout(400);
  const assetsTab = page.locator('button[aria-label="资源"], button[aria-label="Assets"]').first();
  if (await assetsTab.isEnabled().catch(() => false)) { await assetsTab.click(); await page.waitForTimeout(1600); }
  const kind2d = page.locator('button:has-text("二维资源")').first();
  if (await kind2d.isVisible().catch(() => false)) { await kind2d.click(); await page.waitForTimeout(1000); }
  const grid = page.locator(".built-in-assets-grid").first();
  if (await grid.isVisible().catch(() => false)) {
    await grid.screenshot({ path: path.resolve(`test-output/ui-upgrade-2d/manager-2d-${theme}.png`) });
  } else {
    console.log(`[${theme}] grid not visible`);
  }
  await page.close();
}
await browser.close();
console.log("manager themes done");
