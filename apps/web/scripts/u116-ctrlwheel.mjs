// U1-10 终验：Ctrl+滚轮缩放到 10%（下限），逐帧采样 scroll 稳定性。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForTimeout(3000);
await page.goto("http://127.0.0.1:5173/manager", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);
await page.locator(".scene-card-actions button[aria-label='编辑场景']").first().click();
await page.waitForTimeout(9000);
const canvas = await page.locator(".dashboard-canvas-scroll").boundingBox();
const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2;
await page.mouse.move(cx, cy);
const sampler = page.evaluate((total) => new Promise((resolve) => {
  const el = document.querySelector(".dashboard-canvas-scroll");
  const frames = [];
  const start = performance.now();
  (function tick() {
    frames.push({ sl: Math.round(el.scrollLeft), st: Math.round(el.scrollTop) });
    if (performance.now() - start < total) requestAnimationFrame(tick); else resolve(frames);
  })();
}), 14000);
await page.keyboard.down("Control");
for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(300); }
await page.keyboard.up("Control");
await page.waitForTimeout(1500);
const frames = await sampler;
const sl = frames.map((f) => f.sl), st = frames.map((f) => f.st);
let reversals = 0, dir = 0;
for (let i = 1; i < sl.length; i++) { const d = Math.sign(sl[i] - sl[i - 1]); if (d !== 0 && dir !== 0 && d !== dir) reversals++; if (d !== 0) dir = d; }
const zoomText = await page.evaluate(() => document.querySelector(".dashboard-page-bar output")?.textContent ?? "");
console.log(JSON.stringify({ zoomText, frames: frames.length, slReversals: reversals, slRange: [Math.min(...sl), Math.max(...sl)], stRange: [Math.min(...st), Math.max(...st)] }, null, 2));
await page.screenshot({ path: "test-output/nightly-2026-09-05/u116-lowzoom-ctrl.png" });
await browser.close();
