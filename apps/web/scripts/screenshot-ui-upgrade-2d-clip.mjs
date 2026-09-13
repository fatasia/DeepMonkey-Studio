// 第 3 版:viewport clip 截取资源面板可视区,保证 1:1 细节可辨。
import fs from "node:fs";
import path from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const outDir = path.resolve("test-output/ui-upgrade-2d");
fs.mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });

async function openLibrary(theme) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
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

async function clipPanel(page, name, theme) {
  const box = await page.locator(".dashboard-library-browser").first().boundingBox().catch(() => null);
  const x = Math.max(0, (box?.x ?? 0) - 6);
  await page.screenshot({
    path: path.join(outDir, `${name}-${theme}.png`),
    clip: { x, y: 40, width: Math.min(300, (box?.width ?? 260) + 12), height: 900 },
  });
}

for (const theme of ["dark", "light"]) {
  const page = await openLibrary(theme);
  const plan = [["图表", 3], ["资源", 2], ["媒体", 1], ["控件", 1]];
  for (const [tab, screens] of plan) {
    const tabBtn = page.locator(`.dashboard-library-tabs button:has-text("${tab}")`).first();
    if (!(await tabBtn.isVisible().catch(() => false))) continue;
    await tabBtn.click();
    await page.waitForTimeout(500);
    const scroller = page.locator(".dashboard-library-results").first();
    for (let i = 0; i < screens; i++) {
      await scroller.evaluate((el, k) => { el.scrollTop = k * el.clientHeight; }, i).catch(() => {});
      await page.waitForTimeout(320);
      await clipPanel(page, `panel-${tab}-${i}`, theme);
    }
  }
  await page.close();
}
await browser.close();
console.log("done");
