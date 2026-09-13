// S2/S3/S7 第 2 轮复验:computed style 硬断言 + 截图 + 清理本轮与上轮拖入的测试组件。
// 用法: node scripts/fix-s2s3s7-verify-round2.mjs [origin]
import playwright from "../../../node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.js";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const phase = "after-r2";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "test-output", "fix-s2s3s7");
mkdirSync(outDir, { recursive: true });

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const assertions = [];

const browser = await playwright.chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
const page = await context.newPage();
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => errors.push(String(e?.message ?? e).slice(0, 200)));

function assert(name, ok, detail) {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
}

async function setTheme(theme) {
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  await sleep(400);
}
async function shot(name, clip = null) {
  await page.screenshot({ path: join(outDir, `${phase}-${name}.png`), clip: clip ?? undefined });
  console.log(`shot: ${phase}-${name}`);
}

// 登录
await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
await page.waitForLoadState("networkidle").catch(() => {});
const loginInput = page.locator("input[aria-label=用户名]");
for (let i = 0; i < 40; i++) {
  if (await page.locator(".scene-manager-page").isVisible().catch(() => false)) break;
  if (await loginInput.isVisible().catch(() => false)) {
    await loginInput.fill("admin");
    await page.locator("input[aria-label=密码]").fill("admin");
    await page.getByRole("button", { name: "登录" }).click();
    break;
  }
  await sleep(250);
}
await page.locator(".scene-manager-page").waitFor({ timeout: 30000 });
console.log("login ok");

// 进入看板编辑器(2D)
await page.goto(origin + "/manager?tab=scenes", { waitUntil: "domcontentloaded" });
await sleep(1800);
await page.locator('.scene-card button[aria-label="编辑场景"]').first().click();
await page.locator(".dashboard-page-bar").first().waitFor({ timeout: 30000 }).catch(() => {});
await sleep(2500);
const btn2d = page.locator('.workspace-mode-switch button:has-text("二维")').first();
if (await btn2d.isVisible().catch(() => false) && !(await btn2d.isDisabled().catch(() => true))) {
  await btn2d.click();
  await sleep(3000);
}
await page.locator(".dashboard-artboard").first().waitFor({ timeout: 20000 });
await sleep(1500);

/** 清理画布上所有非场景节点(测试残留),保留原始 3D 场景组件。 */
async function cleanupTestNodes() {
  for (let round = 0; round < 6; round++) {
    const nodes = page.locator(".dashboard-node").first();
    const count = await page.locator(".dashboard-node").count();
    let removed = false;
    for (let i = 0; i < count; i++) {
      const node = page.locator(".dashboard-node").nth(i);
      const isScene = (await node.locator(".dashboard-scene-viewport, .scene-viewport-preview").count()) > 0;
      if (isScene) continue;
      await node.click({ timeout: 4000, force: true });
      await sleep(500);
      const del = page.locator(".dashboard-delete-node").first();
      if (await del.isVisible().catch(() => false)) {
        await del.click({ timeout: 4000 });
        await sleep(900);
        removed = true;
        break; // DOM 变化,重新枚举
      }
    }
    if (!removed) break;
  }
  const left = await page.locator(".dashboard-node").count();
  console.log(`cleanup done, 剩余节点=${left}`);
}
await cleanupTestNodes();

// 拖入一个经营指标卡(到画布左上空白处,避开场景组件)
await page.locator('.dashboard-pages-panel button:has-text("资源")').first().click({ timeout: 5000 });
await sleep(1200);
const cardItem = page.locator('[draggable="true"]:has-text("经营指标卡")').first();
let dropped = false;
if (await cardItem.isVisible().catch(() => false)) {
  const source = await cardItem.boundingBox();
  const art = await page.locator(".dashboard-artboard").first().boundingBox();
  if (source && art) {
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(art.x + 90, art.y + 90, { steps: 12 });
    await page.mouse.up();
    await sleep(1200);
    dropped = true;
  }
}
console.log(`value card dropped=${dropped}`);

