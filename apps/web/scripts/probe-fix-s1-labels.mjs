// S1 标签缺陷复现探针:远/中/近三距离截图 + 像素量测(文字簇/底板边界/无文字暗块)。
// 用法: node scripts/probe-fix-s1-labels.mjs [origin] [before|after]
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const tag = process.argv[3] ?? "before";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "test-output", "fix-s1");
mkdirSync(outDir, { recursive: true });

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  const file = join(outDir, `${tag}-${name}.png`);
  await page.screenshot({ path: file });
  console.log("shot:", file);
  return file;
}

/** 滚轮拉近:分步派发,给渲染循环留出更新标签的时间。 */
async function zoomIn(page, cx, cy, notches) {
  await page.mouse.move(cx, cy);
  for (let i = 0; i < notches; i += 1) {
    await page.mouse.wheel(0, -120);
    await sleep(60);
  }
  await sleep(1200);
}

const files = {};

/* ---------- A. visualQa 夹具:P-101 单标签受控量测 ---------- */
{
  const browser = await playwright.chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-CN" });
  page.on("pageerror", (e) => console.log("pageerror:", String(e?.message ?? e).slice(0, 200)));
  await page.goto(`${origin}/?__visualQa=viewer&renderer=webgl&objects=120`, { waitUntil: "commit" });
  await page.waitForFunction(() => window.__viewerQa?.ready || window.__viewerQa?.error, undefined, { timeout: 60000 });
  await sleep(2500);
  files["qa-far"] = await shot(page, "qa-far");
  const cx = 720, cy = 450;
  await zoomIn(page, cx, cy, 10);
  files["qa-mid"] = await shot(page, "qa-mid");
  await zoomIn(page, cx, cy, 16);
  files["qa-near"] = await shot(page, "qa-near");
  await browser.close();
}

/* ---------- B. 真实场景 333:12 个设备标签 ---------- */
{
  const browser = await playwright.chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-CN" });
  page.on("pageerror", (e) => console.log("pageerror:", String(e?.message ?? e).slice(0, 200)));
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  const loginInput = page.locator("input[aria-label=用户名]");
  const manager = page.locator(".scene-manager-page");
  for (let i = 0; i < 40; i += 1) {
    if (await manager.isVisible().catch(() => false)) break;
    if (await loginInput.isVisible().catch(() => false)) break;
    await sleep(250);
  }
  if (await loginInput.isVisible().catch(() => false)) {
    await loginInput.fill("admin");
    await page.locator("input[aria-label=密码]").fill("admin");
    await page.getByRole("button", { name: "登录" }).click();
    await manager.waitFor({ timeout: 30000 });
  }
  const card = page.locator('.scene-card:has-text("333")').first();
  const editBtn = (await card.isVisible().catch(() => false))
    ? card.locator('button[aria-label="编辑场景"]')
    : page.locator('.scene-card button[aria-label="编辑场景"]').first();
  await editBtn.click({ timeout: 10000 });
  await sleep(3000);
  const mode3d = page.locator('.workspace-mode-switch button:text-is("三维")').first();
  if (await mode3d.isVisible().catch(() => false)) { await mode3d.click(); await sleep(5000); }
  const annoBtn = page.locator('button[aria-label*="标注"], button[title*="标注"]').first();
  if (await annoBtn.isVisible().catch(() => false)) { await annoBtn.click(); await sleep(1200); }
  files["s3-far"] = await shot(page, "s3-far");
  await zoomIn(page, 720, 480, 8);
  files["s3-mid"] = await shot(page, "s3-mid");
  await zoomIn(page, 720, 480, 12);
  files["s3-near"] = await shot(page, "s3-near");
  // 关掉标注工具再拍一张近景:验证幽灵暗块是否与标注工具态相关。
  const annoOff = page.locator('button[aria-label*="标注"], button[title*="标注"]').first();
  if (await annoOff.isVisible().catch(() => false)) { await annoOff.click(); await sleep(1200); }
  files["s3-near-noAnnoTool"] = await shot(page, "s3-near-noAnnoTool");
  await browser.close();
}

