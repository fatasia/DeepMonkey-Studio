// 二维资源库扩充·视觉闭环截图(编辑器资源面板逐 tab/逐分组 + 管理端资源页 2D tab,双主题,支持多轮)。
// 用法: node scripts/verify-assets-2d.mjs [origin] [round]
import fs from "node:fs";
import path from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const round = process.argv[3] ?? "r1";
const outDir = path.resolve("test-output/assets-2d");
fs.mkdirSync(outDir, { recursive: true });

// 本批新增 93 个预设的中文名(与 preset 文件严格同步,用于 DOM 存在性断言)。
const NEW_PRESETS = {
  chart: ["产量环比指标卡", "产值同比翻牌卡", "计划达成仪表", "设备稼动率卡", "能耗峰值需量卡", "未处置告警翻牌", "备件库存水球", "车间温度状态", "蒸汽压力指标卡", "完工批次翻牌", "功率因数指标卡", "平均修复时长卡", "温度量程仪表", "压力量程仪表", "流量仪表", "湿度仪表", "电压仪表", "年度目标进度", "里程碑进度", "培训覆盖进度", "维保计划进度", "订单履约进度", "预算执行进度", "利润环比卡", "订单同比卡", "能耗环比卡", "交付同比卡", "分厂堆叠趋势面积", "多系列分组柱", "关键词频次排行", "成本矩形树图钻取", "产线能效雷达对比", "告警传播桑基", "告警影响关系图", "时段负荷分布", "指标上下限监控", "累计结转组合图", "质量双轴组合", "滚动绩效榜单", "区域产值气泡地图", "环境舒适度仪表", "成本收入双轴组合", "能耗产量双轴组合", "人力工时组合分析", "维护工单组合", "排放水质双轴组合", "销售额同比复合", "产量环比双线", "能耗同比面积", "订单量同比复合", "利润环比复合", "分组小计表", "区域品类交叉表", "项目进度汇总表", "明细合计表", "条件格式明细表", "分页库存明细表", "宽表冻结首列", "产线 KPI 汇总表"],
  control: ["统计日期筛选", "供应类别下拉筛选", "产线单选筛选", "产品类别多选", "数值精确查询", "启停状态筛选", "厂区快捷切换", "分析视角切换"],
  resource: ["扫光标题条", "霓虹面板标题条", "科技细线边框", "括号面板边框", "光晕分隔线", "峰值提醒角标", "扫描动效边框", "霓虹呼吸边框", "目标锁定框", "双翼面板边框", "阶梯缺口边框", "斜纹警示边框", "点阵呼吸边框", "展翼标题条", "机械臂标题条", "立柱标题条", "灯塔标题条", "雷达标题条", "铆接标题条", "横幅标题条", "粒子流光带", "星点装饰条", "能源脉冲光带", "光晕点缀环", "扫光高亮条", "角部闪光点缀"],
};
// 抽样插入画布的 6 个预设(跨 category:指标/分析/装饰,覆盖加量批次)。
const INSERT_SAMPLES = ["温度量程仪表", "销售额同比复合", "年度目标进度", "扫描动效边框", "展翼标题条", "粒子流光带"];

const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });

function collectLibraryCards() {
  return [...document.querySelectorAll(".dashboard-library-card strong")].map((el) => el.textContent.trim());
}

