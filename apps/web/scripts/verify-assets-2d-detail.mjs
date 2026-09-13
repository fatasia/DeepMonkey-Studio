// 二维资源库扩充·第 2 轮:逐个新预设"搜索定位 + 视口裁剪特写",规避长容器元素截图伪影。
// 用法: node scripts/verify-assets-2d-detail.mjs [origin] [round]
import fs from "node:fs";
import path from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const round = process.argv[3] ?? "r2";
const outDir = path.resolve("test-output/assets-2d");
fs.mkdirSync(outDir, { recursive: true });

const NEW_PRESETS = [
  "产量环比指标卡", "产值同比翻牌卡", "计划达成仪表", "设备稼动率卡", "能耗峰值需量卡", "未处置告警翻牌", "备件库存水球", "车间温度状态", "蒸汽压力指标卡", "完工批次翻牌", "功率因数指标卡", "平均修复时长卡",
  "温度量程仪表", "压力量程仪表", "流量仪表", "湿度仪表", "电压仪表", "年度目标进度", "里程碑进度", "培训覆盖进度", "维保计划进度", "订单履约进度", "预算执行进度", "利润环比卡", "订单同比卡", "能耗环比卡", "交付同比卡",
  "分厂堆叠趋势面积", "多系列分组柱", "关键词频次排行", "成本矩形树图钻取", "产线能效雷达对比", "告警传播桑基", "告警影响关系图", "时段负荷分布", "指标上下限监控", "累计结转组合图", "质量双轴组合", "滚动绩效榜单", "区域产值气泡地图", "环境舒适度仪表",
  "成本收入双轴组合", "能耗产量双轴组合", "人力工时组合分析", "维护工单组合", "排放水质双轴组合", "销售额同比复合", "产量环比双线", "能耗同比面积", "订单量同比复合", "利润环比复合",
  "分组小计表", "区域品类交叉表", "项目进度汇总表", "明细合计表", "条件格式明细表", "分页库存明细表", "宽表冻结首列", "产线 KPI 汇总表",
  "统计日期筛选", "供应类别下拉筛选", "产线单选筛选", "产品类别多选", "数值精确查询", "启停状态筛选", "厂区快捷切换", "分析视角切换",
  "扫光标题条", "霓虹面板标题条", "科技细线边框", "括号面板边框", "光晕分隔线", "峰值提醒角标",
  "扫描动效边框", "霓虹呼吸边框", "目标锁定框", "双翼面板边框", "阶梯缺口边框", "斜纹警示边框", "点阵呼吸边框", "展翼标题条", "机械臂标题条", "立柱标题条", "灯塔标题条", "雷达标题条", "铆接标题条", "横幅标题条",
  "粒子流光带", "星点装饰条", "能源脉冲光带", "光晕点缀环", "扫光高亮条", "角部闪光点缀",
];

const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });

async function shootDetail(theme) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1.5 });
  await page.goto(`${origin}/?__visualQa=dashboard&theme=${theme}`, { waitUntil: "load" });
  await page.waitForTimeout(2600);
  const library = page.locator(".dashboard-library-browser").first();
  if (!(await library.isVisible().catch(() => false))) {
    for (const label of ["资源", "组件", "Assets"]) {
      const btn = page.locator(`button:has-text("${label}")`).first();
      if (await btn.isVisible().catch(() => false)) { await btn.click(); await page.waitForTimeout(700); break; }
    }
  }
  const search = page.locator(".dashboard-library-search input").first();
  const notFound = [];
  for (const name of NEW_PRESETS) {
    await search.fill(name);
    await page.waitForTimeout(420);
    const card = page.locator(".dashboard-library-card", { has: page.locator("strong", { hasText: name }) }).first();
    if (!(await card.isVisible().catch(() => false))) { notFound.push(name); continue; }
    // 内层滚动容器:强制居中滚动后再取坐标,避免卡片停在视口折叠线下导致裁剪越界。
    await card.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(280);
    const box = await card.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    if (!box || box.width <= 0) { notFound.push(`${name}:no-rect`); continue; }
    const pad = 14;
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    const width = Math.min(box.width + pad * 2, 1600 - x);
    const height = Math.min(box.height + pad * 2, 950 - y);
    if (width <= 10 || height <= 10 || !Number.isFinite(width) || !Number.isFinite(height)) { notFound.push(`${name}:offscreen(${box.x},${box.y})`); continue; }
    try {
      await page.screenshot({
        path: path.join(outDir, `${round}-${theme}-preset-${name.replace(/[\\/:*?"<>|\s]+/g, "")}.png`),
        clip: { x, y, width, height },
      });
    } catch (error) {
      notFound.push(`${name}:shot-fail(${box.x},${box.y})`);
    }
  }
  console.log(`[${round}/${theme}] detail shots done, notFound:`, notFound.length ? notFound.join(",") : "none");
  await page.close();
}

await shootDetail("dark");
await shootDetail("light");
await browser.close();
console.log("done:", fs.readdirSync(outDir).filter((f) => f.startsWith(round)).length, "screenshots");
