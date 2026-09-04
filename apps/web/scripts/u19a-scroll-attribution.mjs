// 给滚动容器 setter 埋点，抓取 sweep 期间每次 scroll 写入的调用栈。
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
// 安装 setter 追踪
await page.evaluate(() => {
  const el = document.querySelector(".dashboard-canvas-scroll");
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, "scrollLeft");
  window.__writes = [];
  Object.defineProperty(el, "scrollLeft", {
    get() { return desc.get.call(this); },
    set(v) {
      const stack = new Error().stack.split("\n").slice(2, 5).join(" | ").replace(/\s+/g, " ").slice(0, 220);
      window.__writes.push({ v: Math.round(v), stack });
      desc.set.call(this, v);
    },
  });
});
const sweep = [];
for (let w = 900; w <= 1440; w += 20) sweep.push(w);
await page.setViewportSize({ width: 900, height: 900 });
await page.waitForTimeout(500);
const sampler = page.evaluate((total) => new Promise((resolve) => {
  const start = performance.now();
  const samples = [];
  (function tick() {
    const el = document.querySelector(".dashboard-canvas-scroll");
    samples.push(el.scrollLeft);
    if (performance.now() - start < total) requestAnimationFrame(tick); else resolve(samples);
  })();
}), sweep.length * 45 + 1500);
for (const w of sweep) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(45); }
await page.waitForTimeout(1500);
const samples = await sampler;
const writes = await page.evaluate(() => window.__writes.slice(0, 12));
const uniq = [...new Set(samples.map((v) => Math.round(v)))];
console.log(JSON.stringify({ distinctScrollLeft: uniq, samplesN: samples.length, writes }, null, 2));
await browser.close();
