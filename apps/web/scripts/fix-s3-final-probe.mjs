// S3 z-index 收敛·层叠回归抽查(fix-s3-final):
// ①管理台场景卡更多菜单 vs 其他浮层 ②模板库弹窗+backdrop ③3D 编辑器导出菜单/更多菜单/资源浮窗
// ④看板编辑器节点右键菜单 ⑤网络横幅与 toast 叠放;深浅主题各抽 2 项。
// 用法: node scripts/fix-s3-final-probe.mjs [origin] [before|after]
import playwright from "../../../node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.js";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const phase = process.argv[3] ?? "before";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "test-output", "fix-s3-final", phase);
mkdirSync(outDir, { recursive: true });

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const steps = [];

const browser = await playwright.chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
const page = await context.newPage();
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
page.on("pageerror", (e) => errors.push(String(e?.message ?? e).slice(0, 300)));

async function shot(name, clip = null) {
  const file = `${name}.png`;
  await page.screenshot({ path: join(outDir, file), clip: clip ?? undefined });
  console.log(`shot: ${phase}/${file}`);
  steps.push(file);
}

async function setTheme(theme) {
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  await sleep(400);
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
  if (!(await loginInput.isVisible().catch(() => false))) throw new Error("既不见登录页也不见管理台 · " + page.url());
  await loginInput.fill("admin");
  await page.locator("input[aria-label=密码]").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await manager.waitFor({ timeout: 30000 });
  return "loggedIn";
}

await ensureLoggedIn();
console.log("login ok");

// ---------- ① 管理台:场景卡更多菜单(z 30)+ 顶栏更多工具菜单(z 20)+ 项目切换菜单(z 50) ----------
try {
  await page.goto(origin + "/manager?tab=scenes", { waitUntil: "domcontentloaded" });
  await sleep(2000);
  const cardMore = page.locator('.scene-card-more > summary[aria-label="更多场景操作"]').first();
  if (await cardMore.isVisible().catch(() => false)) {
    await cardMore.click();
    await sleep(600);
    await shot("01-manager-card-more-menu-dark");
    await cardMore.click().catch(() => {}); // 再次点击 summary 收起
    await sleep(400);
  } else { console.log("① 场景卡更多按钮不可见(可能无场景卡)"); }
  const headerMore = page.locator('summary[aria-label="项目管理"]').first();
  if (await headerMore.isVisible().catch(() => false)) {
    await headerMore.click({ force: true, timeout: 5000 });
    await sleep(600);
    await shot("01-manager-project-menu-dark");
    await headerMore.click({ force: true, timeout: 5000 }).catch(() => {});
    await sleep(400);
  } else { console.log("① 顶栏项目管理菜单不可见,跳过"); }
} catch (e) { console.log("① 失败:", String(e).slice(0, 200)); }

// ---------- 进入看板编辑器(二维),准备 ②④ ----------
await page.goto(origin + "/manager?tab=scenes", { waitUntil: "domcontentloaded" });
await sleep(1500);
const editBtn = page.locator('.scene-card button[aria-label="编辑场景"]').first();
if (!(await editBtn.isVisible().catch(() => false))) throw new Error("找不到编辑场景按钮");
await editBtn.click();
await page.locator(".dashboard-page-bar").first().waitFor({ timeout: 30000 }).catch(() => {});
await sleep(2500);
const btn2d = page.locator('.workspace-mode-switch button:has-text("二维")').first();
if (await btn2d.isVisible().catch(() => false) && !(await btn2d.isDisabled().catch(() => true))) {
  await btn2d.click();
  await sleep(3000);
}
await page.locator(".dashboard-artboard").first().waitFor({ timeout: 20000 }).catch(() => {});
await sleep(1200);