async function shootEditorLibrary(theme, doInsert) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1.5 });
  const logs = [];
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(`${origin}/?__visualQa=dashboard&theme=${theme}`, { waitUntil: "load" });
  await page.waitForTimeout(2800);
  const library = page.locator(".dashboard-library-browser").first();
  if (!(await library.isVisible().catch(() => false))) {
    for (const label of ["资源", "组件", "Assets"]) {
      const btn = page.locator(`button:has-text("${label}")`).first();
      if (await btn.isVisible().catch(() => false)) { await btn.click(); await page.waitForTimeout(700); break; }
    }
  }
  if (!(await library.isVisible().catch(() => false))) { console.log(`[${round}/${theme}] library panel NOT visible`); await page.close(); return; }

  const tabLabels = { chart: "图表", control: "控件", media: "媒体", threeD: "3D", resource: "资源" };
  const missing = {};
  for (const [tab, label] of Object.entries(tabLabels)) {
    await page.locator(`[role="tab"]:has-text("${label}")`).first().click();
    await page.waitForTimeout(500);
    await library.screenshot({ path: path.join(outDir, `${round}-${theme}-tab-${tab}.png`) });
    // 逐分组截图,保证每个新预设所在分组都有可验收的特写。
    const groups = page.locator(".dashboard-library-result-group");
    const groupCount = await groups.count();
    for (let i = 0; i < groupCount; i += 1) {
      const group = groups.nth(i);
      const header = (await group.locator("header strong").first().textContent())?.trim() ?? `group-${i}`;
      const safe = header.replace(/[\\/:*?"<>|\s]+/g, "-");
      await group.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(220);
      await group.screenshot({ path: path.join(outDir, `${round}-${theme}-${tab}-${safe}.png`) });
    }
    const cards = await page.evaluate(collectLibraryCards);
    const expected = NEW_PRESETS[tab] ?? [];
    missing[tab] = expected.filter((name) => !cards.includes(name));
  }

  // 抽样插入:点击卡片即插入画布,校验画布节点数量增长并截图。
  if (doInsert) {
    await page.locator('[role="tab"]:has-text("图表")').first().click();
    await page.waitForTimeout(400);
    const before = await page.locator(".dashboard-node").count();
    const insertLog = [];
    for (const name of INSERT_SAMPLES) {
      const tabKey = NEW_PRESETS.chart.includes(name) ? "图表" : NEW_PRESETS.control.includes(name) ? "控件" : "资源";
      await page.locator(`[role="tab"]:has-text("${tabKey}")`).first().click();
      await page.waitForTimeout(350);
      const card = page.locator(".dashboard-library-card", { has: page.locator("strong", { hasText: name }) }).first();
      if (await card.isVisible().catch(() => false)) { await card.click(); await page.waitForTimeout(420); insertLog.push(`${name}:ok`); }
      else insertLog.push(`${name}:CARD-NOT-FOUND`);
    }
    await page.waitForTimeout(700);
    const after = await page.locator(".dashboard-node").count();
    await page.screenshot({ path: path.join(outDir, `${round}-${theme}-insert-canvas.png`), fullPage: false });
    console.log(`[${round}/${theme}] insert: nodes ${before} -> ${after}; ${insertLog.join(", ")}`);
  }

  console.log(`[${round}/${theme}] missing new presets:`, JSON.stringify(missing));
  console.log(`[${round}/${theme}] pageerrors:`, logs.length ? logs.join(" | ") : "none");
  await page.close();
}

async function shootManagerAssets(theme) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1.5 });
  await page.goto(`${origin}/?theme=${theme}`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  const userInput = page.getByLabel(/用户名|Username/).first();
  if (await userInput.isVisible().catch(() => false)) {
    await userInput.fill("admin");
    await page.getByLabel(/密码|Password/).first().fill("admin");
    await page.getByRole("button", { name: /登录|Sign in|Login/i }).first().click();
    await page.waitForTimeout(2500);
  }
  const assetsTab = page.locator(`button[aria-label="资源"], button[aria-label="Assets"]`).first();
  if (await assetsTab.isVisible().catch(() => false)) {
    if (await assetsTab.isEnabled()) { await assetsTab.click(); await page.waitForTimeout(1800); }
    else console.log(`[${round}/${theme}] assets tab disabled`);
  }
  const kind2d = page.locator(`button:has-text("二维资源"), button:has-text("2D")`).first();
  if (await kind2d.isVisible().catch(() => false)) { await kind2d.click(); await page.waitForTimeout(1200); }
  const grid = page.locator(".built-in-assets-grid").first();
  if (await grid.isVisible().catch(() => false)) {
    await grid.screenshot({ path: path.join(outDir, `${round}-${theme}-manager-2d.png`) });
  } else {
    console.log(`[${round}/${theme}] manager 2d grid not visible`);
  }
  const counterText = await page.evaluate(() => [...document.querySelectorAll("small, span, div")].map((el) => el.textContent ?? "").filter((t) => t.includes("个二维资源")).slice(0, 3));
  console.log(`[${round}/${theme}] manager 2d counter:`, JSON.stringify(counterText));
  await page.close();
}

// 默认每轮都做抽样插入;传第 4 参 "skip-insert" 可跳过。
const doInsert = process.argv[4] !== "skip-insert";
await shootEditorLibrary("dark", doInsert);
await shootEditorLibrary("light", doInsert);
await shootManagerAssets("dark");
await shootManagerAssets("light");
await browser.close();
console.log("done:", fs.readdirSync(outDir).filter((f) => f.startsWith(round)).length, "screenshots for round", round);
