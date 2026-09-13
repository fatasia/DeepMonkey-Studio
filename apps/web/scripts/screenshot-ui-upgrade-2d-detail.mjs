// 第 2 版:编辑器资源面板逐 tab + 滚动分组截图 + 代表卡片 3x 特写。
import fs from "node:fs";
import path from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const outDir = path.resolve("test-output/ui-upgrade-2d");
fs.mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });

async function openLibrary(theme) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(`${origin}/?__visualQa=dashboard&theme=${theme}`, { waitUntil: "load" });
  await page.waitForTimeout(2600);
  const library = page.locator(".dashboard-library-browser").first();
  if (!(await library.isVisible().catch(() => false))) {
    for (const label of ["资源", "组件", "Assets"]) {
      const btn = page.locator(`button:has-text("${label}")`).first();
      if (await btn.isVisible().catch(() => false)) { await btn.click(); await page.waitForTimeout(700); break; }
    }
  }
  return page;
}

const TABS = ["图表", "控件", "媒体", "3D", "资源"];

for (const theme of ["dark", "light"]) {
  const page = await openLibrary(theme);
  for (const tab of TABS) {
    const tabBtn = page.locator(`.dashboard-library-tabs button:has-text("${tab}")`).first();
    if (!(await tabBtn.isVisible().catch(() => false))) continue;
    await tabBtn.click();
    await page.waitForTimeout(600);
    // 滚动库列表,逐屏记录(最多 3 屏)。
    const scroller = page.locator(".dashboard-library-results").first();
    let shot = 0;
    for (let top = 0; shot < 3; shot++) {
      await scroller.evaluate((el, t) => { el.scrollTop = t; }, top).catch(() => {});
      await page.waitForTimeout(350);
      await page.locator(".dashboard-library-browser").first().screenshot({ path: path.join(outDir, `lib-${theme}-${tab}-${shot}.png`) });
      const next = await scroller.evaluate((el) => {
        const step = el.clientHeight;
        const max = el.scrollHeight - el.clientHeight;
        return el.scrollTop >= max - 4 ? -1 : Math.min(el.scrollTop + step, max);
      }).catch(() => -1);
      if (next === -1) break;
      top = next;
    }
  }
  // 代表卡片特写:柱状、环图、地图、KPI、装饰、媒体。
  const cardSamples = ["分组汇总表", "产品结构环图", "区域风险地图", "经营指标卡", "车间态势标题", "实时视频"];
  for (const name of cardSamples) {
    const card = page.locator(`.dashboard-library-card:has-text("${name}")`).first();
    if (await card.isVisible().catch(() => false)) {
      await card.scrollIntoViewIfNeeded().catch(() => {});
      await card.screenshot({ path: path.join(outDir, `card-${theme}-${name}.png`) }).catch(() => {});
    }
  }
  await page.close();
}

await browser.close();
console.log("done");
