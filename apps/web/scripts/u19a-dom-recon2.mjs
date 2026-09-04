import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForTimeout(3000);
// 从管理页拿真实的 2D 编辑器 URL
const editButton = page.locator(".scene-card-actions button[aria-label='编辑场景']").first();
await editButton.click();
await page.waitForTimeout(9000);
const dom = await page.evaluate(() => {
  const scrollers = [...document.querySelectorAll("*")].filter((el) => {
    const s = getComputedStyle(el);
    return (s.overflowY === "auto" || s.overflowY === "scroll" || s.overflowX === "auto" || s.overflowX === "scroll") && (el.scrollHeight > el.clientHeight + 4 || el.scrollWidth > el.clientWidth + 4);
  }).slice(0, 14).map((el) => ({ cls: String(el.className).slice(0, 60) || el.tagName, oy: getComputedStyle(el).overflowY, ox: getComputedStyle(el).overflowX, sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight }));
  const canvasish = [...document.querySelectorAll("[class*='canvas'], [class*='artboard']")].slice(0, 10).map((el) => `${el.tagName} ${String(el.className).slice(0, 60)}`);
  return { url: location.pathname, scrollers, canvasish };
});
console.log(JSON.stringify(dom, null, 2));
await browser.close();
