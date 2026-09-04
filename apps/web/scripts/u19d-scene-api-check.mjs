import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForTimeout(3000);
const check = await page.evaluate(async () => {
  const token = Object.entries(localStorage).find(([k]) => /token|auth/i.test(k))?.[1];
  let bearer = null;
  try { bearer = JSON.parse(token)?.accessToken ?? token; } catch { bearer = token; }
  const headers = bearer ? { authorization: `Bearer ${bearer}` } : {};
  const scenes = await fetch("/api/projects/38ea81ba-3033-4d3e-86b5-648fd58d98f1/scenes", { headers }).then((r) => r.json());
  const hit = scenes.find((s) => s.name === "678");
  return { total: scenes.length, target: hit ? { name: hit.name, hasThumbnail: typeof hit.thumbnail === "string", len: hit.thumbnail?.length ?? 0 } : null };
});
console.log(JSON.stringify(check, null, 2));
await browser.close();
