// 快速定位 OffscreenCanvas 回退原因:开发服务器 + 单用例探针(非正式门禁)。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const logs = [];
page.on("console", m => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", e => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${origin}/?__visualQa=viewer&renderer=webgl&objects=300&offscreen=on`, { waitUntil: "commit" });
await page.waitForFunction(() => window.__viewerQa?.ready || window.__viewerQa?.error, undefined, { timeout: 60000 });
await page.waitForTimeout(6000);
const state = await page.evaluate(() => window.__viewerQa);
console.log(JSON.stringify({ offscreen: state.offscreen, renderDemand: state.renderDemand, performance: { drawCalls: state.performance?.renderer?.drawCalls } }, null, 2));
console.log("--- console ---");
for (const line of logs.filter(l => /offscreen|worker|后台|error|Error/i.test(l)).slice(-25)) console.log(line);
await browser.close();