/* ---------- 像素量测 ---------- */
async function analyze(file) {
  const img = sharp(file);
  const { width, height } = await img.metadata();
  const raw = await img.raw().toBuffer();
  const lumAt = (x, y) => {
    const i = (y * width + x) * 3;
    return 0.2126 * raw[i] + 0.7152 * raw[i + 1] + 0.0722 * raw[i + 2];
  };
  const chroma = (x, y) => {
    const i = (y * width + x) * 3;
    const r = raw[i], g = raw[i + 1], b = raw[i + 2];
    return Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
  };
  // 文字像素:中性色且亮(标题 #e6ecef / 描述 #8f9da4)。
  const isText = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const L = lumAt(x, y);
      if (L >= 148 && chroma(x, y) <= 36) isText[y * width + x] = 1;
    }
  }
  // 连通域(8 邻接,带 1px 膨胀合并)提取文字簇。
  const visited = new Uint8Array(width * height);
  const clusters = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (!isText[p] || visited[p]) continue;
      let minX = x, maxX = x, minY = y, maxY = y, area = 0;
      const stack = [p];
      visited[p] = 1;
      while (stack.length) {
        const q = stack.pop();
        const qx = q % width, qy = (q / width) | 0;
        area += 1;
        if (qx < minX) minX = qx; if (qx > maxX) maxX = qx;
        if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;
        for (let dy = -2; dy <= 2; dy += 1) {
          const ny = qy + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -2; dx <= 2; dx += 1) {
            const nx = qx + dx;
            if (nx < 0 || nx >= width) continue;
            const np = ny * width + nx;
            if (isText[np] && !visited[np]) { visited[np] = 1; stack.push(np); }
          }
        }
      }
      if (area >= 60 && maxX - minX >= 14 && maxY - minY >= 8) clusters.push({ minX, maxX, minY, maxY, area });
    }
  }
  // 底板边界:从文字簇外沿向外走,允许穿越 ≤6px 的边框/间隙亮带。
  const boardOf = (c) => {
    const walk = (x0, y0, dx, dy) => {
      let x = x0, y = y0, gap = 0, last = 0;
      for (let step = 0; step < 420; step += 1) {
        x += dx; y += dy;
        if (x < 0 || y < 0 || x >= width || y >= height) break;
        const L = lumAt(x, y);
        if (L <= 46) { last = step; gap = 0; continue; }
        if (L <= 105 && chroma(x, y) <= 60) { gap += 1; if (gap > 6) break; continue; }
        break;
      }
      return { x: x0 + dx * (last + gap + 1), y: y0 + dy * (last + gap + 1) };
    };
    const cy = (c.minY + c.maxY) >> 1, cx = (c.minX + c.maxX) >> 1;
    const left = walk(c.minX, cy, -1, 0), right = walk(c.maxX, cy, 1, 0);
    const top = walk(cx, c.minY, 0, -1), bottom = walk(cx, c.maxY, 0, 1);
    return {
      left: left.x, right: right.x, top: top.y, bottom: bottom.y,
      width: right.x - left.x + 1, height: bottom.y - top.y + 1,
    };
  };
  const labels = clusters.map((c) => {
    const board = boardOf(c);
    return {
      text: { x: c.minX, y: c.minY, w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1 },
      board,
      boardTextRatio: Number((board.width / (c.maxX - c.minX + 1)).toFixed(2)),
    };
  }).sort((a, b) => a.text.x - b.text.x);
  // 底板互相叠压对数。
  let boardOverlaps = 0;
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const a = labels[i].board, b = labels[j].board;
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) boardOverlaps += 1;
    }
  }
  return { file, viewport: { width, height }, labelCount: labels.length, boardOverlaps, labels };
}

console.log("\n===== 量测结果 =====");
for (const [name, file] of Object.entries(files)) {
  try {
    const result = await analyze(file);
    console.log(`\n[${name}] ${file}`);
    console.log(JSON.stringify(result, null, 1));
    // 放大裁剪第一处标签区域作视觉证据。
    if (result.labels.length) {
      const l = result.labels[0];
      const cx = l.text.x + l.text.w / 2, cyy = l.text.y + l.text.h / 2;
      const left = Math.max(0, Math.round(cx - 260)), top = Math.max(0, Math.round(cyy - 70));
      await sharp(file).extract({ left, top, width: Math.min(560, 1440 - left), height: Math.min(150, 900 - top) })
        .resize(1120).toFile(file.replace(/\.png$/, "-zoom.png"));
    }
  } catch (e) {
    console.log(`[${name}] analyze failed: ${e.message}`);
  }
}
