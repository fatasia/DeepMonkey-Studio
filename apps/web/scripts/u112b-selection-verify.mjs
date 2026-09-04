import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const out = {};
try {
  await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3000);
  await page.locator(".scene-card-actions button[aria-label='编辑场景']").first().click();
  await page.waitForTimeout(9000);
  const scrollBox = await page.locator(".dashboard-canvas-scroll").boundingBox();
  const nodes = page.locator(".dashboard-node");
  out.nodeCount = await nodes.count();
  // 普通拖拽框选：起点在画布左上角空白区（stage 边距），拖到覆盖全部组件
  const sx = scrollBox.x + 15, sy = scrollBox.y + scrollBox.height - 30;
  const ex = scrollBox.x + scrollBox.width - 15, ey = scrollBox.y + 15;
  // 从左下拖到右上（画布坐标换算由应用处理）
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 30, sy - 10, { steps: 5 });
  await page.mouse.move(ex, ey, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  out.marqueeSelected = await page.locator(".dashboard-node.selected").count();
  await page.screenshot({ path: "test-output/nightly-2026-09-05/u112b-marquee.png" });
  // 点击空白清空
  await page.mouse.click(scrollBox.x + 45, scrollBox.y + scrollBox.height - 45);
  await page.waitForTimeout(200);
  out.afterEmptyClick = await page.locator(".dashboard-node.selected").count();
  // Shift 点选加选：从空选开始，Shift 逐个点两个不同节点
  const b0 = await nodes.nth(0).boundingBox();
  const b1 = await nodes.nth(1).boundingBox();
  await page.mouse.click(b0.x + b0.width / 2, b0.y + b0.height / 2, { modifiers: ["Shift"] });
  await page.waitForTimeout(200);
  const afterFirst = await page.locator(".dashboard-node.selected").count();
  await page.mouse.click(b1.x + b1.width / 2, b1.y + b1.height / 2, { modifiers: ["Shift"] });
  await page.waitForTimeout(200);
  const afterSecond = await page.locator(".dashboard-node.selected").count();
  out.shiftSelect = { afterFirst, afterSecond };
  await page.screenshot({ path: "test-output/nightly-2026-09-05/u112b-shift.png" });
} catch (error) {
  out.fatal = String(error).slice(0, 300);
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
