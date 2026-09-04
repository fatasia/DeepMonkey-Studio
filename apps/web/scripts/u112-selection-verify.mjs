// U1-13 验证：空白普通拖拽=框选（相交命中）、Shift 点选=加选、点空白=清空。
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
  const nodes = page.locator(".dashboard-node");
  out.nodeCount = await nodes.count();
  const boxes = [];
  for (let i = 0; i < out.nodeCount; i++) {
    const b = await nodes.nth(i).boundingBox();
    boxes.push(b);
  }
  out.boxes = boxes.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }));
  // 取所有节点的包围盒，构造一个能同时罩住两个节点的框选起点（左上外扩 40px）
  const minX = Math.min(...boxes.map((b) => b.x)) - 60;
  const minY = Math.min(...boxes.map((b) => b.y)) - 60;
  const maxX = Math.max(...boxes.map((b) => b.x + b.width)) + 60;
  const maxY = Math.max(...boxes.map((b) => b.y + b.height)) + 60;
  // 空白处普通拖拽框选（不按 Shift/Ctrl）
  await page.mouse.move(minX, minY);
  await page.mouse.down();
  await page.mouse.move(maxX, maxY, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  out.marqueeSelected = await page.locator(".dashboard-node.selected").count();
  await page.screenshot({ path: "test-output/nightly-2026-09-05/u112-marquee.png" });
  // Shift 点选加选：先点空白清空，再点节点 1，再 Shift 点节点 2
  await page.mouse.click(minX - 30, minY - 30);
  await page.waitForTimeout(200);
  out.afterEmptyClick = await page.locator(".dashboard-node.selected").count();
  await nodes.nth(0).click();
  await page.waitForTimeout(200);
  out.afterClickFirst = await page.locator(".dashboard-node.selected").count();
  await nodes.nth(1).click({ modifiers: ["Shift"] });
  await page.waitForTimeout(200);
  out.afterShiftClickSecond = await page.locator(".dashboard-node.selected").count();
  await page.screenshot({ path: "test-output/nightly-2026-09-05/u112-shift-add.png" });
} catch (error) {
  out.fatal = String(error).slice(0, 300);
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
