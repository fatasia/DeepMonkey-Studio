import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForTimeout(3000);
await page.goto("http://127.0.0.1:5173/published/d5395a30-4c29-4e8c-8bb0-b6b0d188c615", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(10000);
const probe = await page.evaluate(() => {
  const btn = document.querySelector("button[title='更多视图工具']");
  const r = btn.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const chain = [];
  let el = document.elementFromPoint(cx, cy);
  while (el && chain.length < 6) { chain.push(`${el.tagName}.${String(el.className).slice(0, 40)}`); el = el.parentElement; }
  const overlays = [];
  for (const candidate of document.querySelectorAll(".dialog-backdrop, .published-load-state, [class*='overlay'], [class*='backdrop'], [class*='gate'], [class*='toast']")) {
    const s = getComputedStyle(candidate);
    if (s.display !== "none" && s.visibility !== "hidden" && s.pointerEvents !== "none") {
      const cr = candidate.getBoundingClientRect();
      if (cr.width > 0) overlays.push({ cls: String(candidate.className).slice(0, 60), rect: `${Math.round(cr.x)},${Math.round(cr.y)},${Math.round(cr.width)}x${Math.round(cr.height)}`, pointerEvents: s.pointerEvents, zIndex: s.zIndex });
    }
  }
  return { chain, overlays };
});
console.log(JSON.stringify(probe, null, 2));
await browser.close();
