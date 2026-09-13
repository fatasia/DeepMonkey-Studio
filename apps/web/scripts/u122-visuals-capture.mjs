// 抓取帆软视觉资源页(visuals)作为素材参照;无头运行,不占用户桌面。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
try {
  await page.goto("https://app.fanruan.com/visuals", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(6000);
  console.log("title:", await page.title());
  await page.screenshot({ path: "../../test-output/competitor-ref/fanruan-visuals-viewport.png" });
  await page.screenshot({ path: "../../test-output/competitor-ref/fanruan-visuals-full.png", fullPage: true }).catch(() => {});
  console.log("saved");
} catch (error) {
  console.error("ERR", String(error).slice(0, 300));
} finally {
  await browser.close();
}
