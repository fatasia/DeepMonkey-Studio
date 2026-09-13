// 诊断:编辑器打开后左侧资源面板/模板按钮的实际 DOM 状态。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
if (await page.getByLabel("用户名").count()) {
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3000);
}
await page.getByRole("button", { name: "编辑场景" }).first().click();
await page.waitForTimeout(5000);
// 左面板切到"资源"tab(默认在"图层")
const resourceTab = page.getByRole("button", { name: /^资源$/ }).first();
if (await resourceTab.count()) await resourceTab.click();
await page.waitForTimeout(2500);
const state = await page.evaluate(() => ({
  url: location.href,
  hasLibraryButton: Boolean(document.querySelector(".dashboard-library-template-button")),
  bodyHasStudio: document.querySelector("[class*=studio]") !== null,
}));
console.log(JSON.stringify(state, null, 1));
// 若模板按钮在,点击打开模板库并三时点截图验证真渲染管线
if (state.hasLibraryButton) {
  await page.locator(".dashboard-library-template-button").first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "test-output/cover-real/t0-svg-first.png" });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: "test-output/cover-real/t1-mid.png" });
  await page.waitForTimeout(20000);
  await page.screenshot({ path: "test-output/cover-real/t2-settled.png" });
  // 插入第一个模板,验证画布带示例数据
  await page.locator('article button', { hasText: '插入当前页面' }).first().click();
  await page.waitForTimeout(4000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-output/cover-real/t3-inserted.png' });
  const inserted = await page.evaluate(() => {
    const canvasNodes = document.querySelectorAll('[class*=dashboard-canvas] [class*=widget], [class*=dashboard-canvas] canvas, [class*=dashboard-canvas] [class*=node]');
    const texts = (document.querySelector('[class*=dashboard-canvas]')?.textContent ?? '').slice(0, 160);
    return { nodeCount: canvasNodes.length, sampleText: texts };
  });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'test-output/cover-real/t4-inserted-settled.png' });
  const counts = await page.evaluate(() => {
    const root = document.querySelector(".dashboard-template-library") ?? document;
    const real = root.querySelectorAll("img[src^='data:image']").length;
    const svg = root.querySelectorAll("svg").length;
    return { realImages: real, svgCount: svg };
  });
  console.log(JSON.stringify(counts, null, 1));
}
await browser.close();
