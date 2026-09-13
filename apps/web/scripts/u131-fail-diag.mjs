// u131 附加:3 个失败模板的单独复现诊断(搜索定位 → 视口内等待渲染 → 抓 console 警告与就绪状态)。
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
page.on("console", (message) => { if (/templateCover|error|warn/i.test(message.type() + message.text())) warns.push(`[${message.type()}] ${message.text()}`.slice(0, 300)); });
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
await page.waitForTimeout(1000);

for (const title of targets) {
  warns.length = 0;
  const search = page.locator(".dashboard-template-search input");
  await search.fill("");
  await page.waitForTimeout(600);
  await search.fill(title);
  await page.waitForTimeout(1500);
  const state = await page.evaluate((name) => {
    const articles = [...document.querySelectorAll(".dashboard-template-grid article")];
    const article = articles.find((element) => element.querySelector("strong")?.textContent === name);
    if (!article) return { found: false };
    article.scrollIntoView({ block: "center" });
    const preview = article.querySelector(".dashboard-template-card-preview");
    return {
      found: true,
      hasPhoto: Boolean(preview?.querySelector("img.dashboard-template-cover-photo")),
      widgetTypes: [...(preview?.querySelectorAll("g[data-widget-type]") ?? [])].map((g) => g.getAttribute("data-widget-type")),
    };
  }, title);
  await page.waitForTimeout(12000); // 留足串行队列+渲染时间
  const after = await page.evaluate((name) => {
    const articles = [...document.querySelectorAll(".dashboard-template-grid article")];
    const article = articles.find((element) => element.querySelector("strong")?.textContent === name);
    const preview = article?.querySelector(".dashboard-template-card-preview");
    return {
      hasPhoto: Boolean(preview?.querySelector("img.dashboard-template-cover-photo")),
      chartHosts: preview ? null : null,
      perfTail: (window.__templateCoverPerf ?? []).slice(-2),
    };
  }, title);
  console.log(JSON.stringify({ title, ...state, after, warns: warns.slice(0, 6) }, null, 1));
}
await browser.close();
