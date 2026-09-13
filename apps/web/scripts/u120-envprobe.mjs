import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded" });
await page.locator("input[aria-label=用户名]").waitFor({ timeout: 20000 });
await page.locator("input[aria-label=用户名]").fill("admin");
await page.locator("input[aria-label=密码]").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.locator(".scene-manager-page").waitFor({ timeout: 30000 });
await sleep(1200);
await page.locator('.scene-card button[aria-label="编辑场景"]').first().click();
await sleep(4000);
await page.locator('.workspace-mode-switch button:text-is("三维")').first().click();
await sleep(4500);
await page.locator('button[aria-label*="查看与分析"]').first().click();
await sleep(400);
await page.locator('[role=menuitem]:has-text("环境与灯光")').first().click();
await sleep(1200);
const info = await page.evaluate(() => {
  const btn = document.querySelector('button[aria-label*="关闭环境"]');
  if (!btn) return { found: false };
  const rect = btn.getBoundingClientRect();
  const cs = getComputedStyle(btn);
  const heading = btn.closest(".environment-heading");
  const hrect = heading?.getBoundingClientRect();
  const panel = btn.closest(".environment-control");
  const prect = panel?.getBoundingClientRect();
  return { found: true, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }, display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
    headingRect: hrect && { w: hrect.width, h: hrect.height }, panelRect: prect && { x: prect.x, y: prect.y, w: prect.width, h: prect.height } };
});
console.log(JSON.stringify(info, null, 2));
const clickResult = await page.evaluate(() => {
  const btn = document.querySelector('button[aria-label*="关闭环境"]');
  if (!btn) return { clicked: false, reason: "not found" };
  const before = Boolean(btn.closest(".environment-control"));
  btn.click();
  return { clicked: true };
});
await new Promise(r => setTimeout(r, 900));
const panelGone = await page.evaluate(() => !document.querySelector(".environment-control"));
console.log("js-click:", JSON.stringify({ clickResult, panelGone }));
await page.screenshot({ path: "test-output/ui-sweep-2026-09-12/probe-fix-env-close.png" });
// 真实鼠标点击验证(恢复面板后再点一次)
const hit = await page.evaluate(() => {
  const el = document.elementFromPoint(1090, 160);
  const chain = [];
  let cur = el;
  while (cur && chain.length < 4) { chain.push(cur.tagName + "." + (cur.className && cur.className.toString ? cur.className.toString().slice(0, 60) : "")); cur = cur.parentElement; }
  return { top: chain[0], chain };
});
console.log("elementFromPoint(1090,160) =", JSON.stringify(hit, null, 2));
// 重开面板后用真实鼠标点击 X,验证遮挡已解除
await page.locator('button[aria-label*="查看与分析"]').first().click();
await sleep(400);
await page.locator('[role=menuitem]:has-text("环境与灯光")').first().click();
await sleep(1000);
const hit2 = await page.evaluate(() => {
  const btn = document.querySelector('button[aria-label*="关闭环境"]');
  if (!btn) return { found: false };
  const r = btn.getBoundingClientRect();
  const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { found: true, coveredBy: top ? top.tagName + "." + (top.className?.toString?.().slice(0, 40) ?? "") : "none" };
});
console.log("reopen hit-test:", JSON.stringify(hit2));
try {
  await page.locator('button[aria-label*="关闭环境"]').first().click({ timeout: 5000 });
  await sleep(800);
  const gone = await page.evaluate(() => !document.querySelector(".environment-control"));
  console.log("real-mouse-click closed panel =", gone);
  await page.screenshot({ path: "test-output/ui-sweep-2026-09-12/probe-fix-env-closed.png" });
} catch (e) {
  console.log("real-mouse-click FAILED:", String(e?.message ?? e).slice(0, 200));
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
await browser.close();
