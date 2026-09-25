import pw from "../../../node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.js";

const browser = await pw.chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1781, height: 720 } });
await page.goto("http://localhost:5173/", { waitUntil: "load" });
// 登录
const user = page.locator('input[name="username"], input[type="text"]').first();
await user.fill("admin").catch(() => {});
const pass = page.locator('input[type="password"]').first();
if (await pass.count()) {
  await pass.fill("admin");
  await page.locator('button[type="submit"], button:has-text("登录")').first().click().catch(() => {});
  await page.waitForTimeout(1500);
}
await page.goto("http://localhost:5173/manager?project=38ea81ba-3033-4d3e-86b5-648fd58d98f1", { waitUntil: "load" });
await page.waitForTimeout(2000);
// 进入资源/工业预制体 tab
await page.locator('button:has-text("工业预制体")').first().click().catch(e => console.log("tab click:", e.message.slice(0, 80)));
await page.waitForTimeout(1200);
const m = await page.evaluate(() => {
  const out = { scrollW: document.scrollingElement.scrollWidth, innerW: window.innerWidth, offenders: [] };
  document.querySelectorAll("*").forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth + 1 && r.width > 40) out.offenders.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), right: Math.round(r.right), w: Math.round(r.width) });
  });
  out.offenders.sort((a, b) => b.right - a.right);
  out.offenders = out.offenders.slice(0, 8);
  return out;
});
console.log(JSON.stringify(m, null, 1));
await page.screenshot({ path: "D:/Documents/bim/bim-studio/test-output/glm-night-20260923/prefab-overflow.png" });
await browser.close();
