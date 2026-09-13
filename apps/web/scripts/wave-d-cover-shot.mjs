// 波次 D(示例数据行业语义)封面取证:按 12 个行业域搜索模板库,截第一张模板卡。
// 用法:node scripts/wave-d-cover-shot.mjs before|after
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const phase = process.argv[2] ?? "after";
// 每域抽 1 模板:搜索词取域 nameZh 的稳定前缀,保证第一张卡确定。
const domains = [
  ["power-trading", "电力交易"],
  ["healthcare", "医疗健康"],
  ["water", "水务运行"],
  ["cold-chain", "冷链物流"],
  ["transport", "交通枢纽"],
  ["tourism", "文化旅游"],
  ["government", "政务服务"],
  ["finance", "金融风控"],
  ["petrochemical", "石油化工"],
  ["agriculture", "农业生产"],
  ["semiconductor", "半导体"],
  ["expo", "会展活动"],
];

const output = resolve(`test-output/wave-d-sample-data/${phase}`);
mkdirSync(output, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
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
// 左侧面板切到"资源"标签,再点"行业模板"按钮打开模板库(搜索框在面板内)
await page.getByRole("button", { name: "资源", exact: true }).first().click();
await page.waitForTimeout(1500);
await page.locator(".dashboard-library-template-button").first().click();
await page.waitForTimeout(1200);
const searchBox = page.getByLabel("搜索模板、行业或标签");
await searchBox.click();
await page.waitForTimeout(500);

const results = [];
// 每域抽 2 个模板(executive + 第二视角):同域节律 + 不同模板种子,验证形状可辨的稳定性。
const PER_DOMAIN = 2;
for (const [domainId, keyword] of domains) {
  await searchBox.fill(keyword);
  await page.waitForTimeout(400);
  // 模板卡是无类名 article(封面 → 标题 → 标签);等真渲染封面 dataURL 或超时兜底。
  const cards = page.locator(".dashboard-template-grid article, .dashboard-template-row article");
  const count = await cards.count();
  if (!count) {
    results.push({ domainId, keyword, ok: false, reason: "no-card" });
    continue;
  }
  for (let slot = 0; slot < Math.min(PER_DOMAIN, count); slot++) {
    const card = cards.nth(slot);
    await card.scrollIntoViewIfNeeded().catch(() => {});
    const hasRealCover = await card.locator("img[src^='data:image']").waitFor({ state: "visible", timeout: 12000 }).then(() => true, () => false);
    await page.waitForTimeout(hasRealCover ? 800 : 3000);
    await card.screenshot({ path: resolve(output, `${domainId}-${slot + 1}.png`) });
    results.push({ domainId, slot: slot + 1, ok: true, realCover: hasRealCover });
  }
}
console.log(JSON.stringify({ phase, results, errors: errors.slice(0, 5) }, null, 2));
await browser.close();
