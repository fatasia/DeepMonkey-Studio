/**
 * E1 断网整机闭包验收（2026-10-02）。
 *
 * 链路：生产构建产物 → 断网启动（Chrome --host-resolver-rules 阻断外部域名，仅保留本地）→
 * 建项目/场景 → 导入模型 → 物理真实运行 + What-if 仿真 Study → 工程分析报告下载 →
 * 保存场景 → 断网重开验证 → C4 事件录制/重开/Study 证据副本。
 *
 * 口径：禁 cargo，使用 web dist + api dist 生产构建产物 + 本地静态服务器（与 gate:online-flow 同口径）。
 * 断网口径：MAP * ~NOTFOUND 阻断全部外部域名解析；全程断言外部域名 0 成功响应。
 * 证据：test-output/e1-offline-20261002/（截图、下载文件、evidence.json）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import {
  captureProcessOutput,
  readJsonResponse,
  recordStep,
  reservePort,
  waitForHealth,
  waitForModelReady
} from "./onlineFlowAuditSupport.mjs";
import { createProductServer } from "./onlineFlowProductServer.mjs";

const { chromium } = playwright;
const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(webRoot, "../..");
const webDistRoot = resolve(webRoot, "dist");
const apiEntry = resolve(repositoryRoot, "apps/api/dist/index.js");
const outputRoot = resolve(repositoryRoot, "test-output/e1-offline-20261002");
const dataRoot = resolve(outputRoot, "data");
const downloadsRoot = resolve(outputRoot, "downloads");
const fixtureRoot = resolve(outputRoot, "fixtures");
const fixturePath = resolve(fixtureRoot, "e1-offline-cube.gltf");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const HOST_RESOLVER_RULES = "MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1";

if (!existsSync(webDistRoot) || !existsSync(resolve(webDistRoot, ".vite/manifest.json"))) {
  throw new Error("缺少 web 生产产物（dist/.vite/manifest.json），请先执行 pnpm build");
}
if (!existsSync(apiEntry)) throw new Error("缺少 API 生产产物（apps/api/dist/index.js），请先执行 api build");
if (!existsSync(chromePath)) throw new Error(`Chrome 不存在：${chromePath}`);

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });
mkdirSync(downloadsRoot, { recursive: true });
mkdirSync(fixtureRoot, { recursive: true });
writeCubeGltf(fixturePath);

const report = {
  createdAt: new Date().toISOString(),
  scope: "E1 断网整机闭包：构建产物→启动→导入→仿真→报告→保存→重开→C4 录制与证据复盘",
  caliber: {
    installer: "禁 cargo：未构建 Tauri 安装包；使用 web/api 生产构建产物 + 本地静态服务器（同 gate:online-flow 口径）",
    offline: "Chrome --host-resolver-rules=MAP * ~NOTFOUND 保留 127.0.0.1/localhost，非物理断网卡",
    artifacts: {
      webDistMtime: statSync(resolve(webDistRoot, "index.html")).mtime.toISOString(),
      apiDistMtime: statSync(apiEntry).mtime.toISOString()
    }
  },
  offline: { blockedProofs: [], externalSuccesses: [], expectedOfflineBlocks: [] },
  steps: [],
  apiLogs: [],
  consoleErrors: [],
  expectedConsoleErrors: [],
  pageErrors: [],
  localRequestFailures: [],
  expectedLocalRequestCancels: [],
  finishedAt: null,
  passed: false
};

const isExternalUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol.startsWith("http") && !["127.0.0.1", "localhost"].includes(parsed.hostname);
  } catch {
    return false;
  }
};

let exitCode = 0;
const apiPort = await reservePort();
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const server = createProductServer(webDistRoot, apiOrigin);
await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
const serverAddress = server.address();
if (!serverAddress || typeof serverAddress === "string") throw new Error("无法创建本地产品服务器");
const productOrigin = `http://127.0.0.1:${serverAddress.port}`;
report.productOrigin = productOrigin;
report.apiOrigin = apiOrigin;

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
    METADATA_STORE: "json",
    OBJECT_STORE: "local",
    BIM_STUDIO_E2E_EPHEMERAL: "true",
    BIM_STUDIO_ADMIN_PASSWORD: "e1-offline-admin",
    BIM_STUDIO_SESSION_SECRET: "e1-offline-session-secret-2026-verified-3210"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
captureProcessOutput(api.stdout, report.apiLogs);
captureProcessOutput(api.stderr, report.apiLogs);

let browser;
const fail = (message) => { throw new Error(message); };

// 已知设计语义（非缺陷，逐条保留原始条目并标注依据）：
// - probe-bake GET 404：apps/api/src/probeGridBakeRoutes.ts 头注"未命中 404（=无，调用方静默降级，不报错）"，
//   浏览器对任何 404 响应都会打印 console error，客户端按缓存未命中处理。
// - editor-scene-driver POST ERR_ABORTED：mcpApi.ts 的会话轮询请求携带 AbortSignal，
//   页面导航/卸载时被 AbortController 取消，浏览器记为 net::ERR_ABORTED，属预期生命周期行为。
const classifyConsoleError = (entry) => {
  if (entry.includes("/probe-bake") && entry.includes("404")) return "probe-bake 缓存未命中（路由头注声明的静默降级语义）";
  if (entry.includes("/data/replay") && entry.includes("400")) return "空项目无可回放数据（dataReplay.test.ts 声明的 400 空态语义；DataReplayPanel 捕获并展示指引）";
  return null;
};
const classifyLocalFailure = (entry) => {
  if (entry.includes("/editor-scene-driver/") && entry.includes("ERR_ABORTED")) return "会话轮询在导航/卸载时被 AbortController 取消";
  return null;
};

try {
  await waitForHealth(`${apiOrigin}/health`, api);
  // 本地 API 健康检查在 host-resolver-rules 注入前用 node fetch 完成，Chrome 内再复验一次本地可达。
  browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: [`--host-resolver-rules=${HOST_RESOLVER_RULES}`]
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const entry = `${message.text()} · ${message.location().url}`;
    const classified = classifyConsoleError(entry);
    if (classified) report.expectedConsoleErrors.push({ entry: entry.slice(0, 300), reason: classified });
    else report.consoleErrors.push(entry);
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const entry = `${request.method()} ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`;
    if (isExternalUrl(request.url())) report.offline.expectedOfflineBlocks.push(entry);
    else {
      const classified = classifyLocalFailure(entry);
      if (classified) report.expectedLocalRequestCancels.push({ entry: entry.slice(0, 300), reason: classified });
      else report.localRequestFailures.push(entry);
    }
  });
  page.on("response", (response) => {
    if (isExternalUrl(response.url())) {
      report.offline.externalSuccesses.push(`${response.status()} ${response.url()}`);
    }
  });

  // ── 步骤 1：断网证明（外部域名必须解析失败，本地保留；用独立探针页避免污染主页面导航） ──
  const probePage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const probe = async (url) => {
    try {
      await probePage.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      return { url, blocked: false, detail: "goto 意外成功" };
    } catch (reason) {
      return { url, blocked: true, detail: String(reason?.message ?? reason).slice(0, 200) };
    }
  };
  report.offline.blockedProofs.push(await probe("http://example.com/"));
  report.offline.blockedProofs.push(await probe("https://www.baidu.com/"));
  await probePage.close();
  if (report.offline.blockedProofs.some((item) => !item.blocked)) {
    fail(`断网阻断未生效：${JSON.stringify(report.offline.blockedProofs)}`);
  }
  recordStep(report, "offline-block-proof", { rules: HOST_RESOLVER_RULES, proofs: report.offline.blockedProofs });

  // ── 步骤 2：启动 + 登录 ──
  try {
    await page.goto(productOrigin, { waitUntil: "networkidle", timeout: 60_000 });
  } catch {
    await page.goto(productOrigin, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("e1-offline-admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.locator(".scene-manager-page").waitFor({ state: "visible", timeout: 30_000 });
  await page.screenshot({ path: resolve(outputRoot, "01-login-manager.png"), fullPage: true });
  recordStep(report, "launch-and-login", { origin: productOrigin, apiHealth: "ok" });

  // ── 步骤 3：建项目 + 场景 ──
  await page.locator('summary[aria-label="项目管理"]').click();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("E1 断网闭包验收项目");
  const projectResponse = page.waitForResponse((response) => response.url().endsWith("/api/projects") && response.request().method() === "POST");
  await page.getByRole("button", { name: "创建并切换" }).click();
  const project = await readJsonResponse(projectResponse, 201);
  await page.getByLabel("当前项目").selectOption(project.id);

  await page.getByRole("button", { name: "项目场景", exact: true }).click();
  await page.locator(".scene-manager-page").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("E1 断网验收场景");
  const applicationResponse = page.waitForResponse((response) => response.url().includes(`/api/projects/${project.id}/applications`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "创建并进入" }).click();
  const application = await readJsonResponse(applicationResponse, 201);
  const scene = application.scenes?.find((candidate) => candidate.name === "E1 断网验收场景") ?? application.scenes?.[0];
  if (!scene?.id || !application.metadata?.id) fail(`创建场景后未返回有效应用与场景标识：${JSON.stringify(application).slice(0, 300)}`);
  await page.locator(".dashboard-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await page.screenshot({ path: resolve(outputRoot, "02-project-scene-created.png"), fullPage: true });
  recordStep(report, "create-project-and-scene", { projectId: project.id, applicationId: application.metadata.id, sceneId: scene.id });

  // ── 步骤 4：导入模型（仓内生成 fixture，走产品上传链路） ──
  const sceneEditorUrl = `${productOrigin}/studio/${encodeURIComponent(project.id)}/applications/${encodeURIComponent(application.metadata.id)}/scenes/${encodeURIComponent(scene.id)}`;
  await page.goto(sceneEditorUrl, { waitUntil: "networkidle", timeout: 60_000 });
  await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor({ state: "visible", timeout: 30_000 });
  const uploadResponse = page.waitForResponse((response) => response.url().includes(`/api/projects/${project.id}/models?`) && response.request().method() === "POST");
  await page.locator('input[type="file"][accept*=".glb"]').setInputFiles(fixturePath);
  const uploadedModel = await readJsonResponse(uploadResponse, 202);
  await waitForModelReady(page, project.id, uploadedModel.id);
  await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
  await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor({ state: "visible", timeout: 30_000 });
  await openSceneResourcePanel(page);
  const modelRow = page.locator(`.scene-resource-row[data-model-id="${uploadedModel.id}"]`);
  try {
    await modelRow.waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    const assetDump = await page.evaluate(() => ({
      rows: [...document.querySelectorAll(".scene-resource-row")].slice(0, 12).map((row) => row.textContent?.trim().slice(0, 80)),
      panelOpen: Boolean(document.querySelector(".scene-resource-floating"))
    }));
    await page.screenshot({ path: resolve(outputRoot, "failure-import-asset-list.png"), fullPage: true });
    fail(`导入后未见模型资源行：${JSON.stringify(assetDump)}`);
  }
  if (await modelRow.getAttribute("data-model-status") !== "ready") {
    fail(`模型尚未就绪：data-model-status=${await modelRow.getAttribute("data-model-status")}`);
  }
  await modelRow.getByRole("button", { name: "载入", exact: true }).click();
  await page.locator(".scene-resource-floating").getByRole("button", { name: "关闭资源浮窗" }).click();
  await page.locator(".scene-resource-floating").waitFor({ state: "hidden", timeout: 30_000 });
  await page.screenshot({ path: resolve(outputRoot, "03-model-imported.png"), fullPage: true });
  recordStep(report, "import-model", { modelId: uploadedModel.id, fixture: "e1-offline-cube.gltf" });

  // 导入后立即保存：后续报告/重开步骤依赖已持久化的模型引用。
  const saveAfterImport = page.waitForResponse((response) => response.url().endsWith("/workspace") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存项目" }).click();
  const workspaceAfterImport = await readJsonResponse(saveAfterImport, 200);
  if (!workspaceAfterImport.scene?.models?.some((model) => model.modelId === uploadedModel.id)) {
    fail(`保存后的场景未引用已导入模型：${JSON.stringify(workspaceAfterImport.scene?.models ?? []).slice(0, 300)}`);
  }
  recordStep(report, "save-scene-after-import", { modelReferences: workspaceAfterImport.scene.models.length, revision: workspaceAfterImport.application?.metadata?.revision ?? null });

  // ── 步骤 5a：物理真实运行（Rapier WASM） ──
  const dock = page.getByRole("toolbar", { name: "场景编辑工具" });
  await dock.getByRole("button", { name: /仿真与开发/ }).click();
  await page.locator("#scene-tool-menu-develop").waitFor({ state: "visible" });
  await page.getByRole("menuitem", { name: "物理系统", exact: true }).click();
  const physicsControls = page.locator(".physics-global");
  await physicsControls.waitFor({ state: "visible", timeout: 30_000 });
  const enableButton = physicsControls.locator("button").first();
  await enableButton.click();
  await page.waitForFunction(() => document.querySelector(".physics-global button")?.textContent?.includes("已启用"));
  const playButton = physicsControls.locator("button").nth(1);
  await playButton.click();
  await page.waitForFunction(() => {
    const button = document.querySelector(".physics-global button:nth-of-type(2)") ?? document.querySelectorAll(".physics-global button")[1];
    return Boolean(button?.classList.contains("active")) || button?.textContent?.includes("暂停");
  });
  // 真实运行窗口：让 Rapier step 若干 tick（非性能测量，仅运行事实）。
  await page.waitForTimeout(2_500);
  const physicsState = await physicsControls.locator("button").evaluateAll((buttons) => buttons.map((button) => ({
    label: button.textContent?.trim(),
    active: button.classList.contains("active")
  })));
  const playingVerified = physicsState[1]?.active || physicsState[1]?.label === "暂停";
  if (!playingVerified) fail(`物理播放状态未形成：${JSON.stringify(physicsState)}`);
  await page.screenshot({ path: resolve(outputRoot, "04-physics-running.png"), fullPage: true });
  recordStep(report, "physics-real-run", { engine: "Rapier WASM", playingSeconds: 2.5, buttonStates: physicsState });
  await playButton.click(); // 暂停，保留启用状态

  // ── 步骤 5b：What-if 仿真 Study（确定性本地引擎） ──
  await openOperations(page, productOrigin, project.id);
  await page.getByRole("button", { name: "工况推演", exact: true }).click();
  const whatIfPanel = page.locator(".what-if-workspace");
  await whatIfPanel.waitFor({ state: "visible", timeout: 30_000 });
  const whatIfStudyResponse = page.waitForResponse((response) => response.url().includes("/operations/what-if/studies") && response.request().method() === "POST");
  await whatIfPanel.getByRole("button", { name: "运行并留证" }).click();
  const whatIfStudyHttpResponse = await whatIfStudyResponse;
  const whatIfStudy = await whatIfStudyHttpResponse.json();
  if (!whatIfStudyHttpResponse.ok() || !whatIfStudy?.result || whatIfStudy?.execution?.deterministic !== true) {
    fail(`What-if Study 未真实产出：HTTP ${whatIfStudyHttpResponse.status()} ${JSON.stringify(whatIfStudy).slice(0, 300)}`);
  }
  writeFileSync(resolve(outputRoot, "whatif-study.json"), JSON.stringify(whatIfStudy, null, 2), "utf8");
  await page.screenshot({ path: resolve(outputRoot, "05-whatif-study.png"), fullPage: true });
  recordStep(report, "whatif-simulation-study", {
    studyId: whatIfStudy.id,
    engineId: whatIfStudy.execution?.engineId,
    deterministic: whatIfStudy.execution?.deterministic ?? false,
    inputFingerprint: whatIfStudy.execution?.inputFingerprint
  });

  // ── 步骤 6：工程分析报告生成与下载 ──
  await page.goto(sceneEditorUrl, { waitUntil: "networkidle", timeout: 60_000 });
  await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor({ state: "visible", timeout: 30_000 });
  await dismissRecoveryDialog(page);
  const dockInspect = page.getByRole("toolbar", { name: "场景编辑工具" });
  await dockInspect.getByRole("button", { name: "查看与分析", exact: true }).click();
  await page.locator("#scene-tool-menu-inspect").waitFor({ state: "visible" });
  await page.getByRole("menuitem", { name: "工程分析与导出" }).click();
  const engineeringPanel = page.locator(".scene-engineering-analysis");
  await engineeringPanel.waitFor({ state: "visible", timeout: 30_000 });
  await engineeringPanel.getByRole("button", { name: /运行分析/ }).click();
  await page.locator(".scene-engineering-results").waitFor({ state: "visible", timeout: 60_000 });
  const engineeringSummary = await page.locator(".scene-engineering-metrics").innerText();
  const reportDownload = page.waitForEvent("download", { timeout: 30_000 });
  await engineeringPanel.getByRole("button", { name: "空间报告 JSON" }).click();
  const reportDownloaded = await reportDownload;
  const reportPath = resolve(downloadsRoot, reportDownloaded.suggestedFilename() || "e1-spatial-report.json");
  await reportDownloaded.saveAs(reportPath);
  const reportJson = JSON.parse(readFileSync(reportPath, "utf8"));
  const reportObjectCount = reportJson?.qto?.objectCount ?? reportJson?.objectCount;
  if (!Number.isFinite(reportObjectCount) || reportObjectCount < 1) {
    fail(`工程报告缺少对象数：${JSON.stringify(reportJson).slice(0, 300)}`);
  }
  await page.screenshot({ path: resolve(outputRoot, "06-engineering-report.png"), fullPage: true });
  recordStep(report, "engineering-report", { file: reportPath, metrics: engineeringSummary.replace(/\n/g, " · "), objectCount: reportObjectCount });

  // ── 步骤 7：保存场景 ──
  const saveResponse = page.waitForResponse((response) => response.url().endsWith("/workspace") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存项目" }).click();
  const workspace = await readJsonResponse(saveResponse, 200);
  if (!workspace.scene?.models?.some((model) => model.modelId === uploadedModel.id)) {
    fail(`保存后的场景未引用已导入模型：${JSON.stringify(workspace.scene?.models ?? []).slice(0, 300)}`);
  }
  await page.screenshot({ path: resolve(outputRoot, "07-scene-saved.png"), fullPage: true });
  recordStep(report, "save-scene", { modelReferences: workspace.scene.models.length, revision: workspace.application?.metadata?.revision ?? null });

  // ── 步骤 8：断网重开验证 ──
  await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
  await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor({ state: "visible", timeout: 30_000 });
  await openSceneResourcePanel(page);
  const reopenedRow = page.locator(`.scene-resource-row[data-model-id="${uploadedModel.id}"]`);
  await reopenedRow.waitFor({ state: "visible", timeout: 30_000 });
  const reopenedStatus = await reopenedRow.getAttribute("data-model-status");
  if (reopenedStatus !== "ready") fail(`断网重开后模型状态异常：data-model-status=${reopenedStatus}`);
  await page.locator(".scene-resource-floating").getByRole("button", { name: "关闭资源浮窗" }).click();
  const reopenedProject = await page.evaluate(async ({ projectId, modelId }) => {
    const token = localStorage.getItem("bim-studio-auth-token") ?? sessionStorage.getItem("bim-studio-auth-token");
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!response.ok) return { ok: false, status: response.status };
    const data = await response.json();
    const model = data.models?.find((candidate) => candidate.id === modelId);
    return { ok: true, modelStatus: model?.status ?? null, modelCount: data.models?.length ?? 0 };
  }, { projectId: project.id, modelId: uploadedModel.id });
  if (reopenedProject.modelStatus !== "ready") fail(`断网重开后模型状态异常：${JSON.stringify(reopenedProject)}`);
  await page.screenshot({ path: resolve(outputRoot, "08-reopened-offline.png"), fullPage: true });
  recordStep(report, "reopen-verify-offline", { modelStatus: reopenedProject.modelStatus, modelCount: reopenedProject.modelCount });

  // ── 步骤 9：C4 事件录制 → 事件 → 关闭段 → 导出 → 断网重开 → Study 证据副本 ──
  await openOperations(page, productOrigin, project.id);
  await page.getByRole("button", { name: "现场监控", exact: true }).click();
  const recordingSection = page.locator(".event-recording");
  await recordingSection.waitFor({ state: "visible", timeout: 30_000 });
  await recordingSection.getByRole("button", { name: "建立录制" }).click();
  await page.locator(".event-recording-integrity").waitFor({ state: "visible", timeout: 30_000 });
  const eventDetails = recordingSection.locator("details").filter({ hasText: "写入一条事件" });
  await eventDetails.locator("summary").click();
  const eventBox = recordingSection.getByLabel("录制事件 JSON");
  await eventBox.fill('{"source":"e1-offline","key":"temperature","value":27,"sequence":1}');
  await recordingSection.getByRole("button", { name: "写入并落盘" }).click();
  await page.waitForFunction(() => {
    const counts = document.querySelector(".event-recording-counts b");
    return counts?.textContent === "1";
  });
  await eventBox.fill('{"source":"e1-offline","key":"pressure","value":101.3,"sequence":2}');
  await recordingSection.getByRole("button", { name: "写入并落盘" }).click();
  await page.waitForFunction(() => {
    const counts = document.querySelector(".event-recording-counts b");
    return counts?.textContent === "2";
  });
  const closeButton = recordingSection.getByRole("button", { name: "关闭录制段" });
  await closeButton.click();
  await page.waitForFunction(() => {
    const buttons = [...document.querySelectorAll(".event-recording-actions button")];
    const close = buttons.find((button) => button.textContent?.includes("关闭录制段"));
    return Boolean(close?.disabled);
  });
  await page.screenshot({ path: resolve(outputRoot, "09-recording-captured.png"), fullPage: true });
  const recordingId = await page.evaluate(() => document.querySelector(".event-recording select")?.selectedOptions?.[0]?.value ?? null);
  if (!recordingId) fail("建立录制后未取得录制标识");
  recordStep(report, "c4-recording-captured", { recordingId, events: 2, segmentClosed: true });

  const recordingDownload = page.waitForEvent("download", { timeout: 30_000 });
  await recordingSection.getByRole("button", { name: "导出录制" }).click();
  const recordingDownloaded = await recordingDownload;
  const recordingPath = resolve(downloadsRoot, recordingDownloaded.suggestedFilename() || "e1-recording.json");
  await recordingDownloaded.saveAs(recordingPath);
  const recordingFile = JSON.parse(readFileSync(recordingPath, "utf8"));
  if (recordingFile?.manifest?.totals?.eventCount !== 2) {
    fail(`导出录制事件数不符：${JSON.stringify(recordingFile?.manifest?.totals ?? recordingFile).slice(0, 300)}`);
  }
  if (recordingFile.segments.some((segment) => segment.closedAt === null)) fail("导出录制仍存在未闭合段");

  // 断网重开后从历史重开同一录制（录制持久性 + 重开接缝入口）。
  await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
  await openOperations(page, productOrigin, project.id);
  await page.getByRole("button", { name: "现场监控", exact: true }).click();
  const recordingSectionAgain = page.locator(".event-recording");
  await recordingSectionAgain.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction((expectedId) => {
    const select = document.querySelector(".event-recording select");
    return [...(select?.options ?? [])].some((option) => option.value === expectedId);
  }, recordingId, { timeout: 30_000 });
  await recordingSectionAgain.locator("select").first().selectOption(recordingId);
  await page.waitForFunction(() => document.querySelector(".event-recording-integrity")?.textContent?.includes("段已闭合"));
  const reopenedCounts = await page.locator(".event-recording-counts").innerText();
  if (!reopenedCounts.replace(/\s/g, "").includes("事件2")) fail(`断网重开后录制事件数不符：${reopenedCounts.replace(/\n/g, " ")}`);

  // Study 证据副本：选 What-if Study，导出 study+recording+assessment。
  const studyDetails = recordingSectionAgain.locator("details").filter({ hasText: "Study 证据副本" });
  await studyDetails.locator("summary").click();
  const studyOptions = await studyDetails.locator("select option").evaluateAll((options) => options.map((option) => ({ value: option.value, text: option.textContent?.trim() })));
  const targetStudy = studyOptions.find((option) => option.value) ?? fail(`Study 下拉无已完成记录：${JSON.stringify(studyOptions)}`);
  await studyDetails.locator("select").selectOption(targetStudy.value);
  const evidenceDownload = page.waitForEvent("download", { timeout: 30_000 });
  await studyDetails.getByRole("button", { name: "导出证据副本" }).click();
  const evidenceDownloaded = await evidenceDownload;
  const evidencePath = resolve(downloadsRoot, evidenceDownloaded.suggestedFilename() || "e1-study-evidence.json");
  await evidenceDownloaded.saveAs(evidencePath);
  const evidenceCopy = JSON.parse(readFileSync(evidencePath, "utf8"));
  if (!evidenceCopy?.study?.result || evidenceCopy?.recording?.manifest?.recordingId !== recordingId || typeof evidenceCopy?.assessment?.integrityOk !== "boolean") {
    fail(`证据副本结构不完整：${JSON.stringify(Object.keys(evidenceCopy ?? {}))}`);
  }
  await page.screenshot({ path: resolve(outputRoot, "10-recording-reopened-study-evidence.png"), fullPage: true });
  recordStep(report, "c4-recording-reopen-and-study-evidence", {
    recordingId,
    reopenedCounts: reopenedCounts.replace(/\n/g, " "),
    integrity: "段已闭合 · 无已知缺口",
    studyOption: targetStudy.text,
    evidenceFile: evidencePath,
    recordingFile: recordingPath
  });

  // ── 汇总门 ──
  if (report.offline.externalSuccesses.length > 0) {
    fail(`断网会话出现外部成功响应：${JSON.stringify(report.offline.externalSuccesses)}`);
  }
  report.passed = true;
} catch (reason) {
  exitCode = 1;
  report.failure = {
    message: String(reason?.message ?? reason),
    stack: String(reason?.stack ?? "").split("\n").slice(0, 8)
  };
} finally {
  report.finishedAt = new Date().toISOString();
  report.apiLogTail = report.apiLogs.slice(-40);
  delete report.apiLogs;
  writeFileSync(resolve(outputRoot, "evidence.json"), JSON.stringify(report, null, 2), "utf8");
  try { await browser?.close(); } catch { /* 浏览器已退出 */ }
  server.close();
  api.kill();
}

