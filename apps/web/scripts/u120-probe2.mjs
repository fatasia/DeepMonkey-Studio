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
// 经管理台导航进入优化器(带 project 上下文)
await page.locator('.manager-capability-nav button[aria-label="模型优化"]').click();
await sleep(3000);
const texts = await page.locator("button").allTextContents();
console.log("含转换/导入/素材的按钮:", JSON.stringify(texts.filter(t => /转换|导入|素材|编辑与优化/.test(t)).slice(0, 8)));
const step2 = page.locator('button:has-text("转换")').first();
console.log("『转换』可见 =", await step2.isVisible().catch(() => false));
if (await step2.isVisible().catch(() => false)) {
  await step2.click();
  await sleep(1000);
  await page.screenshot({ path: "test-output/ui-sweep-2026-09-12/probe-fix-optimizer-step2.png" });
  const activeText = await page.locator("main, body").first().textContent();
  console.log("点击『转换』后页面含『转换』段落 =", activeText.includes("转换"));
}
// 直接 URL 无 project 参数的表现
await page.goto("http://127.0.0.1:5173/optimizer", { waitUntil: "domcontentloaded" });
await sleep(2500);
const t2 = await page.locator("button").allTextContents();
console.log("直连 /optimizer(无 project):", JSON.stringify(t2.filter(t => /转换|导入|素材/.test(t)).slice(0, 6)));
await page.screenshot({ path: "test-output/ui-sweep-2026-09-12/probe-optimizer-direct-url.png" });
await browser.close();
