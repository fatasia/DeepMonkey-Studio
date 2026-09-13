// 二维资源库商用化升级·视觉闭环截图(编辑器资源面板 + 管理端资源页 2D tab,双主题)。
import fs from "node:fs";
import path from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const outDir = path.resolve("test-output/ui-upgrade-2d");
fs.mkdirSync(outDir, { recursive: true });

const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });

async function shootEditorLibrary(theme) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.5 });
  await page.goto(`${origin}/?__visualQa=dashboard&theme=${theme}`, { waitUntil: "load" });
  await page.waitForTimeout(2600);
  // 打开左侧组件资源面板(若默认未展开)。
  const library = page.locator(".dashboard-library-browser").first();
  if (!(await library.isVisible().catch(() => false))) {
    for (const label of ["资源", "组件", "Assets"]) {
      const btn = page.locator(`button:has-text("${label}")`).first();
      if (await btn.isVisible().catch(() => false)) { await btn.click(); await page.waitForTimeout(700); break; }
    }
  }
  if (await library.isVisible().catch(() => false)) {
    await page.locator(".dashboard-library-results").first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(400);
    await library.screenshot({ path: path.join(outDir, `editor-library-${theme}.png`) });
  } else {
    console.log(`[${theme}] editor library panel not visible`);
  }
  await page.screenshot({ path: path.join(outDir, `editor-full-${theme}.png`) });
  await page.close();
}

async function shootManagerAssets(theme) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.5 });
  await page.goto(`${origin}/?theme=${theme}`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  // 登录(admin/admin)。
  const userInput = page.getByLabel(/用户名|Username/).first();
  await userInput.waitFor({ timeout: 20000 });
  await userInput.fill("admin");
  await page.getByLabel(/密码|Password/).first().fill("admin");
  await page.getByRole("button", { name: /登录|Sign in|Login/i }).first().click();
  await page.waitForTimeout(2500);
  // 进入资源 tab。
  const assetsTab = page.locator(`button[aria-label="资源"], button[aria-label="Assets"]`).first();
  if (await assetsTab.isVisible().catch(() => false)) {
    if (await assetsTab.isEnabled()) { await assetsTab.click(); await page.waitForTimeout(1800); }
    else console.log(`[${theme}] assets tab disabled (no project?)`);
  } else {
    console.log(`[${theme}] assets tab not found`);
  }
  // 切到二维资源(内置 2D)tab。
  const kind2d = page.locator(`button:has-text("二维资源")`).first();
  if (await kind2d.isVisible().catch(() => false)) { await kind2d.click(); await page.waitForTimeout(1200); }
  const grid = page.locator(".built-in-assets-grid").first();
  if (await grid.isVisible().catch(() => false)) {
    await grid.screenshot({ path: path.join(outDir, `manager-2d-${theme}.png`) });
  } else {
    console.log(`[${theme}] manager 2d grid not visible`);
  }
  await page.screenshot({ path: path.join(outDir, `manager-full-${theme}.png`) });
  await page.close();
}

await shootEditorLibrary("dark");
await shootEditorLibrary("light");
await shootManagerAssets("dark");
await shootManagerAssets("light");
await browser.close();
console.log("done:", fs.readdirSync(outDir).join(", "));
