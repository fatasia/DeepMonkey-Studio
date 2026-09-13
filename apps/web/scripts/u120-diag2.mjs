import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
const errs = [];
page.on("console", m => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
page.on("pageerror", e => errs.push("pageerror: " + String(e.message).slice(0, 160)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded" });
await page.locator("input[aria-label=用户名]").waitFor({ timeout: 20000 });
await page.locator("input[aria-label=用户名]").fill("admin");
await page.locator("input[aria-label=密码]").fill("admin");
const [resp] = await Promise.all([
  page.waitForResponse(r => r.url().includes("/api/auth/login"), { timeout: 15000 }).catch(() => null),
  page.getByRole("button", { name: "登录" }).click(),
]);
console.log("login response:", resp ? resp.status() : "none");
await sleep(4000);
console.log("manager visible:", await page.locator(".scene-manager-page").isVisible().catch(() => false));
console.log("alert:", await page.locator("em[role=alert]").textContent().catch(() => "none"));
console.log("url:", page.url());
console.log("errors:", JSON.stringify(errs.slice(0, 8), null, 1));
await page.screenshot({ path: "test-output/ui-sweep-2026-09-12/diag-login2.png" });
await browser.close();
