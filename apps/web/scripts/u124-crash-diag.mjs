// 页面崩溃诊断:捕获 console/pageerror,定位 STUDIO_RENDER_FAILED 根因。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage();
const logs = [];
page.on("console", m => logs.push(`[${m.type()}] ${m.text().slice(0, 240)}`));
page.on("pageerror", e => logs.push(`[pageerror] ${String(e.stack || e.message).slice(0, 500)}`));
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(6000);
for (const line of logs.filter(l => /error|failed/i.test(l)).slice(-12)) console.log(line);
await browser.close();
