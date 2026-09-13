// 素材数量波次 A 截图验收:170 个新增预设逐卡特写(双主题)+ 分组整屏 + 20 抽样画布插入验证。
// 用法: node scripts/quantity-wave-a-shots.mjs [origin]
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { readFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const list = JSON.parse(readFileSync(join(root, "test-output/quantity-wave-a-presets.json"), "utf8"));

// 已有看板的 QA 项目/应用(只新增临时页面,不触碰既有页面数据)。
const PROJECT = "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
const APP = "8ad5ccd9-166a-436a-9934-1d433d82f4cf";
const PAGE = "page:8ad5ccd9-166a-436a-9934-1d433d82f4cf";
// 抽样 20:覆盖 value/gauge/liquid/progress/flip、gauge 构图变体、map 四形态、
// table/scroll-table、filter、decoration、boxplot/polarBar/waterfall/combo。
const SAMPLE = [
  "power-line-loss-kpi", "bed-occupancy-kpi", "tank-level-chem", "rescue-success-rate", "overdue-case-flip",
  "dual-needle-tachometer", "band-segment-pressure",
  "province-gdp-fill-map", "flight-flow-map", "road-density-map",
  "cross-subtotal-report", "threshold-tint-report", "rank-shift-scroll",
  "region-industry-cascade", "harmonic-combo", "arc-crown-frame", "radar-sweep-ring",
  "kline-candlestick", "wind-rose-polar", "attainment-waterfall",
];

for (const dir of ["closeups/dark", "closeups/light", "groups", "canvas"]) {
  mkdirSync(join(root, "test-output/quantity-wave-a", dir), { recursive: true });
}

const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1680, height: 950 }, deviceScaleFactor: 1 });

async function openWorkspace(theme) {
  const page = await context.newPage();
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(`${origin}/?theme=${theme}`, { waitUntil: "domcontentloaded" });
  const loginUser = page.locator('input[aria-label="用户名"]');
  try {
    await loginUser.waitFor({ state: "visible", timeout: 6000 });
    await loginUser.fill("admin");
    await page.locator('input[aria-label="密码"]').fill("admin");
    await page.locator('label.login-remember input').check().catch(() => {});
    await page.getByRole("button", { name: "登录" }).click();
    await page.waitForTimeout(1500);
  } catch { /* 已登录 */ }
  await page.goto(`${origin}/studio/${PROJECT}/applications/${APP}/pages/${encodeURIComponent(PAGE)}?theme=${theme}`, { waitUntil: "domcontentloaded" });
  await page.locator(".dashboard-pages-panel").waitFor({ state: "visible", timeout: 90000 });
  // 左面板默认停在“图层”页签,先切换到“资源”组件库。
  await page.getByRole("button", { name: "资源", exact: true }).click();
  await page.locator(".dashboard-library-search input").waitFor({ state: "visible", timeout: 30000 });
  await page.waitForTimeout(1500);
  return page;
}

const missing = [];
for (const theme of ["dark", "light"]) {
  const page = await openWorkspace(theme);
  for (const preset of list) {
    const input = page.locator(".dashboard-library-search input");
    await input.fill(preset.zh);
    const card = page.locator(`[data-preview-variant="${preset.id}"]`).locator("xpath=ancestor::button[1]");
    try {
      await card.waitFor({ state: "visible", timeout: 6000 });
      await card.screenshot({ path: join(root, `test-output/quantity-wave-a/closeups/${theme}/${preset.id}.png`) });
    } catch {
      missing.push(`${theme}/${preset.id}`);
      await input.fill("");
    }
  }
  // 分组整屏:无搜索逐 tab 截资源面板。
  await page.locator(".dashboard-library-search input").fill("");
  await page.waitForTimeout(600);
  for (const tabName of ["图表", "控件", "媒体", "3D", "资源"]) {
    const tab = page.getByRole("tab", { name: tabName });
    if (await tab.count()) {
      await tab.click().catch(() => {});
      await page.waitForTimeout(700);
      await page.locator(".dashboard-library-browser").screenshot({ path: join(root, `test-output/quantity-wave-a/groups/${theme}-${tabName}.png`) }).catch(() => {});
    }
  }
  await page.close();
}

// ── 抽样插入验证:新建临时页面 → 逐个点击插入并截图 → 删除临时页面。──
const page = await openWorkspace("dark");
await page.getByRole("button", { name: "新增空白页面" }).click();
await page.waitForTimeout(1200);
let index = 0;
const insertMissing = [];
for (const id of SAMPLE) {
  const preset = list.find((item) => item.id === id);
  const input = page.locator(".dashboard-library-search input");
  await input.fill(preset.zh);
  const card = page.locator(`[data-preview-variant="${id}"]`).locator("xpath=ancestor::button[1]");
  try {
    await card.waitFor({ state: "visible", timeout: 6000 });
    await card.click();
    await page.waitForTimeout(1000);
    index += 1;
    await page.screenshot({ path: join(root, `test-output/quantity-wave-a/canvas/${String(index).padStart(2, "0")}-${id}.png`) });
  } catch {
    insertMissing.push(id);
  }
  await input.fill("");
}
// 清理:删除临时页面(第 3 页及以后为新建页;直接逐次删除当前页,直到回到初始两页)。
const pageDelete = page.getByRole("button", { name: "删除当前页面" });
for (let guard = 0; guard < 4; guard += 1) {
  const disabled = await pageDelete.isDisabled().catch(() => true);
  if (disabled) break;
  await pageDelete.click();
  await page.waitForTimeout(900);
}
await page.close();
await browser.close();
console.log(JSON.stringify({ total: list.length, closeupMissing: missing, insertMissing }, null, 2));
