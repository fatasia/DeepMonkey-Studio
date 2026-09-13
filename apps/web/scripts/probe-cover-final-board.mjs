// 封面质量终态证据:模板库弹窗 + 资源页模板 tab(双主题),并输出与竞品的并排对照板。
// 用法:node scripts/probe-cover-final-board.mjs [origin]
import fs from "node:fs";
import path from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import sharp from "sharp";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const outDir = path.resolve("test-output/cover-quality/final");
fs.mkdirSync(outDir, { recursive: true });
const competitor = path.resolve("../../test-output/competitor-ref");
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const errors = [];

function watch(page, tag) {
  page.on("pageerror", (e) => errors.push(`[${tag}][pageerror] ${String(e.message).slice(0, 200)}`));
}

async function login(page) {
  const user = page.getByLabel(/用户名|Username/).first();
  if (await user.isVisible().catch(() => false)) {
    await user.fill("admin");
    await page.getByLabel(/密码|Password/).first().fill("admin");
    await page.getByRole("button", { name: /登录|Sign in/i }).first().click();
    await page.waitForTimeout(2200);
  }
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

// 1) 模板库弹窗全貌(双主题,含套件行 + 推荐行)
for (const theme of ["dark", "light"]) {
  const page = await browser.newPage({ viewport: { width: 1680, height: 980 }, deviceScaleFactor: 1.5 });
  watch(page, theme);
  await page.goto(`${origin}/?__visualQa=dashboard&theme=${theme}`, { waitUntil: "load" });
  await page.waitForTimeout(3200);
  if (!(await openTemplateLibrary(page))) { errors.push(`[${theme}] library entry missing`); await page.close(); continue; }
  const panel = page.locator(".dashboard-template-library-panel").first();
  const box = await panel.boundingBox();
  await page.screenshot({ path: path.join(outDir, `library-all-${theme}.png`), clip: box ? { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 940) } : undefined });
  console.log(`shot library-all-${theme}`);
  await page.close();
}

// 2) 资源页模板 tab(双主题)
for (const theme of ["dark", "light"]) {
  const page = await browser.newPage({ viewport: { width: 1680, height: 980 }, deviceScaleFactor: 1.5 });
  watch(page, `assets-${theme}`);
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForTimeout(1400);
  await login(page);
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  const assetsTab = page.locator('button[aria-label="资源"], button[aria-label="Assets"]').first();
  if (await assetsTab.isVisible().catch(() => false)) { await assetsTab.click(); await page.waitForTimeout(1500); }
  const kindTemplate = page.locator('button:has-text("看板模板")').first();
  if (await kindTemplate.isVisible().catch(() => false)) { await kindTemplate.click(); await page.waitForTimeout(1400); }
  await page.screenshot({ path: path.join(outDir, `assets-templates-${theme}.png`) });
  console.log(`shot assets-templates-${theme}`);
  await page.close();
}
await browser.close();

// 3) 对照板:左=竞品实机,右=本产品终态(FVS 浅色对照用帆软,深色对照用山海鲸)。
const LABEL_HEIGHT = 52;
const TARGET_HEIGHT = 860;
const GAP = 24;
async function compose(key, labelLeft, leftFile, labelRight, rightFile) {
  const leftPath = path.isAbsolute(leftFile) ? leftFile : path.resolve(competitor, leftFile);
  const rightPath = path.isAbsolute(rightFile) ? rightFile : path.resolve(outDir, rightFile);
  const left = sharp(leftPath);
  const right = sharp(rightPath);
  const leftMeta = await left.metadata();
  const rightMeta = await right.metadata();
  const leftH = TARGET_HEIGHT, rightH = TARGET_HEIGHT;
  const leftW = Math.round((leftMeta.width / leftMeta.height) * leftH);
  const rightW = Math.round((rightMeta.width / rightMeta.height) * rightH);
  const width = leftW + GAP + rightW;
  const height = LABEL_HEIGHT + TARGET_HEIGHT;
  const labelSvg = Buffer.from(`<svg width="${width}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${LABEL_HEIGHT}" fill="#111518"/>
    <text x="${Math.round(leftW / 2)}" y="34" font-size="24" fill="#e6b34c" text-anchor="middle" font-family="Microsoft YaHei">${labelLeft}</text>
    <text x="${leftW + GAP + Math.round(rightW / 2)}" y="34" font-size="24" fill="#4dc9c4" text-anchor="middle" font-family="Microsoft YaHei">${labelRight}</text>
  </svg>`);
  await sharp({ create: { width, height, channels: 3, background: { r: 17, g: 21, b: 24 } } })
    .composite([
      { input: labelSvg, top: 0, left: 0 },
      { input: await left.resize({ height: leftH }).toBuffer(), top: LABEL_HEIGHT, left: 0 },
      { input: await right.resize({ height: rightH }).toBuffer(), top: LABEL_HEIGHT, left: leftW + GAP },
    ])
    .png()
    .toFile(path.resolve(outDir, key));
  console.log(`composed ${key}`);
}
// 深浅双对照 + 升级前后对照(同一域同机位)
await compose("board-market-dark.png", "山海鲸 模板市场(竞品)", "shanhaibi-market-viewport.png", "Deep Monkey 模板库·深色(本产品终态)", "library-all-dark.png");
await compose("board-market-light.png", "帆软 模板市场(竞品)", "fanruan-templates-viewport.png", "Deep Monkey 模板库·浅色(本产品终态)", "library-all-light.png");
await compose("board-before-after.png", "本产品·升级前(before)", path.resolve(outDir, "../before/production-dark.png"), "本产品·升级后(final)", path.resolve(outDir, "production-dark.png"));

fs.writeFileSync(path.join(outDir, "console-errors.log"), errors.join("\n") || "(no console errors)");
console.log(`errors(${errors.length})`);
console.log("final board done");
