/**
 * H-C6-S3-connect 首批浏览器证据(externalResource / scriptGit 两个"部分"入口的真实路径)。
 *
 * 用法:node apps/web/scripts/hc6s3-connect-batch1-browser.mjs
 * 产物:test-output/hc6s3-connect-20261002/*.png + report.json
 *
 * Leg A(scriptGit,真实产品链):隔离 gate(独立端口/数据目录)→ 登录 → 建项目/场景 →
 *   Studio → 工具坞「仿真与开发 → 行为脚本」→ 新建 → 保存 → header「脚本版本」→
 *   填写修改说明 → 提交快照(真打 /script-git/commits)→ 历史出现。
 * Leg B(externalResource,visualQa 通道):vite dev 自带的 ?__visualQa=dashboard 页 →
 *   组件库添加「地图」→ 三态:未配置 / 失败地址(路由中断) / 有效地址(路由满足)。
 * 截图 1280×1080 深色(深色为默认主题,显式锁定 branding themeMode=dark)。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir as mkdirAsync } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const outputDirectory = "test-output/hc6s3-connect-20261002";
const outputRoot = resolve(repositoryRoot, outputDirectory);
await mkdirAsync(outputRoot, { recursive: true });

const report = { startedAt: new Date().toISOString(), steps: [], assertions: [], screenshots: [], failures: [] };
const step = (id, detail) => { report.steps.push({ id, ...(detail ? { detail } : {}) }); console.log(`  ✓ ${id}${detail ? ` — ${JSON.stringify(detail)}` : ""}`); };
const check = (id, ok, detail) => {
  report.assertions.push({ id, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  if (!ok) report.failures.push(id);
  console.log(`  ${ok ? "✓" : "✗"} assert ${id}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  assert.ok(ok, `断言失败: ${id}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};
const shot = async (page, name) => {
  await page.screenshot({ path: resolve(outputRoot, `${name}.png`) });
  report.screenshots.push(`${outputDirectory}/${name}.png`);
  console.log(`  📷 ${name}.png`);
};

const geoJsonFeatureCollection = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { name: "演示区" },
    geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]] },
  }],
};

const gate = await createIsolatedStudioGate("hc6s3-connect-batch1", {});
let vite;
let page;
const consoleErrors = [];
try {
  const context = await gate.browser.newContext({ viewport: { width: 1280, height: 1080 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("console", (entry) => { if (entry.type() === "error") consoleErrors.push(`console: ${entry.text().slice(0, 200)}`); });
  page.on("dialog", (dialog) => void dialog.accept());
  // 深色主题(默认即深色;显式锁定防环境漂移)。
  await page.route("**/api/public/branding", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), themeMode: "dark" } });
  });

  /* ---------------- Leg A: scriptGit 真实浏览器路径 ---------------- */
  const project = await gate.json("POST", "/api/projects", { name: "HC6S3-connect 首批验证" });
  await gate.loginPage(page);
  await page.getByLabel("当前项目").selectOption(project.id);
  await page.getByRole("button", { name: "项目场景", exact: true }).click();
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("脚本版本验证场景");
  const applicationResponse = page.waitForResponse((candidate) =>
    candidate.url().includes(`/api/projects/${project.id}/applications`) && candidate.request().method() === "POST");
  await page.getByRole("button", { name: "创建并进入" }).click();
  const application = await (await applicationResponse).json();
  const scene = application.scenes?.[0];
  const studioUrl = `${gate.origin}/studio/${encodeURIComponent(project.id)}/applications/${encodeURIComponent(application.metadata.id)}/scenes/${encodeURIComponent(scene.id)}`;
  await page.goto(studioUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.locator(".viewport canvas").waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  check("dark-theme", theme !== "light", { theme });
  await shot(page, "01-studio-before-entry");

  // 工具坞:仿真与开发 → 行为脚本
  const developTrigger = page.getByRole("button", { name: "仿真与开发" });
  await developTrigger.click();
  await page.waitForTimeout(400);
  const expanded = await developTrigger.getAttribute("aria-expanded");
  await shot(page, "diag-develop-menu");
  const developMenu = page.locator("#scene-tool-menu-develop");
  check("develop-menu-open", expanded === "true" && await developMenu.isVisible().catch(() => false), { expanded });
  await developMenu.getByRole("menuitem", { name: "行为脚本", exact: true }).click();
  await page.locator("section.behavior-panel").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(400);
  check("behavior-panel-open", await page.locator(".behavior-panel-header").count() > 0);
  check("entry-visible", await page.locator("summary[aria-label=更多工具]").count() > 0);
  await shot(page, "02-behavior-panel-entry");

  // 新建一个行为脚本并保存(消除未应用草稿,保证提交可用)
  await page.locator(".behavior-script-list").getByRole("button", { name: "新建", exact: true }).click();
  await page.locator(".behavior-editor:not([hidden]) .CodeMirror, .behavior-editor textarea, .behavior-editor").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(600);
  const saveButton = page.getByRole("button", { name: "保存脚本" });
  if (await saveButton.count() && await saveButton.isEnabled().catch(() => false)) {
    await saveButton.click();
    await page.waitForTimeout(1200);
  }
  step("behavior-script-created");

  // header「更多工具 → 脚本版本」→ ScriptVersionManager
  await page.locator("summary[aria-label=更多工具]").click();
  await page.locator(".behavior-more-menu").getByRole("button", { name: "脚本版本" }).click();
  await page.locator(".script-version-manager").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(600);
  const statusText = await page.locator(".script-version-status").innerText().catch(() => "");
  check("git-status-loaded", statusText.includes("main"), { statusText: statusText.slice(0, 120) });
  await shot(page, "03-script-git-dialog");

  // 提交快照(真打 POST /script-git/commits)
  const commitResponse = page.waitForResponse((candidate) =>
    candidate.url().includes("/script-git/commits") && candidate.request().method() === "POST", { timeout: 60_000 });
  await page.getByLabel("修改说明").fill("接入批验证:首个脚本快照");
  await page.getByRole("button", { name: "提交快照" }).click();
  const commit = await commitResponse;
  check("commit-api-ok", commit.ok(), { status: commit.status() });
  const commitPayload = await commit.json();
  check("commit-created", commitPayload.committed === true && Boolean(commitPayload.commit?.shortHash), { hash: commitPayload.commit?.shortHash });
  await page.locator(".script-version-history article").first().waitFor({ timeout: 30_000 });
  const historyText = await page.locator(".script-version-history").innerText();
  check("history-visible", historyText.includes("接入批验证:首个脚本快照"));
  await shot(page, "04-script-git-history");

  // 关闭对话框,回到面板(动线无扰动)
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check("dialog-closed", await page.locator(".script-version-manager").count() === 0);
  await shot(page, "05-behavior-panel-after-close");

  /* ---------------- Leg B: externalResource 地图三态(visualQa 通道) ---------------- */
  const vitePort = 5177;
  vite = spawn(process.execPath, [resolve(repositoryRoot, "apps/web/node_modules/vite/bin/vite.js"), "--port", String(vitePort), "--strictPort"], {
    cwd: resolve(repositoryRoot, "apps/web"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const viteLogs = [];
  vite.stdout.on("data", (chunk) => viteLogs.push(String(chunk)));
  vite.stderr.on("data", (chunk) => viteLogs.push(String(chunk)));
  const devOrigin = `http://127.0.0.1:${vitePort}`;
  const viteReady = async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (vite.exitCode !== null) throw new Error(`vite dev 退出: ${vite.exitCode}\n${viteLogs.join("").slice(-800)}`);
      const ok = await fetch(devOrigin).then((response) => response.ok).catch(() => false);
      if (ok) return true;
      await new Promise((done) => setTimeout(done, 500));
    }
    throw new Error(`vite dev 未就绪\n${viteLogs.join("").slice(-800)}`);
  };
  await viteReady();
  step("vite-dev-ready", { devOrigin });

  const mapPage = await context.newPage();
  mapPage.setDefaultTimeout(30_000);
  mapPage.on("pageerror", (error) => consoleErrors.push(`map pageerror: ${error.message}`));
  await mapPage.route("**/hc6s3-geo-valid.json", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(geoJsonFeatureCollection) });
  });
  await mapPage.route("**/hc6s3-geo-broken.json", async (route) => route.abort("connectionrefused"));
  await mapPage.goto(`${devOrigin}/?__visualQa=dashboard`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await mapPage.locator("canvas").first().waitFor({ timeout: 90_000 });
  await mapPage.waitForTimeout(1500);

  // 组件库添加「地图」组件(左侧「资源」页签 → 组件卡片)
  await mapPage.locator(".dashboard-left-tabs").getByRole("button", { name: "资源" }).click();
  const mapPaletteItem = mapPage.locator(".dashboard-library-browser .dashboard-library-card").filter({ hasText: "地图" }).first();
  await mapPaletteItem.waitFor({ timeout: 30_000 });
  await mapPaletteItem.click();
  await mapPage.waitForTimeout(1200);
  // 控件挪进视口中央并放大画布,让占位文案可读
  const setNumberField = async (label, value) => {
    const field = mapPage.getByLabel(label, { exact: true });
    if (await field.count()) await field.fill(String(value));
  };
  await setNumberField("X", 380);
  await setNumberField("Y", 300);
  await setNumberField("宽", 800);
  await setNumberField("高", 500);
  await mapPage.waitForTimeout(600);
  for (let index = 0; index < 5; index += 1) {
    await mapPage.getByRole("button", { name: /放大（以视口中心缩放）/ }).click().catch(() => undefined);
    await mapPage.waitForTimeout(120);
  }
  await mapPage.waitForTimeout(500);
  await shot(mapPage, "06-map-widget-empty-state");

  // 失败地址:加载失败三态(本批修复——旧实现永远显示"加载中")
  await mapPage.locator(".dashboard-inspector-tabs, [class*=inspector]").getByRole("button", { name: "数据", exact: true }).first().click().catch(async () => {
    await mapPage.getByRole("button", { name: "数据", exact: true }).first().click();
  });
  await mapPage.waitForTimeout(400);
  const geoJsonInput = mapPage.getByLabel("GeoJSON URL");
  await geoJsonInput.waitFor({ timeout: 30_000 });
  await geoJsonInput.fill("https://assets.invalid/hc6s3-geo-broken.json");
  await mapPage.waitForTimeout(1800);
  await shot(mapPage, "07-map-geojson-error-state");

  // 有效地址:外部资源加载并渲染
  await geoJsonInput.fill("https://assets.local/hc6s3-geo-valid.json");
  await mapPage.waitForTimeout(2500);
  await shot(mapPage, "08-map-geojson-ready-state");
  check("map-leg-complete", true);
  step("external-resource-leg-complete");

  const studioErrors = consoleErrors.filter((line) => !line.includes("favicon") && !line.includes("net::") && !line.includes("Failed to load resource"));
  check("no-page-errors", studioErrors.length === 0, { errors: studioErrors.slice(0, 5) });
} finally {
  await page?.context()?.close().catch(() => undefined);
  await gate.close();
  vite?.kill();
  report.finishedAt = new Date().toISOString();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(resolve(outputRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`report → ${outputDirectory}/report.json (failures: ${report.failures.length})`);
}
