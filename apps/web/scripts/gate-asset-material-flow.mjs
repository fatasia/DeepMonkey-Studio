import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { prepareAssetMaterialFixture } from "./assetMaterialFlowFixture.mjs";
import { createProductServer } from "./onlineFlowProductServer.mjs";
import { auditPage, captureProcessOutput, readJsonResponse, reservePort, waitForHealth } from "./onlineFlowAuditSupport.mjs";

const { chromium } = playwright;
const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(webRoot, "../..");
const outputRoot = resolve(repositoryRoot, "test-output/asset-material-flow");
const dataRoot = resolve(outputRoot, "data");
const apiEntry = resolve(repositoryRoot, "apps/api/dist/index.js");
const webDistRoot = resolve(webRoot, "dist");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!existsSync(apiEntry) || !existsSync(webDistRoot)) throw new Error("缺少生产产物，请先执行 pnpm build");
if (!existsSync(chromePath)) throw new Error(`Chrome 不存在：${chromePath}`);
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });
const fixture = prepareAssetMaterialFixture(repositoryRoot, dataRoot);

const apiPort = await reservePort();
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const server = createProductServer(webDistRoot, apiOrigin);
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const address = server.address();
if (!address || typeof address === "string") throw new Error("无法创建资源验收服务器");
const productOrigin = `http://127.0.0.1:${address.port}`;
const apiLogs = [];
const api = spawn(process.execPath, [apiEntry], {
  cwd: repositoryRoot,
  windowsHide: true,
  env: {
    ...process.env,
    NODE_ENV: "production",
    API_HOST: "127.0.0.1",
    API_PORT: String(apiPort),
    WEB_ORIGIN: productOrigin,
    DATA_DIR: dataRoot,
    ASSET_LIBRARY_DIR: fixture.assetLibraryDir,
    METADATA_STORE: "json",
    OBJECT_STORE: "local",
    BIM_STUDIO_E2E_EPHEMERAL: "true",
    BIM_STUDIO_ADMIN_PASSWORD: "asset-flow-admin",
    BIM_STUDIO_SESSION_SECRET: "asset-material-flow-session-secret-2026",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
captureProcessOutput(api.stdout, apiLogs);
captureProcessOutput(api.stderr, apiLogs);

let browser;
let page;
let verificationClient;
const report = {
  createdAt: new Date().toISOString(),
  productOrigin,
  evidenceBoundary: "功能闭环与持久化证据，不作为渲染观感或全资源视觉质量证明",
  modelFixture: fixture.modelFixture,
  steps: [],
  audits: [],
  expectedConsoleErrors: [],
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
};
let injectingHashMismatch = false;
try {
  await waitForHealth(`${apiOrigin}/health`, api);
  // 仅给临时 API 创建独立验证会话，不从浏览器读取或转移登录材料。
  const loginResponse = await fetch(`${apiOrigin}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "asset-flow-admin" }),
  });
  if (!loginResponse.ok) throw new Error(`临时 API 验证登录失败：HTTP ${loginResponse.status}`);
  const login = await loginResponse.json();
  verificationClient = await playwright.request.newContext({ baseURL: apiOrigin, extraHTTPHeaders: { authorization: `Bearer ${login.token}` } });
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (injectingHashMismatch && message.text().includes("500")) report.expectedConsoleErrors.push(message.text());
    else report.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("requestfailed", (request) => report.requestFailures.push(`${request.method()} ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`));

  await loginAndCreateProject(page, productOrigin, report);
  const projectId = report.projectId;
  await openAssetCenter(page, projectId);
  await verifyCatalogAndImport(page, projectId, fixture.expected, report, outputRoot);
  const editor = await createSceneAndOpenEditor(page, productOrigin, projectId);
  await loadModel(page, projectId, fixture.modelFixture, report);
  await applyAppearanceResources(page, editor, report, outputRoot);
  await verifyReloadedAppearance(page, editor, report, outputRoot);
  await inspectManagerLayouts(page, productOrigin, projectId, report, outputRoot);
  await inspectResponsiveAssetPage(page, productOrigin, projectId, report, outputRoot);

  const failures = [
    ...report.consoleErrors.map((value) => `console error: ${value}`),
    ...report.pageErrors.map((value) => `page error: ${value}`),
    ...report.requestFailures.map((value) => `request failed: ${value}`),
    ...report.audits.filter((audit) => audit.documentOverflow).map((audit) => `${audit.id} 页面溢出`),
    // 统一执行文字、点击目标、图标语义、竖排压缩与顶栏布局硬门槛。
    ...report.audits.flatMap((audit) => audit.qualityFailures),
  ];
  report.failures = failures;
  writeFileSync(resolve(outputRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (failures.length) throw new Error(`资源与材质浏览器门禁失败：\n- ${failures.join("\n- ")}`);
  console.log(`[asset-material-flow] 通过：目录筛选/治理 → 导入 → 3D 应用 → 保存刷新恢复；报告 ${resolve(outputRoot, "report.json")}`);
} catch (reason) {
  if (page && !page.isClosed()) {
    report.failureUrl = page.url();
    report.failureVisibleText = (await page.locator("body").innerText().catch(() => "")).slice(0, 4_000);
    await page.screenshot({ path: resolve(outputRoot, "failure.png"), fullPage: true }).catch(() => undefined);
  }
  report.apiLogs = apiLogs.slice(-80);
  report.failure = reason instanceof Error ? reason.message : String(reason);
  writeFileSync(resolve(outputRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  throw reason;
} finally {
  await browser?.close();
  await verificationClient?.dispose();
  api.kill();
  await new Promise((closed, reject) => server.close((error) => error ? reject(error) : closed()));
}

async function loginAndCreateProject(page, origin, report) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("asset-flow-admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.locator(".scene-manager-page").waitFor({ state: "visible" });
  await page.locator('summary[aria-label="项目管理"]').click();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("资源材质闭环项目");
  const response = page.waitForResponse((item) => item.url().endsWith("/api/projects") && item.request().method() === "POST");
  await page.getByRole("button", { name: "创建并切换" }).click();
  const project = await readJsonResponse(response, 201);
  report.projectId = project.id;
  await page.getByLabel("当前项目").selectOption(project.id);
}

async function openAssetCenter(page, projectId) {
  // 开发流程默认收起，验收脚本显式展开后再进入资源中心，复现真实用户路径。
  const deliveryFlow = page.locator(".project-delivery-flow");
  await deliveryFlow.getByRole("button", { name: "展开开发流程" }).click();
  await deliveryFlow.locator('button[data-step-id="assets"]').click();
  await page.locator(".asset-library-page").waitFor({ state: "visible" });
  await page.getByLabel("当前项目").selectOption(projectId);
}

async function verifyCatalogAndImport(page, projectId, expected, report, outputRoot) {
  const catalog = page.locator(".unified-assets-browser");
  await catalog.getByRole("tab", { name: "环境 HDRI" }).click();
  const environmentCard = catalog.locator(".unified-asset-card").filter({ hasText: "Industrial Sunset" });
  await environmentCard.waitFor({ state: "visible" });
  await environmentCard.locator("img").evaluate((image) => { if (!image.complete || image.naturalWidth < 1) throw new Error("HDRI 缩略图不可用"); });
  await environmentCard.getByRole("button", { name: "导入", exact: true }).click();
  await environmentCard.getByRole("button", { name: "已在项目", exact: true }).waitFor({ state: "visible" });

  await catalog.getByRole("tab", { name: "PBR 材质" }).click();
  const materialCard = catalog.locator(".unified-asset-card").filter({ hasText: "Concrete Floor Worn" });
  await materialCard.waitFor({ state: "visible" });
  await materialCard.getByRole("button", { name: "导入", exact: true }).click();
  await materialCard.getByRole("button", { name: "已在项目", exact: true }).waitFor({ state: "visible" });
  const deprecatedCard = catalog.locator(".unified-asset-card").filter({ hasText: "已废弃表面" });
  if (!(await deprecatedCard.getByRole("button", { name: "已废弃", exact: true }).isDisabled())) throw new Error("废弃资源仍可导入");
  const mismatchCard = catalog.locator(".unified-asset-card").filter({ hasText: "完整性异常表面" });
  injectingHashMismatch = true;
  try {
    await mismatchCard.getByRole("button", { name: "导入", exact: true }).click();
    await catalog.getByText("导入未完成").waitFor({ state: "visible" });
    await catalog.getByText("资源文件完整性校验失败").waitFor({ state: "visible" });
    if (await catalog.locator(".unified-asset-card").count() < 3) throw new Error("导入失败后资源目录上下文丢失");
  } finally {
    injectingHashMismatch = false;
  }
  await assertPrimaryCardInViewport(page, report, "asset-center-1440");
  await page.screenshot({ path: resolve(outputRoot, "01-asset-center-governance.png") });

  const project = await verifyGet(`/api/projects/${encodeURIComponent(projectId)}`);
  const ids = new Set((project.assets ?? []).map((asset) => asset.libraryOrigin?.itemId));
  if (!ids.has(expected.environment) || !ids.has(expected.material) || ids.has(expected.hashMismatch) || ids.has(expected.deprecated)) throw new Error("资源来源治理记录异常");
  const missing = await verifyGet(`/api/asset-library?q=${encodeURIComponent(expected.missingThumbnail)}&dimension=material&featured=false`);
  if (missing.total !== 0) throw new Error("缺少缩略图的资源未被目录阻断");
  report.steps.push({ id: "catalog-import-governance", imported: [...ids], missingThumbnailExcluded: true });
  report.audits.push({ id: "asset-center-governance-1440", ...await auditPage(page, "asset-center-governance-1440") });
}

async function createSceneAndOpenEditor(page, origin, projectId) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByLabel("当前项目").selectOption(projectId);
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("材质验收场景");
  const response = page.waitForResponse((item) => item.url().includes(`/api/projects/${projectId}/applications`) && item.request().method() === "POST");
  await page.getByRole("button", { name: "创建并进入" }).click();
  const application = await readJsonResponse(response, 201);
  const scene = application.scenes.find((item) => item.name === "材质验收场景") ?? application.scenes[0];
  const url = `${origin}/studio/${projectId}/applications/${application.metadata.id}/scenes/${scene.id}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator(".viewport canvas").waitFor({ state: "visible", timeout: 30_000 });
  const autoSave = page.getByLabel("自动保存");
  if (await autoSave.isChecked()) await autoSave.uncheck();
  return { url, projectId, applicationId: application.metadata.id, sceneId: scene.id };
}

async function loadModel(page, projectId, modelFixture, report) {
  const response = page.waitForResponse((item) => item.url().includes(`/api/projects/${projectId}/models?`) && item.request().method() === "POST");
  await page.locator('input[type="file"][accept*=".glb"]').setInputFiles(modelFixture.path);
  const model = await readJsonResponse(response, 202);
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    const project = await verifyGet(`/api/projects/${encodeURIComponent(projectId)}`);
    const current = project.models.find(item => item.id === model.id);
    if (current?.status === "failed") throw new Error(`模型处理失败：${current.message}`);
    ready = current?.status === "ready";
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("模型处理未在 30 秒内完成");
  await page.reload({ waitUntil: "networkidle" });
  if (await page.locator(".asset-row").count() === 0) {
    const organizationToggle = page.getByRole("button", { name: "场景图层与编组" });
    if (await organizationToggle.count()) await organizationToggle.click();
  }
  const row = page.locator(".asset-row").filter({ hasText: modelFixture.fileName });
  await row.locator(".asset-main").click();
  await row.locator(".mini-button").first().waitFor({ state: "visible", timeout: 30_000 });
  report.modelId = model.id;
  report.modelFileName = modelFixture.fileName;
}

async function applyAppearanceResources(page, editor, report, outputRoot) {
  const modelRow = page.locator(".asset-row").filter({ hasText: report.modelFileName });
  await modelRow.locator(".asset-main").click();
  const appearance = page.locator(".inspector-appearance-settings");
  await appearance.locator(":scope > summary").click();
  const materialPicker = appearance.locator(".project-appearance-picker");
  await materialPicker.locator("summary").click();
  const materialButton = materialPicker.locator("button").filter({ hasText: "Concrete Floor Worn" });
  await materialButton.click();
  if (!(await materialButton.evaluate((button) => button.classList.contains("active")))) throw new Error("PBR 材质未应用到选中模型");

  await page.getByRole("button", { name: "查看与分析", exact: true }).click();
  await page.getByRole("menuitem", { name: "环境与灯光", exact: true }).click();
  const environmentPanel = page.locator(".environment-control");
  await environmentPanel.waitFor({ state: "visible" });
  const environmentPicker = environmentPanel.locator(".environment-resource-picker");
  await environmentPicker.locator("summary").click();
  const environmentButton = environmentPicker.locator("button").filter({ hasText: "Industrial Sunset" });
  await environmentButton.click();
  if (!(await environmentButton.evaluate((button) => button.classList.contains("active")))) throw new Error("HDRI 未应用到场景");
  const backgroundToggle = environmentPanel.getByLabel("作为背景");
  if (!(await backgroundToggle.isChecked())) await backgroundToggle.check();
  await page.screenshot({ path: resolve(outputRoot, "02-applied-in-3d.png"), fullPage: true });
  const response = page.waitForResponse((item) => item.url().endsWith("/workspace") && item.request().method() === "PUT");
  await page.getByRole("button", { name: "保存项目" }).click();
  const workspace = await readJsonResponse(response, 200);
  const target = workspace.scene.models.find((item) => item.modelId === report.modelId);
  if (!workspace.scene.environment?.environmentMapUrl || !workspace.scene.environment.environmentAsBackground || !target?.material?.baseColorMapUrl) {
    throw new Error("外观资源未完整写入场景快照");
  }
  report.steps.push({ id: "apply-and-save", environmentMapUrl: workspace.scene.environment.environmentMapUrl, baseColorMapUrl: target.material.baseColorMapUrl });
  report.audits.push({ id: "appearance-editor-1440", ...await auditPage(page, "appearance-editor-1440") });
  report.editor = editor;
}

async function verifyReloadedAppearance(page, editor, report, outputRoot) {
  await page.reload({ waitUntil: "networkidle" });
  if (await page.locator(".asset-row").count() === 0) {
    const organizationToggle = page.getByRole("button", { name: "场景图层与编组" });
    if (await organizationToggle.count()) await organizationToggle.click();
  }
  const modelRow = page.locator(".asset-row").filter({ hasText: report.modelFileName });
  await modelRow.locator(".mini-button").first().waitFor({ state: "visible", timeout: 30_000 });
  await modelRow.locator(".asset-main").click();
  const appearance = page.locator(".inspector-appearance-settings");
  await appearance.locator(":scope > summary").click();
  await appearance.locator(".project-appearance-picker summary").click();
  await appearance.locator(".project-appearance-picker button.active").filter({ hasText: "Concrete Floor Worn" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "查看与分析", exact: true }).click();
  await page.getByRole("menuitem", { name: "环境与灯光", exact: true }).click();
  const environment = page.locator(".environment-resource-picker");
  await environment.locator("summary").click();
  await environment.locator("button.active").filter({ hasText: "Industrial Sunset" }).waitFor({ state: "visible" });
  if (!(await page.locator(".environment-control").getByLabel("作为背景").isChecked())) throw new Error("HDRI 背景设置刷新后未恢复");
  await page.screenshot({ path: resolve(outputRoot, "03-reloaded-appearance.png"), fullPage: true });
  report.steps.push({ id: "reload-restores-appearance", url: editor.url });
}

async function inspectResponsiveAssetPage(page, origin, projectId, report, outputRoot) {
  const viewports = [
    { id: "asset-center-1920", width: 1920, height: 1080 },
    { id: "asset-center-1440", width: 1440, height: 900 },
    { id: "asset-center-1366", width: 1366, height: 768 },
    { id: "asset-center-1280", width: 1280, height: 800 },
    { id: "asset-center-1024", width: 1024, height: 768 },
  ];
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.getByLabel("当前项目").selectOption(projectId);
    await openAssetCenter(page, projectId);
    await page.locator(".unified-assets-grid:not(.is-refreshing)").waitFor({ state: "visible" });
    if (viewport.width === 1024) await assertPrimaryCardInViewport(page, report, viewport.id);
    report.audits.push({ id: viewport.id, ...await auditPage(page, viewport.id) });
    await page.screenshot({ path: resolve(outputRoot, `${viewport.id}.png`) });
  }

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByLabel("当前项目").selectOption(projectId);
  await openAssetCenter(page, projectId);
  const filtered = page.waitForResponse((item) => item.url().includes("/api/asset-library?") && item.url().includes("dimension=material"));
  await page.getByRole("tab", { name: "PBR 材质" }).click();
  await filtered;
  await page.locator(".unified-assets-grid:not(.is-refreshing)").waitFor({ state: "visible" });
  await assertPrimaryCardInViewport(page, report, "asset-center-material-1024");
  report.audits.push({ id: "asset-center-material-1024", ...await auditPage(page, "asset-center-material-1024") });
  await page.screenshot({ path: resolve(outputRoot, "asset-center-material-1024.png") });

  await page.locator(".unified-assets-kinds button").filter({ hasText: "看板模板" }).click();
  await page.locator(".built-in-asset-card").first().waitFor({ state: "visible" });
  await assertWorkspacePrimaryActionInViewport(page, report, "template-center-1024");
  report.audits.push({ id: "template-center-1024", ...await auditPage(page, "template-center-1024") });
  await page.screenshot({ path: resolve(outputRoot, "06-template-center-1024.png") });
}

async function inspectManagerLayouts(page, origin, projectId, report, outputRoot) {
  const viewports = [
    { id: "manager-1920", width: 1920, height: 1080 },
    { id: "manager-1440", width: 1440, height: 900 },
    { id: "manager-1366", width: 1366, height: 768 },
    { id: "manager-1280", width: 1280, height: 800 },
    { id: "manager-1024", width: 1024, height: 768 },
  ];
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.getByLabel("当前项目").selectOption(projectId);
    await page.getByRole("button", { name: "项目场景", exact: true }).click();
    await page.locator(".scene-card").first().waitFor({ state: "visible" });
    const metrics = await page.evaluate(() => {
      const header = document.querySelector(".manager-header");
      const card = document.querySelector(".scene-card");
      const actions = card?.querySelector(".scene-card-actions");
      const deliveryFlow = document.querySelector(".project-delivery-flow");
      const cardRect = card?.getBoundingClientRect();
      const actionRect = actions?.getBoundingClientRect();
      const text = document.body.innerText;
      return {
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        headerOverflow: Boolean(header && header.scrollWidth > header.clientWidth + 1),
        cardActionOverflow: Boolean(cardRect && actionRect && (actionRect.left < cardRect.left || actionRect.right > cardRect.right)),
        flowCollapsedClean: deliveryFlow?.textContent?.trim() === "开发流程"
          && deliveryFlow.querySelector('[aria-label="展开开发流程"]') !== null
          && deliveryFlow.querySelector(".delivery-progress,[data-step-id]") === null,
        oldResourceTerms: Array.from(text.matchAll(/资源库|资源中心|素材/g), (match) => match[0]),
      };
    });
    report.steps.push({ id: `${viewport.id}-layout`, ...metrics });
    report.audits.push({ id: viewport.id, ...await auditPage(page, viewport.id) });
    await page.screenshot({ path: resolve(outputRoot, `${viewport.id}.png`) });
    if (metrics.documentOverflow || metrics.headerOverflow || metrics.cardActionOverflow) throw new Error(`${viewport.id} 存在横向溢出或卡片动作越界`);
    if (!metrics.flowCollapsedClean) throw new Error(`${viewport.id} 默认开发流程仍显示状态、进度或步骤`);
    if (metrics.oldResourceTerms.length) throw new Error(`${viewport.id} 出现过时资源术语：${metrics.oldResourceTerms.join("、")}`);
  }
}

async function assertPrimaryCardInViewport(page, report, id) {
  const layouts = await page.locator(".unified-asset-card").evaluateAll((elements) => elements.flatMap((element) => {
    const action = element.querySelector(".asset-import, .asset-imported, .asset-placement-hint");
    if (!action) return [];
    const cardRect = element.getBoundingClientRect();
    const actionRect = action.getBoundingClientRect();
    if (cardRect.width <= 0 || cardRect.height <= 0 || actionRect.width <= 0 || actionRect.height <= 0) return [];
    return [{ cardTop: cardRect.top, cardBottom: cardRect.bottom, actionTop: actionRect.top, actionBottom: actionRect.bottom }];
  }));
  const layout = layouts[0];
  const viewport = page.viewportSize();
  if (!layout || !viewport) throw new Error(`${id} 无法读取首张资源卡片布局`);
  const hasLayout = layout.cardBottom > layout.cardTop && layout.actionBottom > layout.actionTop;
  const primaryActionVisible = hasLayout && layout.actionTop >= 0 && layout.actionBottom <= viewport.height;
  report.steps.push({ id: `${id}-first-viewport`, cardBottom: Math.round(layout.cardBottom), actionBottom: Math.round(layout.actionBottom), viewportHeight: viewport.height, primaryActionVisible });
  if (!primaryActionVisible) throw new Error(`${id} 首张资源卡片或使用提示未完整进入首屏`);
}

async function assertWorkspacePrimaryActionInViewport(page, report, id) {
  const layout = await page.locator(".built-in-editor-entry").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { actionTop: bounds.top, actionBottom: bounds.bottom };
  });
  const viewport = page.viewportSize();
  if (!viewport) throw new Error(`${id} 无法读取视口布局`);
  const primaryActionVisible = layout.actionTop >= 0 && layout.actionBottom <= viewport.height;
  report.steps.push({ id: `${id}-first-viewport`, actionBottom: Math.round(layout.actionBottom), viewportHeight: viewport.height, primaryActionVisible });
  if (!primaryActionVisible) throw new Error(`${id} 编辑器入口未完整进入首屏`);
}

async function verifyGet(path) {
  if (!path.startsWith("/api/")) throw new Error("验证读取必须限定在临时 API");
  const response = await verificationClient.get(path);
  if (!response.ok()) throw new Error(`验证读取失败：HTTP ${response.status()} ${path}`);
  return response.json();
}
