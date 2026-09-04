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
const scrollBox = await page.locator(".dashboard-canvas-scroll").boundingBox();
// 拖拽过程中检查框选矩形元素是否出现
const dragPromise = (async () => {
  await page.mouse.move(scrollBox.x + 15, scrollBox.y + scrollBox.height - 30);
  await page.mouse.down();
  await page.mouse.move(scrollBox.x + scrollBox.width - 15, scrollBox.y + 15, { steps: 20 });
  const during = await page.evaluate(() => {
    const el = document.querySelector("[class*='selection-rect'], [class*='marquee']");
    return el ? { cls: String(el.className).slice(0, 50), rect: (() => { const r = el.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; })() } : null;
  });
  await page.mouse.up();
  return during;
})();
const during = await dragPromise;
await page.waitForTimeout(300);
const after = await page.locator(".dashboard-node.selected").count();
console.log(JSON.stringify({ duringMarqueeDrag: during, selectedAfter: after }, null, 2));
await browser.close();
