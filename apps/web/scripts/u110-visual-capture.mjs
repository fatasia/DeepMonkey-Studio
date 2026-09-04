// 慢速缩小过程连续截图：目视化抖动本体（滚动条明灭/画布缩放脉冲/位置跳变）。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { mkdirSync } from "node:fs";
const { chromium } = playwright;
const outDir = "test-output/nightly-2026-09-05/u110-frames";
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForTimeout(3000);
await page.locator(".scene-card-actions button[aria-label='编辑场景']").first().click();
await page.waitForTimeout(9000);
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(1500);
let idx = 0;
for (let w = 1440; w >= 1080; w -= 30) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${outDir}/f${String(idx).padStart(2, "0")}-w${w}.png` });
  idx += 1;
}
const state = await page.evaluate(() => {
  const el = document.querySelector(".dashboard-canvas-scroll");
  const ab = document.querySelector(".dashboard-artboard");
  return { scrollLeft: el.scrollLeft, scrollTop: el.scrollTop, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, artboardTransform: getComputedStyle(ab).transform.slice(0, 60), gutter: getComputedStyle(el).scrollbarGutter };
});
console.log(JSON.stringify(state, null, 2));
await browser.close();
