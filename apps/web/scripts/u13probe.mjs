import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForTimeout(3000);
await page.goto("http://127.0.0.1:5173/published/d5395a30-4c29-4e8c-8bb0-b6b0d188c615", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(10000);
const probe = await page.evaluate(async () => {
  const btn = document.querySelector("button[title='更多视图工具']");
  if (!btn) return { found: false };
  const rects = [];
  const start = performance.now();
  while (performance.now() - start < 1200) {
    const r = btn.getBoundingClientRect();
    rects.push(`${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}`);
    await new Promise((r2) => requestAnimationFrame(r2));
  }
  const unique = [...new Set(rects)];
  const dock = btn.closest(".tool-dock");
  const dockRects = [];
  const start2 = performance.now();
  if (dock) {
    while (performance.now() - start2 < 600) {
      const r = dock.getBoundingClientRect();
      dockRects.push(`${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}`);
      await new Promise((r2) => requestAnimationFrame(r2));
    }
  }
  return { found: true, uniqueRects: unique.slice(0, 8), total: rects.length, dockUnique: [...new Set(dockRects)].slice(0, 5), itemDisplay: getComputedStyle(btn.parentElement).display, dockClass: dock?.className };
});
console.log(JSON.stringify(probe, null, 2));
await browser.close();