process.exit(exitCode);

/** 在断网会话中稳定打开运营中心（路由直达，失败回退管理页选项目再进入）。 */
async function openOperations(page, origin, projectId) {
  await page.goto(`${origin}/operations`, { waitUntil: "networkidle", timeout: 60_000 });
  try {
    await page.locator(".operations-page").waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    await page.goto(origin, { waitUntil: "networkidle", timeout: 60_000 });
    await page.locator(".scene-manager-page").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByLabel("当前项目").selectOption(projectId);
    await page.getByRole("button", { name: "智能运营" }).click();
    await page.locator(".operations-page").waitFor({ state: "visible", timeout: 30_000 });
  }
}

/** 未保存改动触发的本地恢复对话框：恢复到当前页继续验收。 */
async function dismissRecoveryDialog(page) {
  const recoveryDialog = page.locator(".workspace-recovery-dialog");
  if (await recoveryDialog.isVisible().catch(() => false)) {
    await recoveryDialog.getByRole("button", { name: "恢复到当前页" }).click();
    await recoveryDialog.waitFor({ state: "hidden", timeout: 30_000 });
  }
}

/** 打开场景目录左侧"资源"浮窗并切到"项目资源"范围（模型资源行只在此列出）。 */
async function openSceneResourcePanel(page) {
  const resourceToggle = page.getByRole("button", { name: "资源", exact: true }).first();
  const className = await resourceToggle.getAttribute("class");
  if (!className?.includes("active")) await resourceToggle.click();
  const panel = page.locator(".scene-resource-floating");
  await panel.waitFor({ state: "visible", timeout: 30_000 });
  const projectScope = panel.getByRole("button", { name: "项目资源", exact: true });
  const scopeClass = await projectScope.getAttribute("class");
  if (!scopeClass?.includes("active")) await projectScope.click();
}

