// U1-3 调查：多页面"更多"点击是否无效。指向运行中的 dev server，逐入口实测。
import { existsSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const { chromium } = playwright;
const origin = process.env.TARGET_ORIGIN ?? "http://127.0.0.1:5173";
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const outputRoot = resolve("test-output/nightly-2026-09-05");
if (!existsSync(outputRoot)) mkdirSync(outputRoot, { recursive: true });
if (!existsSync(chromePath)) throw new Error(`Chrome 不存在：${chromePath}`);

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300)); });
page.on("pageerror", (err) => consoleErrors.push(`PAGEERROR ${String(err).slice(0, 300)}`));

const results = [];

async function login() {
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3_000);
}

function describeMenu(locator, name) {
  return locator.evaluate((menu) => {
    const rect = menu.getBoundingClientRect();
    const style = getComputedStyle(menu);
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const topElement = cy >= 0 && cy <= innerHeight && cx >= 0 && cx <= innerWidth ? document.elementFromPoint(cx, cy) : null;
    const inMenu = topElement ? menu.contains(topElement) : false;
    return {
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      display: style.display,
      visibility: style.visibility,
      zIndex: style.zIndex,
      position: style.position,
      onScreen: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth,
      hitTestInMenu: inMenu,
      hitTestTag: topElement ? `${topElement.tagName}.${String(topElement.className).slice(0, 60)}` : "null",
    };
  }).then((info) => ({ name, ...info }));
}

try {
  await login();
  results.push({ step: "login", ok: true, url: page.url() });

  // 入口 1：场景管理页 场景卡"更多"（details/summary 原生开合）
  const card = page.locator(".scene-card").first();
  const cardCount = await page.locator(".scene-card").count();
  if (cardCount > 0) {
    await card.scrollIntoViewIfNeeded();
    const summary = card.locator(".scene-card-more > summary").first();
    const moreDetails = card.locator(".scene-card-more").first();
    const before = await moreDetails.evaluate((el) => el.open);
    await summary.click();
    await page.waitForTimeout(600);
    const after = await moreDetails.evaluate((el) => el.open);
    const menuInfo = after ? await describeMenu(card.locator(".scene-card-more-menu").first(), "scene-card-more-menu") : { name: "scene-card-more-menu", missing: true };
    results.push({ step: "manager-scene-card-more", cardCount, openBefore: before, openAfterClick: after, menu: menuInfo });
    await page.screenshot({ path: resolve(outputRoot, "u13-manager-card-more.png") });
    // 再点一次收起，验证可关
    if (after) { await summary.click(); await page.waitForTimeout(300); }
  } else {
    results.push({ step: "manager-scene-card-more", note: "无场景卡（可能项目为空或存储拓扑指向本地）", url: page.url() });
    await page.screenshot({ path: resolve(outputRoot, "u13-manager-empty.png") });
  }

  // 入口 2：项目管理汇总的 details（页头"项目管理"）
  const projectSummary = page.locator("summary[aria-label='项目管理']").first();
  if (await projectSummary.count() > 0) {
    const details = page.locator("details:has(> summary[aria-label='项目管理'])").first();
    await projectSummary.click();
    await page.waitForTimeout(400);
    const open = await details.evaluate((el) => el.open);
    results.push({ step: "manager-project-more", openAfterClick: open });
    if (open) await projectSummary.click();
  }

  // 入口 3：3D 编辑器顶栏"更多场景工具"（打开第一个场景）
  const editButton = page.locator(".scene-card-actions button[aria-label='编辑场景']").first();
  if (cardCount > 0 && await editButton.count() > 0) {
    await editButton.click();
    await page.waitForTimeout(8_000);
    const wsMore = page.locator(".scene-workspace-more").first();
    if (await wsMore.count() > 0) {
      const summary = wsMore.locator("summary").first();
      await summary.click();
      await page.waitForTimeout(600);
      const open = await wsMore.evaluate((el) => el.open);
      const menuInfo = open ? await describeMenu(page.locator(".scene-workspace-more-popover").first(), "scene-workspace-more-popover") : { name: "popover", missing: true };
      results.push({ step: "editor-workspace-more", openAfterClick: open, menu: menuInfo });
      await page.screenshot({ path: resolve(outputRoot, "u13-editor-workspace-more.png") });
      if (open) await summary.click();
    } else {
      results.push({ step: "editor-workspace-more", note: "编辑器内未找到 .scene-workspace-more", url: page.url() });
      await page.screenshot({ path: resolve(outputRoot, "u13-editor-nomore.png") });
    }
  }
} catch (error) {
  results.push({ step: "fatal", error: String(error).slice(0, 500) });
  await page.screenshot({ path: resolve(outputRoot, "u13-fatal.png") }).catch(() => {});
}

results.push({ consoleErrors: consoleErrors.slice(0, 10) });
writeFileSync(resolve(outputRoot, "u13-more-menu-investigation.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
await browser.close();
