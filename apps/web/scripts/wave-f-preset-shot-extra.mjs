// 波次 F 补拍(round1b):行业 KPI 三种 metric 构图 / 地图轨迹标注 / 装饰标题光效 / 报表汇总表,
// 以及"插入→属性面板按钮删除"的干净画布验证(v1 的 Delete 键在焦点位于搜索框时不生效)。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const output = resolve("test-output/quantity-wave-f/round1b");
mkdirSync(output, { recursive: true });

const groupShots = [
  ["kpi-yield", "良率"],
  ["kpi-flip", "翻牌"],
  ["kpi-pass", "合格率"],
  ["map-trajectory", "轨迹"],
  ["map-annotation", "标注地图"],
  ["deco-title", "标题条"],
  ["deco-light", "光带"],
  ["report-summary", "汇总表"],
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

const search = page.getByPlaceholder("搜索组件");
const canvasSel = [".dashboard-page-viewport", ".dashboard-workspace-canvas", ".dashboard-canvas", "main"].join(", ");
const results = { dark: [], light: [], insert: [], errors: errors.slice(0, 8) };

async function forceTheme(theme) {
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
  await page.waitForTimeout(700);
}

// ── 深色轮补拍 ───────────────────────────────────────────────────────────
await forceTheme("dark");
for (const [key, keyword] of groupShots) {
  await search.fill(keyword);
  await page.waitForTimeout(700);
  const group = page.locator(".dashboard-library-result-group").first();
  if (!(await group.count())) {
    results.dark.push({ key, ok: false, reason: "no-group" });
    continue;
  }
  await page.locator(".dashboard-library-browser").evaluate((el) => { el.scrollTop = 0; });
  await group.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  await group.screenshot({ path: resolve(output, `dark-${key}.png`) });
  results.dark.push({ key, ok: true });
}

// ── 插入→按钮删除 干净验证(深色 2 个 + 光主题 2 个)───────────────────────
const insertSamples = ["能耗分布箱线", "WAT 合格率", "故障词频词云", "成本构成瀑布"];
for (const [index, name] of insertSamples.entries()) {
  const theme = index < 2 ? "dark" : "light";
  await forceTheme(theme);
  await search.fill(name);
  await page.waitForTimeout(650);
  const card = page.locator(".dashboard-library-card", { hasText: name }).first();
  if (!(await card.count())) {
    results.insert.push({ name, theme, ok: false, reason: "no-card" });
    continue;
  }
  await card.click();
  await page.waitForTimeout(1600);
  await search.fill("");
  await page.waitForTimeout(400);
  await page.locator(canvasSel).first().screenshot({ path: resolve(output, `${theme}-insert-${index + 1}-${name}.png`) });
  // 属性面板的"删除组件"按钮:不依赖键盘焦点,删除后画布回到原状。
  const deleteButton = page.getByRole("button", { name: "删除组件" }).first();
  if (await deleteButton.count()) {
    await deleteButton.click();
    await page.waitForTimeout(600);
  }
  results.insert.push({ name, theme, ok: true, deleted: await deleteButton.count() > 0 });
}

// ── 光主题轮补拍 ─────────────────────────────────────────────────────────
await forceTheme("light");
for (const [key, keyword] of groupShots) {
  await search.fill(keyword);
  await page.waitForTimeout(700);
  const group = page.locator(".dashboard-library-result-group").first();
  if (!(await group.count())) continue;
  await page.locator(".dashboard-library-browser").evaluate((el) => { el.scrollTop = 0; });
  await group.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  await group.screenshot({ path: resolve(output, `light-${key}.png`) });
  results.light.push({ key, ok: true });
}
await search.fill("");
await forceTheme("dark");

console.log(JSON.stringify(results, null, 2));
await browser.close();
