import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const out = { checks: [] };
function check(name, data) { out.checks.push({ name, ...data }); }
try {
  await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3000);

  // Bug 1 验证：3D 工作台"更多"弹层命中测试
  await page.goto("http://127.0.0.1:5173/studio/d5395a30-4c29-4e8c-8bb0-b6b0d188c615", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(9000);
  const wsMore = page.locator(".scene-workspace-more").first();
  if (await wsMore.count() > 0) {
    await wsMore.locator("summary").first().click();
    await page.waitForTimeout(500);
    const hit = await page.locator(".scene-workspace-more-popover").first().evaluate((menu) => {
      const r = menu.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(30, r.height / 2));
      return { inMenu: top ? menu.contains(top) : false, hit: top ? `${top.tagName}.${String(top.className).slice(0, 30)}` : "null" };
    });
    // 真实点击菜单内的"导入场景"按钮验证可点
    let clickOk = null;
    const importBtn = page.locator(".scene-workspace-more-popover button", { hasText: "导入场景" }).first();
    if (await importBtn.count() > 0) {
      await importBtn.click({ timeout: 5000 }).then(() => { clickOk = true; }).catch((e) => { clickOk = String(e).slice(0, 80); });
    }
    check("studio3d-more-popover", { ...hit, importClickOk: clickOk });
    await page.screenshot({ path: "test-output/nightly-2026-09-05/u13-fix-studio3d.png" }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
  }

  // Bug 2 验证：发布页 dock 位置与"更多视图工具"可点
  await page.goto("http://127.0.0.1:5173/published/d5395a30-4c29-4e8c-8bb0-b6b0d188c615", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(9000);
  const dock = await page.evaluate(() => {
    const btn = document.querySelector("button[title='更多视图工具']");
    if (!btn) return { found: false };
    const dockEl = btn.closest(".tool-dock");
    const r = dockEl.getBoundingClientRect();
    return { found: true, dockY: Math.round(r.y), dockHeight: Math.round(r.height), viewportH: innerHeight, nearBottom: r.bottom <= innerHeight && r.bottom > innerHeight - 120 };
  });
  check("published-dock-position", dock);
  if (dock.found) {
    // 若工具条收起，先点展开开关
    const collapsed = await page.evaluate(() => document.querySelector(".tool-dock")?.classList.contains("collapsed"));
    if (collapsed) { await page.locator(".viewer-tool-toggle").first().click(); await page.waitForTimeout(500); }
    const more = page.locator("button[title='更多视图工具']").first();
    await more.click({ timeout: 5000 });
    await page.waitForTimeout(500);
    const moreOpen = await page.evaluate(() => {
      const panel = document.querySelector(".viewer-tool-more");
      if (!panel) return { found: false };
      const r = panel.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { found: true, visible: r.height > 0, hitInPanel: top ? panel.contains(top) : false, occludedBy: top ? `${top.tagName}.${String(top.className).slice(0, 30)}` : "null" };
    });
    check("published-more-panel", moreOpen);
    await page.screenshot({ path: "test-output/nightly-2026-09-05/u13-fix-published.png" }).catch(() => {});
  }
} catch (error) {
  out.fatal = String(error).slice(0, 300);
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
