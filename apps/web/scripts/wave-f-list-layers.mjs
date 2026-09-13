// 只读核查 v2:精确列出当前场景图层面板全部节点名(.dashboard-layer-row)。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
if (await page.getByLabel("用户名").count()) {
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3000);
}
await page.getByRole("button", { name: "编辑场景" }).first().click();
await page.waitForTimeout(6000);
const names = await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".dashboard-layer-row")];
  return rows.map((row) => {
    const label = row.querySelector(".dashboard-layer-select span")?.textContent ?? "?";
    const locked = row.classList.contains("locked");
    return `${label}${locked ? " [locked]" : ""}`;
  });
});
console.log(JSON.stringify({ count: names.length, names }, null, 2));
await browser.close();
