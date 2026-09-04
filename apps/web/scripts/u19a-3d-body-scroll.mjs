import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 140)); });
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForTimeout(3000);
await page.goto("http://127.0.0.1:5173/studio/d5395a30-4c29-4e8c-8bb0-b6b0d188c615", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(9000);
await page.evaluate(() => { window.scrollTo(0, 0); document.documentElement.dataset.top = String(document.documentElement.scrollTop); });
const out = [];
for (const w of [1440, 1280, 1120, 980, 900, 980, 1120, 1280, 1440]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(1200);
  const s = await page.evaluate(() => {
    const canvas = document.querySelector(".viewport canvas");
    const cr = canvas?.getBoundingClientRect();
    return {
      bodyScrollY: Math.round(window.scrollY),
      docScrollHeight: document.documentElement.scrollHeight,
      winInnerH: innerHeight,
      pageOverflow: document.documentElement.scrollHeight > innerHeight,
      canvasSize: cr ? `${Math.round(cr.width)}x${Math.round(cr.height)}` : null,
      canvasBehindUi: (() => { const el = document.elementFromPoint(innerWidth / 2, innerHeight - 30); return el ? `${el.tagName}.${String(el.className).slice(0, 30)}` : "null"; })(),
    };
  });
  out.push({ w, ...s });
}
console.log(JSON.stringify({ out, errors: errors.slice(0, 6) }, null, 2));
await browser.close();
