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
await page.evaluate(() => {
  window.__trace = [];
  const scroller = document.querySelector(".dashboard-canvas-scroll");
  scroller.addEventListener("pointerdown", (e) => {
    window.__trace.push({ phase: "capture-bubble", btn: e.button, target: `${e.target.tagName}.${String(e.target.className).slice(0, 40)}`, onNode: Boolean(e.target.closest?.(".dashboard-node")) });
  }, true);
});
const scrollBox = await page.locator(".dashboard-canvas-scroll").boundingBox();
await page.mouse.move(scrollBox.x + 15, scrollBox.y + scrollBox.height - 30);
await page.mouse.down();
await page.mouse.move(scrollBox.x + scrollBox.width - 15, scrollBox.y + 15, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(300);
const trace = await page.evaluate(() => window.__trace);
const selected = await page.locator(".dashboard-node.selected").count();
console.log(JSON.stringify({ trace, selected }, null, 2));
await browser.close();
