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
await sleep(4000);
await page.locator('.workspace-mode-switch button:text-is("三维")').first().click();
await sleep(4500);
// 3D 顶栏 更多 场景工具
const more = page.locator('summary[aria-label="更多场景工具"]').first();
console.log("更多场景工具可见 =", await more.isVisible().catch(() => false));
if (await more.isVisible().catch(() => false)) {
  await more.click();
  await sleep(700);
  await page.screenshot({ path: "test-output/ui-sweep-2026-09-12/probe-3d-more-menu.png" });
  const items = (await page.locator("details[open] button").allTextContents()).map(t => t.trim()).filter(Boolean);
  console.log("菜单项:", JSON.stringify(items.slice(0, 16)));
  await page.keyboard.press("Escape");
  await sleep(400);
  console.log("Esc 关闭 =", !(await more.evaluate(el => el.parentElement?.open).catch(() => true)));
}
// 3D 顶栏 AI 助手
const ai = page.locator('button[aria-label="AI 场景助手"]').first();
console.log("AI 场景助手可见 =", await ai.isVisible().catch(() => false));
if (await ai.isVisible().catch(() => false)) {
  await ai.click();
  await sleep(1800);
  await page.screenshot({ path: "test-output/ui-sweep-2026-09-12/probe-3d-ai-panel.png" });
  await ai.click();
  await sleep(500);
  console.log("AI 面板已开合");
}
await browser.close();
