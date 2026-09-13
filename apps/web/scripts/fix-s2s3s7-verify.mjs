// S2/S3/S7 样式治理修复验证:标尺刻度截图(tabular/字号/密度)+ 弹层层叠回归抽查。
// 用法: node scripts/fix-s2s3s7-verify.mjs [origin] [before|after]
// playwright-core 经 pnpm 安装于仓库根 .pnpm(cloud-render-worker 本地副本已被并行整理移除)。
import playwright from "../../../node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.js";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const phase = process.argv[3] ?? "after";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "test-output", "fix-s2s3s7");
mkdirSync(outDir, { recursive: true });

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const browser = await playwright.chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
const page = await context.newPage();
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
page.on("pageerror", (e) => errors.push(String(e?.message ?? e).slice(0, 300)));

async function shot(name, clip = null) {
  const file = `${phase}-${name}.png`;
  await page.screenshot({ path: join(outDir, file), clip: clip ?? undefined });
  console.log(`shot: ${file}`);
}

/** 登录(已登录则跳过)。 */
async function ensureLoggedIn() {
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  const loginInput = page.locator("input[aria-label=用户名]");
  const manager = page.locator(".scene-manager-page");
  for (let i = 0; i < 40; i++) {
    if (await manager.isVisible().catch(() => false)) return "already";
    if (await loginInput.isVisible().catch(() => false)) break;
    await sleep(250);
  }
  if (!(await loginInput.isVisible().catch(() => false))) {
    const body = (await page.locator("body").innerText().catch(() => "<no body>")).slice(0, 400).replace(/\n/g, " | ");
    throw new Error(`既不见登录页也不见管理台 · URL=${page.url()} · body=${body}`);
  }
  await loginInput.fill("admin");
  await page.locator("input[aria-label=密码]").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await manager.waitFor({ timeout: 30000 }).catch(async () => {
    const body = (await page.locator("body").innerText().catch(() => "<no body>")).slice(0, 400).replace(/\n/g, " | ");
    console.log(`登录后未见管理台 · URL=${page.url()} · body=${body}`);
    console.log("console errors:", errors.slice(-6).join(" || "));
  });
  if (!(await manager.isVisible().catch(() => false))) throw new Error("登录后管理台未出现");
  return "loggedIn";
}

/** 切主题(直接写 data-theme,避免依赖设置页 DOM)。 */
async function setTheme(theme) {
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  await sleep(400);
}

await ensureLoggedIn();
console.log("login ok");

// ---------- 1. 看板编辑器:标尺区域特写 ----------
await page.goto(origin + "/manager?tab=scenes", { waitUntil: "domcontentloaded" });
await sleep(1800);
const editBtn = page.locator('.scene-card button[aria-label="编辑场景"]').first();
if (!(await editBtn.isVisible().catch(() => false))) throw new Error("找不到编辑场景按钮");
await editBtn.click();
await page.locator(".dashboard-page-bar").first().waitFor({ timeout: 30000 }).catch(() => {});
await sleep(2500);
// 工作区可能记忆了三维模式,标尺仅存在于二维看板,先强制切回二维(已是二维时按钮 disabled,跳过)
const btn2d = page.locator('.workspace-mode-switch button:has-text("二维")').first();
if (await btn2d.isVisible().catch(() => false) && !(await btn2d.isDisabled().catch(() => true))) {
  await btn2d.click();
  await sleep(3000);
}
await page.locator(".dashboard-artboard").first().waitFor({ timeout: 20000 }).catch(() => {});
await sleep(1500);

for (const theme of ["dark", "light"]) {
  await setTheme(theme);
  await shot(`dashboard-ruler-${theme}`);
  // 标尺左上角特写(水平+垂直标尺交汇区,以水平标尺 bbox 为锚)
  const ruler = await page.locator(".dashboard-ruler.horizontal").first().boundingBox().catch(() => null);
  if (ruler) {
    await shot(`ruler-zoom-${theme}`, { x: Math.max(0, ruler.x - 10), y: Math.max(0, ruler.y - 6), width: 620, height: 300 });
  } else {
    console.log("no ruler bbox, skip ruler zoom crop");
  }
}

// 数字组件抽查:打开左侧"资源"tab 拖一个数值卡进画布(失败不阻断,标尺为主验证目标)
try {
  await page.locator('.dashboard-pages-panel button:has-text("资源"), button:has-text("资源")').first().click({ timeout: 5000 });
  await sleep(1200);
  const item = page.locator('.dashboard-library-browser [draggable="true"]:has-text("经营指标卡"), [draggable="true"]:has-text("指标卡")').first();
  if (await item.isVisible().catch(() => false)) {
    await page.dragAndDrop('[draggable="true"]:has-text("经营指标卡"), [draggable="true"]:has-text("指标卡")', ".dashboard-artboard", { timeout: 8000 });
    await sleep(1200);
  } else { console.log("value card item not visible"); }
  await setTheme("dark");
  await shot("dashboard-value-card-dark");
  await setTheme("light");
  await shot("dashboard-value-card-light");
} catch (e) { console.log("value-card step skipped:", String(e).slice(0, 120)); }

// ---------- 2. 层叠回归抽查:模板库弹层(60)、三维模式 ----------
await setTheme("dark");
try {
  await page.locator(".dashboard-template-library-trigger").first().click({ timeout: 6000 });
  await sleep(1200);
  await shot("layering-template-library-dark");
  await page.keyboard.press("Escape");
  await sleep(600);
} catch (e) { console.log("template layering skipped:", String(e).slice(0, 120)); }

// 三维模式切换(工作区模式开关)
try {
  const btn3d = page.locator('.workspace-mode-switch button:has-text("三维")').first();
  if (await btn3d.isVisible().catch(() => false)) {
    await btn3d.click();
    await sleep(6000);
    await shot("studio3d-mode-dark");
    const envBtn = page.locator('button[title*="环境"], button:has-text("环境")').first();
    if (await envBtn.isVisible().catch(() => false)) {
      await envBtn.click({ timeout: 3000 }).catch(() => {});
      await sleep(1200);
      await shot("studio3d-env-panel-dark");
    }
  }
} catch (e) { console.log("3d mode skipped:", String(e).slice(0, 120)); }

// ---------- 3. 设置页(管理端)浅色 ----------
try {
  await page.goto(origin + "/manager?tab=settings", { waitUntil: "domcontentloaded" });
  await sleep(2000);
  await setTheme("light");
  await shot("settings-light");
  await setTheme("dark");
  await shot("settings-dark");
} catch (e) { console.log("settings skipped:", String(e).slice(0, 120)); }

console.log("--- console errors ---");
for (const line of errors.slice(-20)) console.log(line);
console.log(JSON.stringify({ phase, consoleErrorCount: errors.length }));
await browser.close();
