import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const snap = async (label) => {
  const state = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme ?? "(none)",
    colorScheme: document.documentElement.style.colorScheme || "(none)",
  }));
  console.log(label, JSON.stringify(state));
};
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2000); await snap("after-goto");
if (await page.getByLabel("用户名").count()) {
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3000);
}
await snap("after-login");
await page.getByRole("button", { name: "编辑场景" }).first().click();
await page.waitForTimeout(5000); await snap("after-editor");
await browser.close();
