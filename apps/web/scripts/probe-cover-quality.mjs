// 封面质量视觉闭环探针:抽样 ≥18 域 × 双主题逐域截图 + 代表域单卡放大图。
// 用法:node scripts/probe-cover-quality.mjs [origin] [round]
import fs from "node:fs";
import path from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const round = process.argv[3] ?? "round1";
const outDir = path.resolve(`test-output/cover-quality/${round}`);
fs.mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const errors = [];

// 抽样 20 域:覆盖全部 7 个主题套件与 9 个行业分组(脚本对已裁删域自动跳过)。
const SAMPLE_DOMAINS = [
  ["生产运行监控", "production"], ["电力电网调度", "power-grid"], ["水务运行监控", "water"],
  ["医疗健康监测", "healthcare"], ["能源效率分析", "energy"], ["环境监测治理", "environment"],
  ["供应链物流中心", "logistics"], ["仓储与库存协同", "warehouse"], ["金融风控与经营", "finance"],
  ["零售电商运营", "retail"], ["经营驾驶舱", "operations"], ["安全态势中心", "safety"],
  ["质量追溯与改善", "quality"], ["园区综合运营", "campus"], ["智慧工地总览", "construction"],
  ["政务服务驾驶舱", "government"], ["交通枢纽调度", "transport"], ["文化旅游态势", "tourism"],
  ["半导体晶圆制造", "semiconductor"], ["农业生产监测", "agriculture"],
];

function watch(page, tag) {
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) errors.push(`[${tag}][${m.type()}] ${m.text().slice(0, 200)}`); });
  page.on("pageerror", (e) => errors.push(`[${tag}][pageerror] ${String(e.message).slice(0, 200)}`));
}

async function openTemplateLibrary(page) {
  if (await page.locator(".dashboard-template-library-panel").first().isVisible().catch(() => false)) return true;
  const resTab = page.locator('.dashboard-left-tabs button:has-text("资源")').first();
  if (await resTab.isVisible().catch(() => false)) { await resTab.click(); await page.waitForTimeout(800); }
  for (const locator of [
    page.locator(".dashboard-library-template-button").first(),
    page.getByRole("button", { name: "模板", exact: true }).first(),
  ]) {
    if (await locator.isVisible().catch(() => false)) { await locator.click(); await page.waitForTimeout(900); return true; }
  }
  return false;
}

/** 逐域截图:搜索域名 → 面板区域截图(含该域全部 10 视角封面);首域追加单卡放大图。 */
async function captureDomain(page, [label, id], theme, closeUp) {
  const panel = page.locator(".dashboard-template-library-panel").first();
  const search = panel.locator(".dashboard-template-search input");
  await search.fill("");
  await search.fill(label);
  await page.waitForTimeout(700);
  const box = await panel.boundingBox();
  if (!box) { errors.push(`[${theme}] ${id}: panel box missing`); return; }
  await page.screenshot({
    path: path.join(outDir, `${id}-${theme}.png`),
    clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 900) },
  });
  process.stdout.write(`shot ${id}-${theme}\n`);
  if (closeUp) {
    const card = page.locator(".dashboard-template-grid article .template-layout-preview").first();
    if (await card.isVisible().catch(() => false)) {
      await card.screenshot({ path: path.join(outDir, `closeup-${id}-${theme}.png`) });
    }
  }
}

for (const theme of ["dark", "light"]) {
  const page = await browser.newPage({ viewport: { width: 1680, height: 980 }, deviceScaleFactor: 2 });
  watch(page, theme);
  await page.goto(`${origin}/?__visualQa=dashboard&theme=${theme}`, { waitUntil: "load" });
  await page.waitForTimeout(3200);
  if (!(await openTemplateLibrary(page))) { errors.push(`[${theme}] template library entry not found`); await page.close(); continue; }
  for (const [index, domain] of SAMPLE_DOMAINS.entries()) {
    await captureDomain(page, domain, theme, index % 4 === 0);
  }
  // 视角家族特写:生产域 × 6 个代表视角(地图/监控/分析/流向/漏斗/可持续),逐视角单卡放大。
  if (theme === "dark") {
    for (const view of ["风险处置", "运行调度", "质量改善", "供需协同", "服务履约", "可持续发展"]) {
      const search = page.locator(".dashboard-template-library-panel .dashboard-template-search input");
      await search.fill("");
      await search.fill(`生产运行监控 · ${view}`);
      await page.waitForTimeout(650);
      const card = page.locator(".dashboard-template-grid article .template-layout-preview, .dashboard-template-row article .template-layout-preview").first();
      if (await card.isVisible().catch(() => false)) {
        await card.screenshot({ path: path.join(outDir, `family-${view}-dark.png`) });
        process.stdout.write(`shot family-${view}\n`);
      } else errors.push(`[family] ${view}: card not visible`);
    }
  }
  await page.close();
}

fs.writeFileSync(path.join(outDir, "console-errors.log"), errors.slice(0, 80).join("\n") || "(no console errors)");
console.log(`--- errors(${errors.length}) ---`);
for (const line of errors.slice(0, 10)) console.log(line);
await browser.close();
console.log("cover probe done");
