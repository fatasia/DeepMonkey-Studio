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
// 从页面 store 不可直接读；改从视觉 + DOM 推断：逐节点点击看选集数量，框选拖一个小框只罩一个节点再试
const nodes = page.locator(".dashboard-node");
const n = await nodes.count();
const report = [];
for (let i = 0; i < n; i++) {
  const b = await nodes.nth(i).boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(150);
  const selected = await page.locator(".dashboard-node.selected").count();
  report.push({ i, clickSelected: selected });
}
console.log(JSON.stringify({ n, report }, null, 2));
await browser.close();
