// 波次 F(素材数量 420→520)视觉取证 v2:资源面板新预设分组逐组截图 + 抽样 15 个插入画布,双主题。
// 用法:node scripts/wave-f-preset-shot.mjs round1|round2
// v2 修正:① admin 品牌偏好持久化为 light,开场先强制 data-theme=dark 保证"深色轮"真实;
//          ② 插入的组件默认都落在 (76,76) 层叠,改为"插一个→截图→删除→再插下一个"。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const phase = process.argv[2] ?? "round1";
const output = resolve(`test-output/quantity-wave-f/${phase}`);
mkdirSync(output, { recursive: true });

// 家族关键词 → 分组截图(搜索命中该家族全部新预设卡片)。
const familyShots = [
  ["wordcloud", "词云族", "词云"],
  ["boxplot", "箱线族", "箱线"],
  ["waterfall", "瀑布族", "瀑布"],
  ["polarBar-group", "极坐标族", "极坐标"],
  ["industry-f", "行业KPI补深", "备用容量率"],
  ["map-drill", "地图钻取", "钻取地图"],
  ["map-pipe", "地图管廊轨迹", "管廊"],
  ["deco-f", "装饰造型", "边框"],
  ["report-f", "报表变体", "交叉表"],
  ["control-f", "控件变体", "级联"],
];

// 抽样 15 个新预设:点击插入画布,截真实运行时渲染后删除。
const samples = [
  "故障词频词云", "能耗分布箱线", "成本构成瀑布", "时段占比极坐标",
  "备用容量率指标卡", "手术间利用率", "WAT 合格率", "晶圆产能利用率",
  "县域经济钻取地图", "综合管廊舱室地图", "危化品运输轨迹地图",
  "电路纹角框边框", "彗尾流光带", "占比交叉汇总表", "省市级联筛选",
];

const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
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
await page.getByRole("button", { name: "资源", exact: true }).first().click();
await page.waitForTimeout(1500);
// 强制深色主题:admin 偏好持久化为 light,不强制则"深色轮"失真。
await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
await page.waitForTimeout(800);

const search = page.getByPlaceholder("搜索组件");
const canvasSel = [".dashboard-page-viewport", ".dashboard-workspace-canvas", ".dashboard-canvas", "main"].join(", ");
const results = { families: [], samples: [], light: [], errors: errors.slice(0, 8) };

// ── 深色轮:家族分组截图 ─────────────────────────────────────────────────
for (const [key, label, keyword] of familyShots) {
  await search.fill(keyword);
  await page.waitForTimeout(700);
  const group = page.locator(".dashboard-library-result-group").first();
  if (!(await group.count())) {
    results.families.push({ key, label, ok: false, reason: "no-group" });
    continue;
  }
  await group.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  await group.screenshot({ path: resolve(output, `dark-family-${key}.png`) });
  results.families.push({ key, label, ok: true });
}
await search.fill("");
await page.waitForTimeout(500);

// ── 深色轮:抽样插入画布(插一个截一张删一个,避免默认坐标层叠)───────────
for (const [index, name] of samples.entries()) {
  try {
    await search.fill(name);
    await page.waitForTimeout(650);
    const card = page.locator(".dashboard-library-card", { hasText: name }).first();
    if (!(await card.count())) {
      results.samples.push({ name, ok: false, reason: "no-card" });
      continue;
    }
    await card.click();
    await page.waitForTimeout(1600);
    await search.fill("");
    await page.waitForTimeout(400);
    await page.locator(canvasSel).first().screenshot({ path: resolve(output, `dark-insert-${String(index + 1).padStart(2, "0")}-${name}.png`) });
    await page.keyboard.press("Delete");
    await page.waitForTimeout(600);
    results.samples.push({ name, ok: true });
  } catch (error) {
    results.samples.push({ name, ok: false, reason: String(error).slice(0, 120) });
  }
}

// ── 光主题轮:4 个核心族 + 2 个代表组件插入画布 ──────────────────────────
await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
await page.waitForTimeout(900);
for (const [key, , keyword] of familyShots.slice(0, 4)) {
  await search.fill(keyword);
  await page.waitForTimeout(700);
  const group = page.locator(".dashboard-library-result-group").first();
  if (!(await group.count())) continue;
  await group.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  await group.screenshot({ path: resolve(output, `light-family-${key}.png`) });
  results.light.push({ key, ok: true });
}
await search.fill("");
for (const [index, name] of ["故障词频词云", "能耗分布箱线"].entries()) {
  await search.fill(name);
  await page.waitForTimeout(650);
  const card = page.locator(".dashboard-library-card", { hasText: name }).first();
  if (!(await card.count())) continue;
  await card.click();
  await page.waitForTimeout(1600);
  await search.fill("");
  await page.waitForTimeout(400);
  await page.locator(canvasSel).first().screenshot({ path: resolve(output, `light-insert-${index + 1}-${name}.png`) });
  await page.keyboard.press("Delete");
  await page.waitForTimeout(500);
}
await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });

console.log(JSON.stringify(results, null, 2));
await browser.close();