// ---------- computed style 硬断言(S7 + S2) ----------
const rulerProbe = await page.evaluate(() => {
  const spans = [...document.querySelectorAll(".dashboard-ruler.horizontal span")];
  if (!spans.length) return null;
  const cs = (el) => getComputedStyle(el);
  return {
    total: spans.length,
    firstFontSize: cs(spans[0]).fontSize,
    firstColor: cs(spans[0]).color,
    secondColor: spans[1] ? cs(spans[1]).color : null,
    family: cs(spans[0]).fontFamily,
  };
});
if (rulerProbe) {
  assert("S7 标尺字号 ≥10px", parseFloat(rulerProbe.firstFontSize) >= 10, `font-size=${rulerProbe.firstFontSize}`);
  assert("S7 偶数刻度文字隐藏(降密度)", rulerProbe.secondColor !== rulerProbe.firstColor, `奇=${rulerProbe.firstColor} 偶=${rulerProbe.secondColor}`);
}

const valueProbe = await page.evaluate(() => {
  const value = document.querySelector(".dashboard-node .dashboard-value");
  if (!value) return null;
  return { fvn: getComputedStyle(value).fontVariantNumeric, strong: getComputedStyle(value.querySelector("strong") ?? value).fontVariantNumeric };
});
if (valueProbe) {
  assert("S2 .dashboard-value tabular-nums", valueProbe.fvn.includes("tabular-nums"), `container=${valueProbe.fvn}`);
} else {
  assert("S2 .dashboard-value tabular-nums", false, "画布上未找到 .dashboard-value(拖入失败)");
}

const outputProbe = await page.evaluate(() => {
  const out = document.querySelector(".dashboard-canvas-toolbar output");
  return out ? getComputedStyle(out).fontVariantNumeric : null;
});
if (outputProbe) assert("S2 画布缩放 output tabular-nums", outputProbe.includes("tabular-nums"), outputProbe);

// ---------- 截图(深浅主题) ----------
await setTheme("dark");
await shot("dashboard-full-dark");
const ruler = await page.locator(".dashboard-ruler.horizontal").first().boundingBox().catch(() => null);
if (ruler) await shot("ruler-zoom-dark", { x: Math.max(0, ruler.x - 10), y: Math.max(0, ruler.y - 6), width: 620, height: 300 });
await setTheme("light");
await shot("dashboard-full-light");
if (ruler) await shot("ruler-zoom-light", { x: Math.max(0, ruler.x - 10), y: Math.max(0, ruler.y - 6), width: 620, height: 300 });
await shot("value-card-light", { x: Math.max(0, (await page.locator(".dashboard-artboard").first().boundingBox())?.x ?? 0), y: Math.max(0, (await page.locator(".dashboard-artboard").first().boundingBox())?.y ?? 0), width: 520, height: 380 });

// 清理本轮拖入的组件
await cleanupTestNodes();

// ---------- 层叠回归抽查:模板库弹层 + 三维模式 + 环境面板 + 设置页 ----------
await setTheme("dark");
try {
  await page.locator('.dashboard-pages-panel button:has-text("资源")').first().click({ timeout: 5000 });
  await sleep(900);
  await page.locator(".dashboard-library-template-button").first().click({ timeout: 6000 });
  await sleep(1400);
  await shot("layering-template-library-dark");
  const closeBtn = page.locator(".dashboard-template-library-panel > header button").first();
  if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
  else await page.keyboard.press("Escape");
  await sleep(700);
} catch (e) { console.log("template layering skipped:", String(e).slice(0, 100)); }

try {
  const btn3d = page.locator('.workspace-mode-switch button:has-text("三维")').first();
  if (await btn3d.isVisible().catch(() => false)) {
    await btn3d.click();
    await sleep(6000);
    await shot("studio3d-mode-dark");
    const envBtn = page.locator('button[title*="环境与灯光"], button[title*="环境"]').first();
    if (await envBtn.isVisible().catch(() => false)) {
      await envBtn.click({ timeout: 3000 }).catch(() => {});
      await sleep(1300);
      await shot("studio3d-env-panel-dark");
    }
  }
} catch (e) { console.log("3d skipped:", String(e).slice(0, 100)); }

try {
  await page.goto(origin + "/manager?tab=settings", { waitUntil: "domcontentloaded" });
  await sleep(2200);
  await setTheme("light");
  await shot("settings-light");
} catch (e) { console.log("settings skipped:", String(e).slice(0, 100)); }

console.log("=== 汇总 ===");
const failed = assertions.filter((a) => !a.ok);
console.log(JSON.stringify({ assertions: assertions.length, failed: failed.length, consoleErrorCount: errors.length, consoleErrors: errors.slice(0, 5) }, null, 2));
await browser.close();
process.exit(failed.length ? 1 : 0);
