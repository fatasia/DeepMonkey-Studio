// 全量页面与交互巡检：全部平台路由 × 控制台错误 × 横向溢出 × 关键交互点击。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const origin = "http://127.0.0.1:5173";
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push({ page: page.url().slice(-40), text: m.text().slice(0, 140) }); });
page.on("pageerror", (e) => errors.push({ page: page.url().slice(-40), text: `PAGEERROR ${String(e).slice(0, 140)}` }));
const results = [];
async function auditRoute(path, name, interactions = []) {
  await page.goto(origin + path, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const audit = await page.evaluate(() => {
    const overflowX = document.documentElement.scrollWidth > innerWidth + 2;
    const deadLinks = [...document.querySelectorAll("button")].filter((b) => b.offsetParent && !b.disabled && getComputedStyle(b).pointerEvents !== "none").length;
    return { overflowX, interactiveButtons: deadLinks };
  });
  for (const sel of interactions) {
    try { const el = page.locator(sel).first(); if (await el.count() > 0) { await el.click({ timeout: 3000 }); await page.waitForTimeout(400); } } catch {}
  }
  const after = await page.evaluate(() => ({ overflowX: document.documentElement.scrollWidth > innerWidth + 2 }));
  results.push({ path, name, ...audit, afterInteractionOverflow: after.overflowX });
  await page.screenshot({ path: `test-output/nightly-2026-09-08/u117${path.replace(/\W/g, "_")}.png` }).catch(() => {});
}
await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForTimeout(3000);
await auditRoute("/manager", "场景管理", [".scene-card-more > summary", "button[aria-label='预览场景']"]);
await auditRoute("/data", "数据中心", [".data-center-tab:nth-child(2)", ".data-center-tab:nth-child(3)"]);
await auditRoute("/vision", "视觉中心");
await auditRoute("/operations", "智能运营", ["button:has-text('虚拟调试')"]);
await auditRoute("/optimizer", "模型优化");
await auditRoute("/docs", "文档中心", [".docs-center nav a"]);
await auditRoute("/system", "系统管理");
const sceneId = "d5395a30-4c29-4e8c-8bb0-b6b0d188c615";
await auditRoute(`/studio/${sceneId}`, "3D编辑器", [".scene-tool-dock button", "summary[aria-label='更多场景工具']"]);
await auditRoute(`/view/${sceneId}`, "只读浏览");
await auditRoute(`/published/${sceneId}`, "发布浏览", ["button[title='更多视图工具']"]);
const consoleSummary = {};
for (const e of errors) consoleSummary[e.page] = (consoleSummary[e.page] ?? 0) + 1;
console.log(JSON.stringify({ routes: results, consoleErrorPages: consoleSummary, totalConsoleErrors: errors.length }, null, 2));
await browser.close();
