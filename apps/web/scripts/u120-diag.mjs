import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
const errs = [];
page.on("console", m => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
page.on("pageerror", e => errs.push("pageerror: " + String(e.message).slice(0, 200)));
await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded" });
await sleep(6000);
console.log("url:", page.url());
console.log("has login input:", await page.locator("input[aria-label=用户名]").isVisible().catch(() => false));
console.log("has manager:", await page.locator(".scene-manager-page").isVisible().catch(() => false));
console.log("body text head:", (await page.locator("body").textContent()).slice(0, 200));
console.log("errors:", JSON.stringify(errs.slice(0, 6), null, 1));
await page.screenshot({ path: "test-output/ui-sweep-2026-09-12/diag-login.png" });
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
await browser.close();
