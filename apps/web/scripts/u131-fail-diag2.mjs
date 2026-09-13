// u131 附加二:全量队列条件下复现 3 个固定失败模板(不搜索,滚动到位 → 抓超时 warn 与现场)。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const targets = [
  "能源效率分析 · 运行调度",
  "能源效率分析 · 资产与设备",
  "供应链物流中心 · 经营总览",
];

const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const warns = [];
page.on("console", (message) => { if (message.text().includes("templateCover")) warns.push(message.text().slice(0, 300)); });
page.on("pageerror", (error) => warns.push(`[pageerror] ${String(error?.message ?? error).slice(0, 300)}`));

await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
if (await page.getByLabel("用户名").count()) {
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3000);
}
await page.getByRole("button", { name: "编辑场景" }).first().click();
await page.waitForTimeout(5000);
const resourceTab = page.getByRole("button", { name: /^资源$/ }).first();
if (await resourceTab.count()) await resourceTab.click();
await page.waitForTimeout(2500);
await page.locator(".dashboard-library-template-button").first().click();
await page.locator(".dashboard-template-grid article").first().waitFor({ timeout: 30000 });
await page.waitForTimeout(2000); // 首屏队列开始消化

for (const title of targets) {
  warns.length = 0;
  // 滚动到目标卡(全量列表,不搜索),等待其入队+串行渲染
  await page.evaluate((name) => {
    const articles = [...document.querySelectorAll(".dashboard-template-grid article")];
    const article = articles.find((element) => element.querySelector("strong")?.textContent === name);
    article?.scrollIntoView({ block: "center" });
  }, title);
  await page.waitForTimeout(60000);
  const state = await page.evaluate((name) => {
    const articles = [...document.querySelectorAll(".dashboard-template-grid article")];
    const article = articles.find((element) => element.querySelector("strong")?.textContent === name);
    const preview = article?.querySelector(".dashboard-template-card-preview");
    return {
      hasPhoto: Boolean(preview?.querySelector("img.dashboard-template-cover-photo")),
      chartHosts: preview ? [...preview.querySelectorAll("g[data-widget-type]")].map((g) => g.getAttribute("data-widget-type")) : [],
      perfHasIt: (window.__templateCoverPerf ?? []).some((row) => name.includes(row.templateId) || (row.templateId ?? "").length > 0 && JSON.stringify(row).length < 200 && false) || (window.__templateCoverPerf ?? []).length,
    };
  }, title);
  console.log(JSON.stringify({ title, ...state, warns: warns.slice(0, 8) }, null, 1));
}
await browser.close();
