// U1-11: 实测场景对象面板搜索框与树行的真实盒模型，定位贴边根因。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForTimeout(3000);
await page.goto("http://127.0.0.1:5173/studio/d5395a30-4c29-4e8c-8bb0-b6b0d188c615", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(9000);
const probe = await page.evaluate(() => {
  const search = document.querySelector(".scene-organization-search");
  const row = document.querySelector(".scene-tree-row");
  const panel = document.querySelector(".scene-organization-panel");
  const manager = document.querySelector(".scene-tree-manager");
  const box = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), w: Math.round(r.width), margin: `${s.margin}`, padding: `${s.padding}`, display: s.display };
  };
  return { panel: box(panel), manager: box(manager), search: box(search), row: box(row), rowText: row?.textContent?.slice(0, 20) };
});
console.log(JSON.stringify(probe, null, 2));
await page.screenshot({ path: "test-output/nightly-2026-09-05/u111-outliner.png" });
await browser.close();
