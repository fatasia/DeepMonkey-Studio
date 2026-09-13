// 清理 v3:精确匹配图层行名称(全等或"名称 数字"后缀)删除取证残留组件。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const PATTERN_SOURCE = "^(故障词频词云|能耗分布箱线|成本构成瀑布|时段占比极坐标|备用容量率指标卡|手术间利用率|WAT 合格率|晶圆产能利用率|县域经济钻取地图|综合管廊舱室地图|危化品运输轨迹地图|电路纹角框边框|彗尾流光带|占比交叉汇总表|省市级联筛选)( \d+)?$";

const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on("dialog", (dialog) => dialog.accept());
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

let removed = 0;
for (let round = 0; round < 80; round += 1) {
  const label = await page.evaluate((patternSource) => {
    const pattern = new RegExp(patternSource);
    for (const row of document.querySelectorAll(".dashboard-layer-row")) {
      const text = row.querySelector(".dashboard-layer-select span")?.textContent?.trim() ?? "";
      if (pattern.test(text) && !row.classList.contains("locked")) return text;
    }
    return null;
  }, PATTERN_SOURCE);
  if (!label) break;
  const row = page.locator(".dashboard-layer-row", { hasText: label }).first();
  await row.locator("button[aria-label='删除组件']").first().click();
  await page.waitForTimeout(600);
  removed += 1;
}
const layerCount = await page.evaluate(() => document.querySelectorAll(".dashboard-layer-row").length);
const remaining = await page.evaluate((patternSource) => {
  const pattern = new RegExp(patternSource);
  const left = [];
  for (const row of document.querySelectorAll(".dashboard-layer-row")) {
    const text = row.querySelector(".dashboard-layer-select span")?.textContent?.trim() ?? "";
    if (pattern.test(text)) left.push(text);
  }
  return left;
}, PATTERN_SOURCE);
console.log(JSON.stringify({ removed, layerCount, remaining }, null, 2));
await browser.close();
