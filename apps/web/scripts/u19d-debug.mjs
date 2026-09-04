import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const apiCalls = [];
const out = {};
page.on("request", (req) => { if (req.url().includes("/api/") && req.method() === "POST" || req.method() === "PUT") apiCalls.push(`${req.method()} ${req.url().slice(-60)}`); });
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForTimeout(3000);
await page.goto("http://127.0.0.1:5173/studio/d5395a30-4c29-4e8c-8bb0-b6b0d188c615", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(9000);
// 检查保存按钮与点击后的消息
const saveBtn = page.locator("button", { hasText: "保存项目" }).first();
out.saveBtnCount = await saveBtn.count();
out.saveBtnDisabled = await saveBtn.isDisabled().catch(() => null);
await saveBtn.click({ timeout: 8000 }).catch((e) => { out.clickError = String(e).slice(0, 120); });
await page.waitForTimeout(4000);
out.message = await page.evaluate(() => {
  const toasts = [...document.querySelectorAll(".toast, [class*='message'], [class*='toast']")];
  return toasts.map((t) => t.textContent?.trim()).filter(Boolean).slice(0, 3);
});
out.apiCalls = apiCalls.slice(-5);
// 用单应用接口复查 thumbnail
out.doc = await page.evaluate(async () => {
  const token = Object.entries(localStorage).find(([k]) => /token|auth/i.test(k))?.[1];
  let bearer = null;
  try { bearer = JSON.parse(token)?.accessToken ?? token; } catch { bearer = token; }
  const headers = bearer ? { authorization: `Bearer ${bearer}` } : {};
  const appId = "d5395a30-4c29-4e8c-8bb0-b6b0d188c615";
  const project = (await fetch("/api/projects", { headers }).then((r) => r.json()))[0];
  const app = await fetch(`/api/projects/${project.id}/applications/${appId}`, { headers }).then((r) => r.json());
  const scenes = app?.scenes ?? [];
  return scenes.map((s) => ({ id: s.id, name: s.name, thumb: typeof s.thumbnail === "string" ? s.thumbnail.slice(0, 30) : null }));
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
