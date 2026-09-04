// U1-3 调查第二轮：3D 工作台更多、2D 脚本面板布局菜单、发布页工具坞"更多视图工具"。
import { existsSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const { chromium } = playwright;
const origin = process.env.TARGET_ORIGIN ?? "http://127.0.0.1:5173";
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const outputRoot = resolve("test-output/nightly-2026-09-05");
if (!existsSync(outputRoot)) mkdirSync(outputRoot, { recursive: true });

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200)); });
page.on("pageerror", (err) => consoleErrors.push(`PAGEERROR ${String(err).slice(0, 200)}`));

const results = [];
async function describeMenu(locator, name) {
  return locator.evaluate((menu) => {
    const rect = menu.getBoundingClientRect();
    const style = getComputedStyle(menu);
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const top = cy >= 0 && cy <= innerHeight ? document.elementFromPoint(cx, cy) : null;
    return {
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      visible: style.display !== "none" && style.visibility !== "hidden",
      zIndex: style.zIndex,
      onScreen: rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight,
      hitTestInMenu: top ? menu.contains(top) : false,
      occludedBy: top && !menu.contains(top) ? `${top.tagName}.${String(top.className).slice(0, 50)}` : null,
    };
  }).then((info) => ({ name, ...info }));
}

try {
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3_000);

  // 取一个真实 sceneId（经页面上下文带令牌调 API）
  const sceneId = await page.evaluate(async () => {
    const token = Object.entries(localStorage).find(([k]) => /token|auth/i.test(k))?.[1];
    let bearer = null;
    try { bearer = JSON.parse(token)?.accessToken ?? token; } catch { bearer = token; }
    const projects = await fetch("/api/projects", { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }).then((r) => r.json());
    for (const project of projects.slice(0, 3)) {
      const scenes = await fetch(`/api/projects/${project.id}/scenes`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }).then((r) => r.json()).catch(() => []);
      if (Array.isArray(scenes) && scenes.length > 0) return scenes[0].id ?? scenes[0].sceneId ?? null;
    }
    return null;
  });
  results.push({ step: "scene-lookup", sceneId });

  // 入口 3：3D 工作台顶栏"更多场景工具"
  if (sceneId) {
    await page.goto(`${origin}/studio/${sceneId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(9_000);
    const wsMore = page.locator(".scene-workspace-more").first();
    if (await wsMore.count() > 0) {
      await wsMore.locator("summary").first().click();
      await page.waitForTimeout(600);
      const open = await wsMore.evaluate((el) => el.open);
      const menu = open ? await describeMenu(page.locator(".scene-workspace-more-popover").first(), "workspace-more-popover") : { missing: true };
      results.push({ step: "studio3d-workspace-more", open, menu });
      await page.screenshot({ path: resolve(outputRoot, "u13-studio3d-more.png") });
      if (open) await wsMore.locator("summary").first().click();
    } else {
      results.push({ step: "studio3d-workspace-more", note: "未找到入口", url: page.url() });
      await page.screenshot({ path: resolve(outputRoot, "u13-studio3d-noentry.png") });
    }

    // 入口 5：发布浏览页工具坞"更多视图工具"（button 状态型）
    await page.goto(`${origin}/published/${sceneId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(9_000);
    const dockMore = page.locator("button[title='更多视图工具'], button[aria-label='更多视图工具']").first();
    if (await dockMore.count() > 0) {
      await dockMore.click();
      await page.waitForTimeout(600);
      const pressed = await dockMore.getAttribute("aria-pressed");
      const popover = page.locator(".published-tool-more-popover, [class*='tool-more'], [class*='more-panel']").first();
      const menu = (await popover.count()) > 0 ? await describeMenu(popover, "published-more") : { missing: true, note: "点击后未找到弹层元素" };
      results.push({ step: "published-dock-more", pressed, menu });
      await page.screenshot({ path: resolve(outputRoot, "u13-published-more.png") });
    } else {
      results.push({ step: "published-dock-more", note: "未找到工具坞更多按钮", url: page.url() });
      await page.screenshot({ path: resolve(outputRoot, "u13-published-nodock.png") });
    }
  }

  // 入口 4：2D 页面编辑器 行为面板布局菜单（behavior-layout-menu details）
  const editButton = page.locator(".scene-card-actions button[aria-label='编辑场景']").first();
  await page.goto(`${origin}/manager`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3_000);
  if (await editButton.count() > 0) {
    await editButton.click();
    await page.waitForTimeout(8_000);
    const layoutMenu = page.locator(".behavior-layout-menu").first();
    if (await layoutMenu.count() > 0) {
      await layoutMenu.locator("summary").first().click();
      await page.waitForTimeout(500);
      const open = await layoutMenu.evaluate((el) => el.open);
      const menu = open ? await describeMenu(page.locator(".behavior-header-menu-popover, .behavior-layout-menu > div").last(), "behavior-layout-menu") : { missing: true };
      results.push({ step: "dashboard-behavior-layout-menu", open, menu });
      await page.screenshot({ path: resolve(outputRoot, "u13-behavior-layout.png") });
    } else {
      results.push({ step: "dashboard-behavior-layout-menu", note: "2D 页面未找到布局菜单（可能面板折叠）", url: page.url() });
      await page.screenshot({ path: resolve(outputRoot, "u13-dashboard-nomenu.png") });
    }
  }
} catch (error) {
  results.push({ step: "fatal", error: String(error).slice(0, 400) });
  await page.screenshot({ path: resolve(outputRoot, "u13b-fatal.png") }).catch(() => {});
}

results.push({ consoleErrors: consoleErrors.slice(0, 8) });
writeFileSync(resolve(outputRoot, "u13-round2.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
await browser.close();
