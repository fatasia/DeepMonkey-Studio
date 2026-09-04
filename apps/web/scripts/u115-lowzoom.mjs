// U1-10b: 滚轮缩放到 30% 以下，逐帧采样 scrollLeft/scrollTop 翻转与选中状态。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForTimeout(3000);
await page.locator(".scene-card-actions button[aria-label='编辑场景']").first().click();
await page.waitForTimeout(9000);
const canvas = await page.locator(".dashboard-canvas-scroll").boundingBox();
const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2;
await page.mouse.move(cx, cy);
// 滚轮缩小 22 次（约 0.43 → 0.10 下限）
const sampler = page.evaluate((total) => new Promise((resolve) => {
  const el = document.querySelector(".dashboard-canvas-scroll");
  const frames = [];
  const start = performance.now();
  (function tick() {
    frames.push({ sl: el.scrollLeft, st: el.scrollTop, cw: el.clientWidth });
    if (performance.now() - start < total) requestAnimationFrame(tick); else resolve(frames);
  })();
}), 7000);
for (let i = 0; i < 22; i++) { await page.mouse.wheel(0, 240); await page.waitForTimeout(280); }
const frames = await sampler;
const sl = frames.map((f) => f.sl), st = frames.map((f) => f.st);
let slReversals = 0, dir = 0;
for (let i = 1; i < sl.length; i++) { const d = Math.sign(sl[i] - sl[i - 1]); if (d !== 0 && dir !== 0 && d !== dir) slReversals++; if (d !== 0) dir = d; }
const zoomText = await page.evaluate(() => document.querySelector(".dashboard-page-bar output")?.textContent ?? "");
console.log(JSON.stringify({ zoomText, frames: frames.length, slReversals, slUnique: [...new Set(sl)].slice(0, 8), stUnique: [...new Set(st)].slice(0, 5) }, null, 2));
await page.screenshot({ path: "test-output/nightly-2026-09-05/u115-lowzoom.png" });
await browser.close();
