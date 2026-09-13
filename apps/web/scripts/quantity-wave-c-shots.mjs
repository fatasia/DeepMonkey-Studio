// 素材数量波次 C 截图验收:管理端资源页 prefab tab 全翻页(120 全渲染 + 0 控制台错误)
// + 22 个新变体逐卡特写(双主题)+ 族内并排对照板。
// 用法: node scripts/quantity-wave-c-shots.mjs <round>
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const round = process.argv[1]?.match(/round(\d+)/) ? RegExp.$1 : (process.argv[2] ?? "round1");
const output = resolve("test-output/quantity-wave-c", round);
for (const dir of ["pages/dark", "pages/light", "closeups/dark", "closeups/light", "boards"]) {
  mkdirSync(resolve(output, dir), { recursive: true });
}

const origin = process.argv[3] ?? "http://127.0.0.1:5173";

// 2026-09-12 波次 C 新增 22 个预制体(中文名用于站内搜索)。
const NEW_PREFABS = [
  ["sensor.smoke-detector", "感烟探测器"],
  ["sensor.heat-detector", "感温探测器"],
  ["sensor.sounder-strobe", "声光报警器"],
  ["sensor.rtu", "远程终端单元"],
  ["sensor.edge-gateway", "边缘计算网关"],
  ["sensor.vibration", "振动监测传感器"],
  ["camera.bullet", "枪型网络摄像机"],
  ["camera.dome", "半球型网络摄像机"],
  ["camera.thermal", "热成像摄像机"],
  ["camera.ai-box", "AI 视频分析盒"],
  ["vehicle.tractor-unit", "半挂牵引车"],
  ["vehicle.dump-truck", "自卸车"],
  ["vehicle.water-truck", "洒水车"],
  ["vehicle.boom-lift", "曲臂式登高车"],
  ["vehicle.patrol-pickup", "皮卡巡查车"],
  ["storage.drive-in-rack", "贯通式货架"],
  ["storage.mobile-shelving", "移动式密集架"],
  ["storage.cold-room", "冷藏柜"],
  ["storage.roll-cage", "周转笼"],
  ["agv.stacker", "堆高 AGV"],
  ["agv.latent-jack", "潜伏顶升 AGV"],
  ["agv.tote-robot", "料箱机器人"],
];

// 族内并排对照:新变体与同族既有变体并排,肉眼核验"几何+姿态+材质"三重区分。
const FAMILY_BOARDS = [
  ["family-fire-sensing", "火灾与状态感知族", [
    ["sensor.smoke-detector", "感烟探测器"], ["sensor.heat-detector", "感温探测器"],
    ["sensor.sounder-strobe", "声光报警器"], ["sensor.vibration", "振动监测传感器"],
    ["sensor.photoelectric", "光电传感器(既有)"], ["sensor.temperature", "温湿度(既有)"],
  ]],
  ["family-gateway", "采集网联族", [
    ["sensor.rtu", "RTU"], ["sensor.edge-gateway", "边缘计算网关"], ["utility.cabinet.mcc", "MCC 柜(既有)"],
  ]],
  ["family-camera", "摄像机族", [
    ["camera.bullet", "枪机"], ["camera.fixed", "固定工业相机(既有)"], ["camera.ptz", "云台(既有)"],
    ["camera.dome", "半球"], ["camera.thermal", "热成像"], ["camera.vision", "视觉检测(既有)"], ["camera.ai-box", "AI 分析盒"],
  ]],
  ["family-vehicle", "车辆族", [
    ["vehicle.tractor-unit", "半挂牵引车"], ["vehicle.tow-tractor", "牵引车(既有)"], ["vehicle.truck", "物流货车(既有)"],
    ["vehicle.dump-truck", "自卸车"], ["vehicle.water-truck", "洒水车"],
    ["vehicle.boom-lift", "曲臂登高车"], ["vehicle.patrol-pickup", "皮卡巡查车"], ["vehicle.car", "园区车(既有)"],
  ]],
  ["family-agv", "AGV 族", [
    ["agv.stacker", "堆高 AGV"], ["agv.forklift", "叉车 AGV(既有)"],
    ["agv.latent-jack", "潜伏顶升 AGV"], ["agv.amr-shelf", "潜伏顶升 AMR(既有)"],
    ["agv.tote-robot", "料箱机器人"], ["agv.amr", "AMR(既有)"],
  ]],
  ["family-storage", "仓储族", [
    ["storage.drive-in-rack", "贯通式货架"], ["storage.pallet-rack", "托盘货架(既有)"],
    ["storage.mobile-shelving", "移动密集架"], ["storage.carton-flow", "流利架(既有)"],
    ["storage.cold-room", "冷藏柜"], ["storage.roll-cage", "周转笼"],
  ]],
];

// 特写清单 = 新变体 + 对照板引用的既有变体(板内对照位不能挂图)。
const COMPARISON_PREFABS = [
  ["sensor.photoelectric", "光电传感器"],
  ["sensor.temperature", "温湿度传感器"],
  ["utility.cabinet.mcc", "电机控制柜"],
  ["camera.fixed", "固定式工业相机"],
  ["camera.ptz", "云台摄像机"],
  ["camera.vision", "视觉检测相机"],
  ["vehicle.tow-tractor", "牵引车"],
  ["vehicle.truck", "物流货车"],
  ["vehicle.car", "园区车辆"],
  ["agv.forklift", "叉车式 AGV"],
  ["agv.amr-shelf", "潜伏顶升 AMR"],
  ["agv.amr", "自主移动机器人"],
  ["storage.pallet-rack", "托盘货架"],
  ["storage.carton-flow", "重力流利架"],
];
const ALL_SHOTS = [...NEW_PREFABS, ...COMPARISON_PREFABS];