// ---------- ④ 看板编辑器:组件右键菜单(z 80) ----------
try {
  await page.locator('.dashboard-pages-panel button:has-text("资源"), button:has-text("资源")').first().click({ timeout: 5000 });
  await sleep(1000);
  const item = page.locator('[draggable="true"]:has-text("经营指标卡"), [draggable="true"]:has-text("指标卡")').first();
  if (await item.isVisible().catch(() => false)) {
    await page.dragAndDrop('[draggable="true"]:has-text("经营指标卡"), [draggable="true"]:has-text("指标卡")', ".dashboard-artboard", { timeout: 8000 });
    await sleep(1200);
  }
  const node = page.locator(".dashboard-node").first();
  if (await node.isVisible().catch(() => false)) {
    await node.click({ button: "right", force: true });
    await sleep(600);
    await shot("04-dashboard-node-context-menu-dark");
    await page.keyboard.press("Escape").catch(() => {});
    await page.mouse.click(400, 700);
    await sleep(400);
  } else { console.log("④ 无 dashboard-node,右键菜单跳过"); }
} catch (e) { console.log("④ 失败:", String(e).slice(0, 200)); }

// ---------- ② 模板库弹窗 + backdrop(遮罩 60,深浅双主题) ----------
for (const theme of ["dark", "light"]) {
  try {
    await setTheme(theme);
    // 模板库入口在左栏"模板"页签下
    const tplTab = page.locator('.dashboard-left-tabs button:has-text("模板"), .dashboard-pages-panel button:has-text("模板"), button[title="模板"]').first();
    if (await tplTab.isVisible().catch(() => false)) {
      await tplTab.click();
      await sleep(900);
    }
    await page.locator('[aria-label="看板模板库"]').first().click({ timeout: 6000 });
    await sleep(1200);
    await shot(`02-template-library-${theme}`);
    // 用面板头部关闭按钮收起(Escape 对该弹窗不可靠,残留 backdrop 会级联阻塞后续步骤)
    const closeBtn = page.locator('.dashboard-template-library-panel > header button').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
    } else {
      await page.keyboard.press("Escape");
    }
    await page.locator(".dashboard-template-library-backdrop").waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
    await sleep(600);
  } catch (e) { console.log(`② ${theme} 失败:`, String(e).slice(0, 200)); }
}
await setTheme("dark");

// ---------- ③ 切三维:更多菜单 / 导出菜单(弹层内) / 资源浮窗 ----------
try {
  // 确保无残留遮罩
  await page.locator(".dashboard-template-library-backdrop").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  const btn3d = page.locator('.workspace-mode-switch button:has-text("三维")').first();
  if (await btn3d.isVisible().catch(() => false)) {
    await btn3d.click({ timeout: 8000 });
    await sleep(6000);
  } else { console.log("③ 无三维开关(可能已在三维)"); }
  const moreMenu = page.locator('summary[aria-label="更多场景工具"]').first();
  if (await moreMenu.isVisible().catch(() => false)) {
    await moreMenu.click();
    await sleep(700);
    await shot("03-3d-more-popover-dark");
    // 导出菜单在更多弹层内部(紧凑导出按钮)
    const exportInPopover = page.locator('button[aria-label="导出场景"]').first();
    if (await exportInPopover.isVisible().catch(() => false)) {
      await exportInPopover.click();
      await sleep(700);
      await shot("03-3d-export-menu-dark");
    }
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(400);
  } else { console.log("③ 更多菜单不可见"); }
  const resBtn = page.locator('button[aria-label="资源"], button[title="资源"]').first();
  if (await resBtn.isVisible().catch(() => false)) {
    await resBtn.click();
    await sleep(1500);
    await shot("03-3d-resource-floating-dark");
  } else { console.log("③ 资源浮窗按钮不可见"); }
} catch (e) { console.log("③ 失败:", String(e).slice(0, 200)); }

// ---------- ⑤ 网络横幅(503 拦截)+ toast 叠放;浅色主题复测 3D 更多菜单 ----------
try {
  let bannerGone = false;
  await context.route(/\/api\/projects/, async (route) => {
    if (bannerGone) return route.fallback();
    return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"probe 503"}' });
  });
  // 触发若干在线请求让监控进入降级
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(4000);
  await shot("05-network-banner-dark");
  // 浅色主题抽 2 项之一:横幅在浅色下
  await setTheme("light");
  await shot("05-network-banner-light");
  bannerGone = true;
  await context.unroute(/\/api\/projects/);
  await sleep(4500); // 等自动恢复横幅收起
  await setTheme("dark");
} catch (e) { console.log("⑤ 失败:", String(e).slice(0, 200)); }

console.log("--- console errors ---");
for (const line of errors.slice(-20)) console.log(line);
console.log(JSON.stringify({ phase, steps, consoleErrorCount: errors.length }, null, 2));
await browser.close();
