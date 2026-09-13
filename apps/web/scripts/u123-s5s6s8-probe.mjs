// S5/S6/S8 浏览器验证探针:断连横幅、409 保存反馈、编辑场景记忆落点。非正式门禁,可重跑。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const output = resolve("test-output/fix-s5s6s8");
mkdirSync(output, { recursive: true });
const origin = "http://127.0.0.1:5173";
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const result = {};

try {
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  if (await page.getByLabel("用户名").count()) {
    await page.getByLabel("用户名").fill("admin");
    await page.getByLabel("密码").fill("admin");
    await page.getByRole("button", { name: "登录" }).click();
  }
  await page.waitForTimeout(3000);

  // ── S5:拦截 /api/** 返回 503 两次以上 → 横幅出现;放行 → 恢复提示 → 自动收起 ──
  await page.route("**/api/**", route => route.fulfill({ status: 503, body: "service unavailable" }));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".network-status-banner.is-degraded", { timeout: 20000 });
  await page.screenshot({ path: resolve(output, "s5-degraded.png") });
  result.s5Degraded = await page.locator(".network-status-banner").textContent();
  await page.unroute("**/api/**");
  await page.waitForSelector(".network-status-banner.is-recovered", { timeout: 20000 });
  await page.screenshot({ path: resolve(output, "s5-recovered.png") });
  await page.waitForSelector(".network-status-banner", { state: "detached", timeout: 8000 });
  result.s5RecoveredAutoDismiss = true;

  // ── S8:进入项目(默认二维)→ 从看板切到三维(写入记忆)→ 回列表再点"编辑场景" → 应落三维 ──
  const editButton = page.getByRole("button", { name: "编辑场景" }).first();
  await editButton.waitFor({ timeout: 20000 });
  await editButton.click();
  await page.waitForTimeout(5000);
  result.s8DefaultView = page.url();
  // 看板内切三维入口(工具栏"三维"/"打开三维");若无则直接命中失败,记录后继续。
  const to3d = page.getByRole("button", { name: /三维|3D/ }).first();
  if (await to3d.count()) {
    await to3d.click();
    await page.waitForTimeout(6000);
    result.s8StudioUrl = page.url();
    // 回项目列表,再次"编辑场景"应按记忆落三维(/scenes/)
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    await page.getByRole("button", { name: "编辑场景" }).first().click();
    await page.waitForTimeout(5000);
    result.s8RememberedView = page.url();
    result.s8RememberedIsStudio = !page.url().includes("/pages/");
    await page.screenshot({ path: resolve(output, "s8-remembered-studio.png") });
  } else {
    result.s8To3dEntry = "未找到看板内三维入口,未验证记忆链路";
  }

  // ── S6:回默认二维(清记忆),拦截保存接口 409 → 点"保存" → 冲突指引 ──
  await page.evaluate(() => {
    for (const key of Object.keys(window.localStorage)) if (key.startsWith("bim-studio:last-workspace:")) window.localStorage.removeItem(key);
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  await page.getByRole("button", { name: "编辑场景" }).first().click();
  await page.waitForTimeout(5000);
  // 制造脏状态(新增空白页面),否则保存按钮禁用
  const addPage = page.getByRole("button", { name: /新增.*页面/ }).first();
  if (await addPage.count()) {
    await addPage.click();
    await page.waitForTimeout(1200);
    result.s6DirtyMade = true;
  }
  result.s8DashboardUrlBeforeSave = page.url();

  // ── S6:拦截保存接口返回 409 → 点"保存" → 出现冲突指引文案 ──
  await page.route("**/applications/**", route => {
    if (["PUT", "POST"].includes(route.request().method())) {
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "应用已被其他修改更新", currentRevision: 8 }) });
    }
    return route.fallback();
  });
  await page.getByRole("button", { name: "保存", exact: true }).first().click();
  await page.waitForTimeout(1500);
  const pageText = await page.locator("body").textContent();
  result.s6GuidanceShown = pageText?.includes("检测到其他页面或进程已保存新版本") ?? false;
  await page.screenshot({ path: resolve(output, "s6-conflict-guidance.png") });
  await page.unroute("**/applications/**");
} catch (error) {
  result.error = String(error).slice(0, 300);
  await page.screenshot({ path: resolve(output, "probe-failed.png") }).catch(() => undefined);
}
console.log(JSON.stringify(result, null, 2));
await browser.close();
