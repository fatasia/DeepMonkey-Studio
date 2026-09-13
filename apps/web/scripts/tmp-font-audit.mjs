// frame 外二级页 chrome 字号实测：<11px 即违例（画布内用户作品与编辑器 frame 内由基线兜底，不审计）。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForTimeout(3000);
const routes = [["manager", "/manager"], ["data", "/data"], ["vision", "/vision"], ["operations", "/operations"], ["docs", "/docs"], ["system", "/system"], ["branding", "/branding"]];
const report = {};
for (const [name, path] of routes) {
  await page.goto("http://127.0.0.1:5173" + path, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const small = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll("button, label, select, output, th, td")) {
      if (!el.offsetParent) continue;
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize);
      if (size < 11) bad.push({ tag: el.tagName.toLowerCase(), size, text: (el.textContent ?? "").trim().slice(0, 18), cls: String(el.className).slice(0, 40) });
    }
    return bad;
  });
  report[name] = { count: small.length, sample: small.slice(0, 6) };
}
console.log(JSON.stringify(report, null, 1));
await browser.close();