const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
const consoleErrors = [];
const missing = [];
const notRendered = [];

async function openAssetPage(theme) {
  const page = await context.newPage();
  page.on("pageerror", (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`[console] ${m.text()}`); });
  await page.goto(`${origin}/?theme=${theme}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  const loginUser = page.locator('input[aria-label="用户名"]');
  try {
    await loginUser.waitFor({ state: "visible", timeout: 6000 });
    await loginUser.fill("admin");
    await page.locator('input[aria-label="密码"]').fill("admin");
    await page.getByRole("button", { name: "登录" }).click();
    await page.waitForTimeout(3000);
  } catch { /* 已登录 */ }
  // 双保险:query 参数之外再落到 data-theme 属性层(深色是默认,移除属性)
  await page.evaluate((t) => {
    if (t === "dark") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", "light");
  }, theme);
  await page.getByRole("button", { name: "资源" }).first().click().catch(async () => {
    await page.getByRole("link", { name: "资源" }).first().click();
  });
  await page.getByRole("button", { name: /工业预制体/ }).first().waitFor({ state: "visible", timeout: 30000 });
  await page.getByRole("button", { name: /工业预制体/ }).first().click();
  // 头部计数徽章应为 120
  await page.waitForFunction(() => {
    const badge = document.querySelector('button[aria-pressed="true"] .unified-assets-kind-count');
    return badge?.textContent === "120";
  }, undefined, { timeout: 20000 }).catch(() => consoleErrors.push("[badge] 预制体计数徽章未显示 120"));
  await page.waitForTimeout(800);
  return page;
}

/** 等待当前页所有卡片 3D 小样就绪(淡入完成的 img.is-ready)。 */
async function waitCardsRendered(page, theme, pageLabel) {
  try {
    await page.waitForFunction(() => {
      const thumbs = [...document.querySelectorAll(".unified-asset-card .scene-prefab-thumbnail")];
      return thumbs.length > 0 && thumbs.every((t) => t.querySelector("img.is-ready"));
    }, undefined, { timeout: 45000 });
  } catch {
    const lagging = await page.evaluate(() => [...document.querySelectorAll(".unified-asset-card")]
      .filter((c) => !c.querySelector("img.is-ready"))
      .map((c) => c.querySelector("strong")?.title));
    for (const id of lagging) notRendered.push(`${theme}/${pageLabel}:${id}`);
  }
}

for (const theme of ["dark", "light"]) {
  const page = await openAssetPage(theme);
  // 1) 全翻页截图(120 / 每页 24 → 5 页)
  for (let index = 1; index <= 6; index += 1) {
    await waitCardsRendered(page, theme, `p${index}`);
    await page.locator(".unified-assets-browser").screenshot({ path: resolve(output, `pages/${theme}/page-${index}.png`) }).catch(() => {});
    const next = page.locator(".unified-assets-pagination button", { hasText: "下一页" });
    if (await next.isDisabled().catch(() => true)) break;
    await next.click();
    await page.waitForTimeout(600);
  }
  // 2) 22 个新变体 + 14 个对照既有变体特写
  for (const [id, name] of ALL_SHOTS) {
    const input = page.locator('input[aria-label="搜索内置资源"]');
    await input.fill(name);
    await page.waitForTimeout(500);
    const card = page.locator("article.unified-asset-card", { has: page.locator(`strong[title="${name}"]`) });
    try {
      await card.waitFor({ state: "visible", timeout: 6000 });
      await page.waitForFunction((title) => {
        const cards = [...document.querySelectorAll(".unified-asset-card")];
        const target = cards.find((c) => c.querySelector("strong")?.title === title);
        return target?.querySelector("img.is-ready");
      }, name, { timeout: 30000 }).catch(() => {});
      await card.screenshot({ path: resolve(output, `closeups/${theme}/${id}.png`) });
    } catch {
      missing.push(`${theme}/${id}`);
    }
    await input.fill("");
    await page.waitForTimeout(300);
  }
  await page.close();
}

// 3) 族内并排对照板(深色特写拼板,标注名称)
{
  const page = await context.newPage();
  for (const [key, title, items] of FAMILY_BOARDS) {
    const cells = items.map(([id, name]) => `
      <figure><img src="../closeups/dark/${id}.png"><figcaption>${name}<br><code>${id}</code></figcaption></figure>`).join("\n");
    const html = `<!doctype html><meta charset="utf-8"><style>
      body { margin: 16px; background: #0b1114; color: #d7e2e8; font: 13px/1.4 "Microsoft YaHei", sans-serif; }
      h1 { font-size: 16px; } .row { display: flex; flex-wrap: wrap; gap: 10px; }
      figure { margin: 0; width: 300px; } figure img { width: 300px; display: block; border: 1px solid #223; }
      figcaption { padding: 4px 2px; } code { color: #7fa6b5; font-size: 11px; }
    </style><h1>${title}</h1><div class="row">${cells}</div>`;
    const boardPath = resolve(output, "boards", `${key}.html`);
    writeFileSync(boardPath, html);
    await page.goto(`file:///${boardPath.replace(/\\/g, "/")}`);
    await page.waitForTimeout(700);
    await page.screenshot({ path: resolve(output, "boards", `${key}.png`), fullPage: true });
  }
  await page.close();
}

await browser.close();
console.log(JSON.stringify({
  round,
  newPrefabs: NEW_PREFABS.length,
  shots: ALL_SHOTS.length,
  closeupMissing: missing,
  notRendered,
  consoleErrorCount: consoleErrors.length,
  consoleErrors: consoleErrors.slice(0, 12),
}, null, 2));
