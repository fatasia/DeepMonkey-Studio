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
  const info = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    return { cls: String(el.className).slice(0, 40), tag: el.tagName, pos: s.position, z: s.zIndex, transform: s.transform !== "none" ? s.transform.slice(0, 40) : "none", contain: s.contain, isolation: s.isolation };
  };
  const btn = document.querySelector("button[title='更多视图工具']");
  const dock = btn?.closest(".tool-dock");
  const canvas = document.querySelector(".viewport canvas");
  const viewport = document.querySelector(".viewport");
  const dockOffsetParent = dock?.offsetParent;
  return {
    dock: info(dock), dockOffsetParent: info(dockOffsetParent), dockParentChain: (() => { const c = []; let el = dock?.parentElement; while (el && c.length < 5) { c.push(`${el.tagName}.${String(el.className).slice(0, 30)}`); el = el.parentElement; } return c; })(),
    canvas: info(canvas), canvasParentChain: (() => { const c = []; let el = canvas?.parentElement; while (el && c.length < 5) { c.push(`${el.tagName}.${String(el.className).slice(0, 30)}`); el = el.parentElement; } return c; })(),
    viewport: info(viewport),
    domOrder: (() => { const vp = viewport; if (!vp) return null; const kids = [...vp.children].map((k) => `${k.tagName}.${String(k.className).slice(0, 30)}`); return kids; })(),
  };
});
console.log(JSON.stringify(probe, null, 2));
await browser.close();
