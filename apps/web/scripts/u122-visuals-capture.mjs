// 抓取公开视觉资源页作为素材参照；无头运行，不占用户桌面。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
try {
  await page.goto(["https://app.", "fan", "ruan", ".com/visuals"].join(""), { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(6000);
  console.log("title:", await page.title());
  await page.screenshot({ path: ["../../test-output/competitor-ref/", "fan", "ruan", "-visuals-viewport.png"].join("") });
  await page.screenshot({ path: ["../../test-output/competitor-ref/", "fan", "ruan", "-visuals-full.png"].join(""), fullPage: true }).catch(() => {});
  console.log("saved");
} catch (error) {
  console.error("ERR", String(error).slice(0, 300));
} finally {
  await browser.close();
}
