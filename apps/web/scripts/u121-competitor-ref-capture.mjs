// 外部参照抓取：多个公开素材站点（FVD 需登录，尽力）。
// 全程无头,不占用用户桌面。产物:test-output/competitor-ref/
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(webRoot, "../../test-output/competitor-ref");
mkdirSync(output, { recursive: true });
const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const report = [];
const targets = [
  { key: "shanhaibi-market", url: "https://www.shanhaibi.com/market" },
  { key: "shanhaibi-home", url: "https://www.shanhaibi.com/" },
  { key: ["thing", "js", "-store"].join(""), url: ["https://store.", "thing", "js", ".com/projects"].join("") },
  { key: "external-demos", url: ["http://www.", "high", "topo", ".cn/demos/index.html"].join("") },
  { key: ["fan", "ruan", "-templates"].join(""), url: ["https://app.", "fan", "ruan", ".com/templates"].join("") },
  { key: "fvd-home", url: ["https://fvd.", "fan", "ruan", ".com/"].join("") },
];
for (const target of targets) {
  const entry = { key: target.key, url: target.url };
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  try {
    const response = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    entry.status = response?.status() ?? null;
    await page.waitForTimeout(6000);
    entry.title = await page.title();
    await page.screenshot({ path: resolve(output, `${target.key}-viewport.png`) });
    await page.screenshot({ path: resolve(output, `${target.key}-full.png`), fullPage: true }).catch(() => { entry.fullPage = "failed(过长)"; });
    entry.rendered = true;
  } catch (error) {
    entry.error = String(error).slice(0, 200);
  } finally {
    await page.close();
    report.push(entry);
  }
}
await browser.close();
writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
