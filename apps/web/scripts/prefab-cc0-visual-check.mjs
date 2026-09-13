// 缺口 CC0 模型上线视觉验收:管理端 prefab tab 全景 + 20 个新条目逐个特写。
// 产物存 test-output/prefab-cc0/shots/。真实浏览器渲染,不 mock 任何数据。
import { mkdir, writeFile } from "node:fs/promises";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.argv.find((a) => a.startsWith("--origin="))?.slice(9) ?? "http://127.0.0.1:5173";
const outDir = "test-output/prefab-cc0/shots";
await mkdir(`${outDir}`, { recursive: true });

const browser = await playwright.chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 }, deviceScaleFactor: 1.5 });
try {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  if (await page.getByLabel("用户名").count()) {
    await page.getByLabel("用户名").fill("admin");
    await page.getByLabel("密码").fill("admin");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForTimeout(5000);
  }
  const app = page.locator(".scene-manager-page");
  await app.waitFor({ timeout: 30000 });
  // 资源 tab 需要项目存在(disabled=!project);无项目时先经 UI 创建。
  const assetsTab = page.getByRole("button", { name: "资源", exact: true });
  if (await assetsTab.isDisabled()) throw new Error("没有可用项目,资源 tab 被禁用;请先建项目");
  await assetsTab.click();
  await page.locator(".unified-assets-kinds button", { hasText: "工业预制体" }).click();
  await page.waitForTimeout(2500);
  const grid = page.locator(".unified-assets-grid article");
  console.log("卡片数:", await grid.count());
  await page.waitForTimeout(18000); // GLB 串行加载出图
  await page.screenshot({ path: `${outDir}/prefab-tab-full.png` });

  const targets = [
    ["感烟探测器", "sensor-smoke-detector"], ["声光报警器", "sensor-sounder-strobe"], ["温湿度传感器", "sensor-temperature"],
    ["RFID", "sensor-rfid"], ["称重传感器", "sensor-load-cell"], ["流量计", "sensor-flow"],
    ["枪型网络摄像机", "camera-bullet"], ["固定式工业相机", "camera-fixed"], ["半球型网络摄像机", "camera-dome"], ["云台摄像机", "camera-ptz"],
    ["半挂牵引车", "vehicle-tractor-unit"], ["自卸车", "vehicle-dump-truck"], ["曲臂式登高车", "vehicle-boom-lift"], ["皮卡巡查车", "vehicle-patrol-pickup"], ["牵引车", "vehicle-tow-tractor"],
    ["作业人员", "person-worker"], ["产线操作员", "person-operator"], ["巡检人员", "person-guard"], ["维修技师", "person-maintenance"], ["访客", "person-visitor"],
  ];
  const search = page.locator(".unified-assets-search input").first();
  const results = [];
  for (const [query, slug] of targets) {
    try {
      await search.fill(query);
      await page.waitForTimeout(1500);
      const cards = page.locator(".unified-assets-grid article");
      const count = await cards.count();
      if (count === 0) { results.push({ query, slug, found: false }); continue; }
      const card = cards.first();
      await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(2500);
      await card.screenshot({ path: `${outDir}/closeup-${slug}.png` });
      results.push({ query, slug, found: true, cards: count });
    } catch (error) { results.push({ query, slug, error: error.message }); }
  }
  await search.fill("");
  await writeFile(`${outDir}/closeup-results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ shots: results.filter((r) => r.found).length, failed: results.filter((r) => !r.found || r.error) }));
} finally { await browser.close(); }
