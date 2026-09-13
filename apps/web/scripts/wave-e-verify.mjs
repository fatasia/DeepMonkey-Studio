// 波次 E(材质与细节深化)验证:管理端 prefab tab 全翻页(120 全渲染、0 控制台错误)
// + 24 变体抽样截图,并与改造前存档(prefab-quality/raw)拼接 before/after 对照图。
// 用法:node wave-e-verify.mjs [origin] [round]
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const origin = process.argv[2] ?? "http://127.0.0.1:5199";
const round = process.argv[3] ?? "r1";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../test-output/wave-e-material");
const rawBeforeDir = resolve(here, "../test-output/prefab-quality/raw");
const afterDir = resolve(outDir, `after-${round}`);
const pageShotsDir = resolve(outDir, `pages-${round}`);
await mkdir(afterDir, { recursive: true });
await mkdir(pageShotsDir, { recursive: true });

/** 24 个抽样变体:覆盖 14 个 kind + 波次 E 重点微交互件;before 文件来自 prefab-quality/raw。 */
const SAMPLES = [
  ["六轴关节机器人", "01-robot__articulated-6"],
  ["龙门桁架机械手", "01-robot__gantry-3"],
  ["双臂协作机器人", "01-robot__dual-arm-14"],
  ["四轴码垛机器人", "01-robot__palletizer-4"],
  ["直线传送带", "02-conveyor__straight"],
  ["螺旋输送机", "02-conveyor__screw"],
  ["垂直提升机", "02-conveyor__vertical-lift"],
  ["斗式提升机", "02-conveyor__bucket-elevator"],
  ["叉车式 AGV", "03-agv-vehicle__agv-forklift"],
  ["自主移动机器人", "03-agv-vehicle__agv-amr"],
  ["巡检无人机", "03-agv-vehicle__agv-uav"],
  ["物流货车", "03-agv-vehicle__vehicle-truck"],
  ["作业人员", "04-person__worker"],
  ["数控加工中心", "05-machine__cnc-mill"],
  ["数控车床", "05-machine__cnc-lathe"],
  ["数控折弯机", "05-machine__press-brake"],
  ["冲压机", "05-machine__press"],
  ["热处理炉", "05-machine__heat-treat-furnace"],
  ["电机控制柜", "06-utility__cabinet-mcc"],
  ["离心泵", "06-utility__pump-centrifugal"],
  ["双柱软水器", "06-utility__softener"],
  ["液位计", "07-sensing__level"],
  ["垂直提升货柜", "08-storage__vertical-lift"],
  ["料仓", "08-storage__silo"],
];

const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
const logs = [];
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") logs.push(`[error] ${m.text()}`); });

// ── 登录 ──
await page.goto(origin);
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录", exact: true }).click();
await page.locator(".scene-manager-page").waitFor();

// ── prefab tab 全翻页:120 全渲染、0 控制台错误 ──
await page.goto(`${origin}/manager?tab=assets`);
await page.locator(".scene-manager-page").waitFor();
await page.getByRole("button", { name: /工业预制体/ }).click();
await page.waitForTimeout(1200);

const pagination = page.locator(".unified-assets-pagination");
const nextBtn = pagination.getByRole("button", { name: /下一页|Next/ });
const totalCards = [];
for (let pageIndex = 1; pageIndex <= 5; pageIndex += 1) {
  // 逐页等待:该页全部卡片缩略图就绪(img.is-ready)
  await page.waitForFunction(() => {
    const cards = document.querySelectorAll(".scene-prefab-thumbnail");
    const ready = document.querySelectorAll(".scene-prefab-thumbnail img.is-ready");
    return cards.length > 0 && ready.length >= cards.length;
  }, undefined, { timeout: 30000 });
  const counts = await page.evaluate(() => ({
    cards: document.querySelectorAll(".scene-prefab-thumbnail").length,
    ready: document.querySelectorAll(".scene-prefab-thumbnail img.is-ready").length,
  }));
  totalCards.push(counts);
  await page.screenshot({ path: resolve(pageShotsDir, `prefab-page-${pageIndex}.png`) });
  if (pageIndex < 5) {
    await nextBtn.click();
    await page.waitForTimeout(900);
  }
}

// ── 24 变体抽样截图(after)──
const search = page.locator("input[aria-label*='搜索']").first();
const missing = [];
for (const [keyword, slug] of SAMPLES) {
  await search.fill(keyword);
  try {
    await page.waitForFunction(() => {
      const img = document.querySelector(".built-in-prefab-preview .scene-prefab-thumbnail img.is-ready");
      return Boolean(img);
    }, undefined, { timeout: 15000 });
  } catch {
    missing.push(slug);
    continue;
  }
  await page.waitForTimeout(350);
  const preview = page.locator(".built-in-prefab-preview").first();
  try {
    await preview.screenshot({ path: resolve(afterDir, `${slug}.png`), timeout: 8000 });
  } catch {
    await page.screenshot({ path: resolve(afterDir, `${slug}.png`) });
    missing.push(`${slug}(整页兜底)`);
  }
}
await search.fill("");

// ── before/after 拼接:左改造前(archived raw)/ 右改造后 ──
const THUMB = 280;
const LABEL = 34;
const GAP = 8;
let stitched = 0;
for (const [, slug] of SAMPLES) {
  const beforeFile = resolve(rawBeforeDir, `${slug}.png`);
  const afterFile = resolve(afterDir, `${slug}.png`);
  let beforeBuf;
  try {
    beforeBuf = await sharp(await readFile(beforeFile)).resize(THUMB, THUMB, { fit: "cover", position: "top" }).toBuffer();
  } catch {
    beforeBuf = sharp({ create: { width: THUMB, height: THUMB, channels: 3, background: { r: 40, g: 40, b: 40 } } }).png().toBuffer();
    beforeBuf = await beforeBuf;
  }
  let afterBuf;
  try {
    afterBuf = await sharp(await readFile(afterFile)).resize(THUMB, THUMB, { fit: "cover", position: "top" }).toBuffer();
  } catch { continue; }
  const width = THUMB * 2 + GAP;
  const height = LABEL + THUMB;
  const labelSvg = Buffer.from(`<svg width="${width}" height="${LABEL}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${LABEL}" fill="#111518"/>
    <text x="8" y="23" font-size="17" fill="#4dc9c4" font-family="Microsoft YaHei">${slug}(左 before / 右 after)</text>
  </svg>`);
  await sharp({ create: { width, height, channels: 3, background: { r: 23, g: 27, b: 30 } } })
    .composite([
      { input: labelSvg, top: 0, left: 0 },
      { input: beforeBuf, top: LABEL, left: 0 },
      { input: afterBuf, top: LABEL, left: THUMB + GAP },
    ])
    .png()
    .toFile(resolve(outDir, `before-after-${slug}.png`));
  stitched += 1;
}

console.log(JSON.stringify({
  round,
  pages: totalCards,
  renderedTotal: totalCards.reduce((sum, p) => sum + p.ready, 0),
  missingSamples: missing,
  stitchedPairs: stitched,
  consoleErrors: logs.length,
}, null, 2));
if (logs.length) console.log(logs.slice(0, 12).join("\n"));
await browser.close();