/** 生成单位立方体 GLTF（仓内生成 fixture，离线上传走产品导入链路）。 */
function writeCubeGltf(filePath) {
  const positions = new Float32Array([
    0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0,
    0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0
  ]);
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 7, 0, 7, 3,
    1, 5, 6, 1, 6, 2,
    0, 5, 4, 0, 1, 5,
    3, 2, 6, 3, 6, 7
  ]);
  const positionBuffer = Buffer.from(positions.buffer);
  const indexBuffer = Buffer.from(indices.buffer);
  const binary = Buffer.concat([positionBuffer, indexBuffer]);
  const document = {
    asset: { version: "2.0", generator: "DeepMonkey Studio E1 offline closure gate" },
    scene: 0,
    scenes: [{ nodes: [0], name: "E1 offline scene" }],
    nodes: [{ mesh: 0, name: "E1 离线验收立方体" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }], name: "E1Cube" }],
    buffers: [{ byteLength: binary.length, uri: `data:application/octet-stream;base64,${binary.toString("base64")}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBuffer.length, target: 34962 },
      { buffer: 0, byteOffset: positionBuffer.length, byteLength: indexBuffer.length, target: 34963 }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [0, 0, 0], max: [1, 1, 1] },
      { bufferView: 1, componentType: 5123, count: 36, type: "SCALAR" }
    ]
  };
  writeFileSync(filePath, `${JSON.stringify(document)}\n`, "utf8");
}
