// EX-001A 右键选层验证：右键节点 → 菜单出现"选择"子区 → 点击被遮挡项选中。
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
  await page.goto("http://127.0.0.1:5173/manager", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await page.locator(".scene-card-actions button[aria-label='编辑场景']").first().click();
  await page.waitForTimeout(9000);
  const node = page.locator(".dashboard-node").first();
  const box = await node.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await page.waitForTimeout(400);
  out.menuOpen = await page.locator(".dashboard-context-menu").count() > 0;
  out.stackRows = await page.locator(".dashboard-context-stack > button").count();
  if (out.stackRows > 1) {
    await page.locator(".dashboard-context-stack > button").nth(1).click();
    await page.waitForTimeout(400);
    out.selectedAfterStackPick = await page.locator(".dashboard-node.selected").count();
  }
  await page.screenshot({ path: "test-output/nightly-2026-09-05/u118-stack-menu.png" }).catch(() => {});
} catch (error) { out.fatal = String(error).slice(0, 200); }
console.log(JSON.stringify(out, null, 2));
await browser.close();
