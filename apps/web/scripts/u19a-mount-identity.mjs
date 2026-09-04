import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
page.on("pageerror", (e) => errors.push(`PAGEERROR ${String(e).slice(0, 160)}`));
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForTimeout(3000);
await page.locator(".scene-card-actions button[aria-label='编辑场景']").first().click();
await page.waitForTimeout(9000);
// 记录节点身份：给滚动容器打标记，随窗口缩小逐步检查它是否还是同一个 DOM 节点
await page.evaluate(() => { document.querySelector(".dashboard-canvas-scroll").dataset.mountId = "M1"; });
const out = [];
for (let w = 1440; w >= 900; w -= 30) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(350);
  const identity = await page.evaluate(() => {
    const el = document.querySelector(".dashboard-canvas-scroll");
    if (!el) return { present: false };
    return { present: true, sameNode: el.dataset.mountId === "M1", scrollLeft: Math.round(el.scrollLeft) };
  });
  out.push({ w, ...identity });
}
console.log(JSON.stringify({ out, errors: errors.slice(0, 8) }, null, 2));
await browser.close();
