import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const errs = [];
page.on("console", m => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded" });
await page.locator("input[aria-label=用户名]").waitFor({ timeout: 20000 });
await page.locator("input[aria-label=用户名]").fill("admin");
await page.locator("input[aria-label=密码]").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.locator(".scene-manager-page").waitFor({ timeout: 30000 });
await sleep(1200);
await page.locator('.scene-card button[aria-label="编辑场景"]').first().click();
await sleep(5000);
const dump = async (tag) => {
  const tabs = await page.locator(".dashboard-page-tabs button").evaluateAll(els => els.map(e => ({
    text: e.textContent.trim(), current: e.getAttribute("aria-current"), cls: e.className.slice(0, 60),
  })));
  const saveDisabled = await page.locator('button[aria-label="保存项目"]').isDisabled().catch(() => "n/a");
  const delDisabled = await page.locator('button[aria-label="删除当前页面"]').isDisabled().catch(() => "n/a");
  console.log(tag, JSON.stringify({ tabs, saveDisabled, delDisabled }, null, 1));
};
await dump("初始:");
await sleep(8000);
await dump("8秒后:");
await browser.close();
console.log("console errors:", JSON.stringify(errs.slice(0, 5)));
