import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded" });
await page.locator("input[aria-label=用户名]").waitFor({ timeout: 20000 });
await page.locator("input[aria-label=用户名]").fill("admin");
await page.locator("input[aria-label=密码]").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.locator(".scene-manager-page").waitFor({ timeout: 30000 });
await sleep(1200);
await page.locator('.scene-card button[aria-label="编辑场景"]').first().click();
await sleep(4500);
// 枚举页面栏
const tabs = page.locator(".dashboard-page-tabs button, .dashboard-page-bar [class*=tab]");
console.log("页面 tab 数 =", await tabs.count());
for (let i = 0; i < await tabs.count(); i++) console.log(`  tab[${i}] =`, (await tabs.nth(i).textContent()).trim().slice(0, 30));
// 若多于 1 页,选中最后一页并删除
if (await tabs.count() > 1) {
  await tabs.nth((await tabs.count()) - 1).click();
  await sleep(1200);
  const del = page.locator('button[aria-label="删除当前页面"]').first();
  for (let i = 0; i < 20 && (await del.isDisabled().catch(() => true)); i++) await sleep(1000);
  console.log("删除按钮禁用 =", await del.isDisabled().catch(() => true));
  await del.click({ timeout: 5000 }).catch(e => console.log("点击删除失败:", String(e.message).slice(0, 120)));
  await sleep(1500);
  // 原生 confirm/自定义对话框处理
  const confirm = page.getByRole("button", { name: /删除|确认|确定/ }).first();
  if (await confirm.isVisible().catch(() => false) && !(await confirm.isDisabled().catch(() => true))) {
    await confirm.click().catch(() => {});
    await sleep(1200);
  }
  console.log("清理后页面 tab 数 =", await page.locator(".dashboard-page-tabs button, .dashboard-page-bar [class*=tab]").count());
} else {
  console.log("仅 1 页,无需清理");
}
await page.screenshot({ path: "test-output/ui-sweep-2026-09-12/cleanup-pages.png" });
await browser.close();
