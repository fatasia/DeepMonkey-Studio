// 临时诊断:液位瓷砖内部布局实测。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto("http://127.0.0.1:5173/?__visualQa=dashboard", { waitUntil: "load" });
await page.waitForTimeout(2500);
const library = page.locator(".dashboard-library-browser").first();
if (!(await library.isVisible().catch(() => false))) {
  for (const label of ["资源", "组件", "Assets"]) {
    const btn = page.locator(`button:has-text("${label}")`).first();
    if (await btn.isVisible().catch(() => false)) { await btn.click(); await page.waitForTimeout(700); break; }
  }
}
const info = await page.evaluate(() => {
  const el = document.querySelector(".dashboard-library-preview.liquid");
  if (!el) return "no liquid";
  const i = el.querySelector(":scope > i");
  const em = el.querySelector("em");
  const wave = el.querySelector(".wave");
  const cs = getComputedStyle(el);
  const rect = (r) => r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
  return {
    display: cs.display, placeItems: cs.placeItems, gridCols: cs.gridTemplateColumns,
    tile: rect(el.getBoundingClientRect()),
    i: rect(i?.getBoundingClientRect()),
    em: rect(em?.getBoundingClientRect()),
    emPos: em ? getComputedStyle(em).position : null,
    emInset: em ? getComputedStyle(em).inset : null,
    emWidth: em ? getComputedStyle(em).width : null,
    emDisplay: em ? getComputedStyle(em).display : null,
    emMaxWidth: em ? getComputedStyle(em).maxWidth : null,
    wavePos: wave ? getComputedStyle(wave).position : null,
  };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
