import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { readBrowserRecoveryDraft, verifyOfflineWorkspaceRecovery } from "./onlineFlowRecovery.mjs";
import { verifyBehaviorWorkerCrash } from "./onlineFlowWorkerFault.mjs";
import { createProductServer } from "./onlineFlowProductServer.mjs";
import { verifyUnityRuntimeReliability } from "./onlineFlowUnityRuntime.mjs";
import { seedAskDataDataset, seedMaintenanceModel, verifyAskDataBrowser } from "./onlineFlowAskData.mjs";
import { auditBehaviorWorkbench, behaviorUxFailures } from "./onlineFlowBehaviorUx.mjs";
import { verifyBehaviorPanelCollapse, verifyDependencyManagerResponsive } from "./onlineFlowBehaviorPanels.mjs";
import { verifyDashboardPanelCollapse } from "./onlineFlowDashboardPanels.mjs";
import { verifyIndustrialAgentBrowser, verifyScriptAgentEntry } from "./onlineFlowIndustrialAgent.mjs";
import { auditResponsiveWorkspace } from "./onlineFlowResponsiveUx.mjs";
import { verifyAiOperationsFlow } from "./onlineFlowOperations.mjs";
import { publishWithViewerToolbar } from "./onlineFlowPublication.mjs";
import { verifySceneMoveAndAnimation } from "./onlineFlowSceneEditing.mjs";
import { verifyTopologyFlow } from "./onlineFlowTopology.mjs";
import { auditMaintenanceWideLayout } from "./onlineFlowWideLayout.mjs";
import { finalizeOnlineFlowReport } from "./onlineFlowReportAssessment.mjs";
import {
  applicationPageUrl,
  auditDeliveryFlow,
  auditKeyboardNavigation,
  auditPage,
  captureProcessOutput,
  dismissRecoveryDialogs as dismissSharedRecoveryDialogs,
  readJsonResponse,
  recordStep,
  reservePort,
  showFlatSceneObjects,
  waitForHealth,
  waitForModelReady,
  writeMinimalGltf
} from "./onlineFlowAuditSupport.mjs";
const { chromium } = playwright;
const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(webRoot, "../..");
const webDistRoot = resolve(webRoot, "dist");
const apiEntry = resolve(repositoryRoot, "apps/api/dist/index.js");
const outputRoot = resolve(repositoryRoot, "test-output/online-flow");
const dataRoot = resolve(outputRoot, "data");
const modelFixturePath = resolve(outputRoot, "online-flow-triangle.gltf");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const dismissRecoveryDialogs = page => dismissSharedRecoveryDialogs(page, { maxRounds: 4, applicationAction: "稍后处理" });

if (!existsSync(webDistRoot) || !existsSync(apiEntry)) throw new Error("缺少生产产物，请先执行 pnpm build");
if (!existsSync(chromePath)) throw new Error(`Chrome 不存在：${chromePath}`);
// 清理范围固定在 test-output/online-flow，绝不触碰用户项目数据。
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });
writeMinimalGltf(modelFixturePath);
const apiPort = await reservePort();
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const server = createProductServer(webDistRoot, apiOrigin);
await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
const serverAddress = server.address();
if (!serverAddress || typeof serverAddress === "string") throw new Error("无法创建在线流程验收服务器");
const productOrigin = `http://127.0.0.1:${serverAddress.port}`;
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
    METADATA_STORE: "json",
    OBJECT_STORE: "local",
    BIM_STUDIO_E2E_EPHEMERAL: "true",
    BIM_STUDIO_ADMIN_PASSWORD: "online-flow-admin",
    // 生产配置门禁要求至少 32 位；验收密钥仅用于临时测试进程。
    BIM_STUDIO_SESSION_SECRET: "online-flow-session-secret-2026-verified"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
captureProcessOutput(api.stdout, apiLogs);
captureProcessOutput(api.stderr, apiLogs);
let browser;
let closeUnityRuntime;
let page;
const report = {
  createdAt: new Date().toISOString(),
  productOrigin,
  apiOrigin,
  steps: [],
  pageAudits: [],
  keyboardAudits: [],
  faultChecks: [],
  warnings: [],
  expectedConsoleErrors: [],
  expectedRequestFailures: [],
  expectedPageErrors: [],
  consoleErrors: [],
  pageErrors: [],
  requestFailures: []
};
let injectingWorkspaceFailure = false;
let injectingBehaviorWorkerFailure = false;
try {
  await waitForHealth(`${apiOrigin}/health`, api);
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  // 撤销/重做链的 debug 观测环:产品在 flush/undo/redo 打 console.debug;等待失败时
  // 倒出最近条目,把"真竞态"与"记账吸收误伤"区分开,不靠猜。
  const sceneHistoryDebugRing = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("[scene-history]")) {
      sceneHistoryDebugRing.push(text);
      if (sceneHistoryDebugRing.length > 40) sceneHistoryDebugRing.shift();
    }
    if (message.type() !== "error") return;
    const source = message.location().url;
    const entry = source ? `${message.text()} · ${source}` : message.text();
    const expectedWorkspace503 = entry.includes("/workspace") && entry.includes("503");
    // 临时在线流使用本地对象存储，不装载公共素材目录；页面需降级为可重试空态，不能把可选目录当作主交付链失败。
    const expectedAssetCatalog503 = entry.includes("/asset-library") && entry.includes("503");
    const expectedOfflineFailure = entry.includes("ERR_INTERNET_DISCONNECTED");
    // 页面卸载/导航时浏览器中止在途请求(ERR_ABORTED),不构成服务端或前端缺陷。
    const expectedAbort = entry.includes("ERR_ABORTED");
    if ((injectingWorkspaceFailure && (expectedWorkspace503 || expectedOfflineFailure)) || expectedAssetCatalog503 || expectedAbort) report.expectedConsoleErrors.push(entry);
    else report.consoleErrors.push(entry);
  });
  page.on("pageerror", (error) => {
    if (injectingBehaviorWorkerFailure && error.message.includes("online-flow-worker-crash")) report.expectedPageErrors.push(error.message);
    else report.pageErrors.push(error.message);
  });
  page.on("requestfailed", (request) => {
    const entry = `${request.method()} ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`;
    // 页面卸载/导航中止在途请求(ERR_ABORTED)是浏览器标准行为,不算失败。
    const expectedAbort = entry.includes("ERR_ABORTED");
    if (injectingWorkspaceFailure || expectedAbort) report.expectedRequestFailures.push(entry);
    else report.requestFailures.push(entry);
  });
  await page.goto(productOrigin, { waitUntil: "networkidle" });
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("online-flow-admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.locator(".scene-manager-page").waitFor({ state: "visible" });
  recordStep(report, "login", page.url());
  report.pageAudits.push(await auditPage(page, "manager-empty"));
  report.keyboardAudits.push(await auditKeyboardNavigation(page, "manager-empty"));
  await page.screenshot({ path: resolve(outputRoot, "01-manager.png"), fullPage: true });
  await page.locator('summary[aria-label="项目管理"]').click();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("在线流程验收项目");
  const projectResponse = page.waitForResponse((response) => response.url().endsWith("/api/projects") && response.request().method() === "POST");
  await page.getByRole("button", { name: "创建并切换" }).click();
  const project = await readJsonResponse(projectResponse, 201);
  await page.getByLabel("当前项目").selectOption(project.id);
  const askDataDataset = await seedAskDataDataset({ page, apiOrigin, projectId: project.id, report });
  // 维护任务需要可运行模型;种子 native-json 模型(导入即 candidate,无需 ONNX 制品)。
  await seedMaintenanceModel({ page, apiOrigin, projectId: project.id });
  recordStep(report, "create-project", project.id);

  // 项目级开发流程必须可见、可导航，并在刷新后恢复用户上下文。
  const deliveryFlow = page.locator(".project-delivery-flow");
  await deliveryFlow.waitFor({ state: "visible", timeout: 30_000 });
  await deliveryFlow.getByRole("button", { name: "展开开发流程" }).click();
  const deliveryButtons = deliveryFlow.locator("button[data-step-id]");
  await deliveryButtons.nth(7).waitFor({ state: "visible" });
  const deliveryFlowBefore = await auditDeliveryFlow(page, project.id);
  if (deliveryFlowBefore.stepCount !== 8 || !deliveryFlowBefore.stepIds.includes("behavior") || !deliveryFlowBefore.stepIds.includes("simulation")) {
    throw new Error(`项目开发流程步骤不完整：${JSON.stringify(deliveryFlowBefore)}`);
  }
  await deliveryFlow.locator('button[data-step-id="publish"]').click();
  const deliveryReview = page.locator(".delivery-review");
  await deliveryReview.waitFor({ state: "visible" });
  const blockedPublishAudit = {
    workflow: await auditDeliveryFlow(page, project.id),
    directActions: await deliveryReview.locator(".delivery-review-list article > button").allTextContents()
  };
  if (blockedPublishAudit.workflow.activeStep !== "validate" || !blockedPublishAudit.directActions.includes("去接入数据") || !blockedPublishAudit.directActions.includes("去创建场景")) {
    throw new Error(`发布阻断没有转入可处理的交付校验：${JSON.stringify(blockedPublishAudit)}`);
  }
  await deliveryReview.getByRole("button", { name: "关闭", exact: true }).click();
  await deliveryReview.waitFor({ state: "hidden" });
  await deliveryFlow.locator('button[data-step-id="assets"]').click();
  await page.locator(".asset-library-page").waitFor({ state: "visible" });
  // 资源库是独立工作区，不重复渲染项目流程；导航记忆仍保留在本地存储。
  const deliveryFlowAfterClick = await auditDeliveryFlow(page, project.id);
  if (deliveryFlowAfterClick.stepCount !== 0 || deliveryFlowAfterClick.persistedStep !== "assets") {
    throw new Error(`资源库未正确收起项目流程或导航上下文丢失：${JSON.stringify(deliveryFlowAfterClick)}`);
  }
  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("当前项目").selectOption(project.id);
  await page.getByRole("button", { name: "项目场景", exact: true }).click();
  await deliveryFlow.waitFor({ state: "visible", timeout: 30_000 });
  await deliveryFlow.getByRole("button", { name: "展开开发流程" }).click();
  const deliveryFlowAfterReload = await auditDeliveryFlow(page, project.id);
  if (deliveryFlowAfterReload.activeStep !== "assets") {
    throw new Error(`刷新后未恢复开发流程步骤：${JSON.stringify(deliveryFlowAfterReload)}`);
  }
  recordStep(report, "delivery-flow-navigation-and-context-restore", {
    before: deliveryFlowBefore,
    blockedPublish: blockedPublishAudit,
    afterClick: deliveryFlowAfterClick,
    afterReload: deliveryFlowAfterReload
  });
  await page.getByRole("button", { name: "项目场景", exact: true }).click();
  await page.locator(".scene-manager-page").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("产线在线验收场景");
  const sceneResponse = page.waitForResponse((response) => response.url().includes(`/api/projects/${project.id}/applications`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "创建并进入" }).click();
  const application = await readJsonResponse(sceneResponse, 201);
  const scene = application.scenes?.find((candidate) => candidate.name === "产线在线验收场景") ?? application.scenes?.[0];
  if (!scene?.id || !application.metadata?.id) throw new Error("创建场景后未返回有效应用与场景标识");
  // P2-2(6d575687)后“创建并进入”强制落三维编辑器；先等三维视口就绪，再切“二维”进入看板工作台。
  // Deep 激活后首段时间线更慢：场景快照就绪前点“二维”会被产品契约拦下（提示“待载入完成后
  // 保存”），真实用户会稍候重试。门按同一契约在等待窗口内重试点击；被拦截时记录 toast 文本，
  // 超窗仍失败则带归因信息抛出，不静默放宽。
  await page.locator(".app-shell .viewport").waitFor({ state: "visible", timeout: 30_000 });
  const dashboardWorkspace = page.locator(".dashboard-workspace");
  let dashboardBlockedToast = "";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await dashboardWorkspace.isVisible().catch(() => false)) break;
    const errorToast = page.locator(".toast.error");
    if (await errorToast.isVisible().catch(() => false)) {
      dashboardBlockedToast = await errorToast.innerText().catch(() => dashboardBlockedToast);
    }
    // 已切到二维(竞态窗口)时按钮会 disabled;短超时吞掉该轮点击,循环头的可见性检查兜底。
    await page.getByRole("button", { name: "二维", exact: true }).click({ timeout: 5_000 }).catch(() => {});
    await dashboardWorkspace.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  }
  if (!(await dashboardWorkspace.isVisible().catch(() => false))) {
    throw new Error(`二维工作台未在重试窗口内打开${dashboardBlockedToast ? `，产品拦截提示：${dashboardBlockedToast}` : ""}`);
  }
  await page.getByText("正在载入场景数据").waitFor({ state: "hidden", timeout: 30_000 });
  recordStep(report, "create-scene-and-open-dashboard", page.url());
  report.pageAudits.push(await auditPage(page, "dashboard-editor"));
  await page.screenshot({ path: resolve(outputRoot, "02-dashboard-editor.png"), fullPage: true });
  // 商业编辑器的组件库必须支持“拖到哪里就创建在哪里”，同时保留点击插入的低门槛路径。
  // 组件库在左面板“资源”页签（默认“图层”）——先切换再等卡片。
  await page.getByRole("button", { name: /资源|Resources/ }).first().click();
  const artboard = page.locator(".dashboard-artboard");
  const componentCard = page.locator(".dashboard-library-card:not(.dashboard-library-scene-card)").first();
  const nodeCountBeforeDrag = await artboard.locator(":scope > .dashboard-node").count();
  const artboardBounds = await artboard.boundingBox();
  if (!artboardBounds) throw new Error("二维画布不可见，无法验证组件拖拽插入");
  const dropPoint = { x: artboardBounds.width * 0.76, y: artboardBounds.height * 0.28 };
  await componentCard.dragTo(artboard, { targetPosition: dropPoint });
  await page.waitForFunction((expected) => document.querySelectorAll(".dashboard-artboard > .dashboard-node").length === expected, nodeCountBeforeDrag + 1);
  const insertedBounds = await artboard.locator(":scope > .dashboard-node.selected").boundingBox();
  if (!insertedBounds) throw new Error("拖拽插入后新组件未保持选中");
  const insertedCenter = { x: insertedBounds.x + insertedBounds.width / 2, y: insertedBounds.y + insertedBounds.height / 2 };
  const expectedCenter = { x: artboardBounds.x + dropPoint.x, y: artboardBounds.y + dropPoint.y };
  if (Math.abs(insertedCenter.x - expectedCenter.x) > 24 || Math.abs(insertedCenter.y - expectedCenter.y) > 24) {
    throw new Error(`拖拽组件未落在目标位置：${JSON.stringify({ insertedCenter, expectedCenter })}`);
  }
  recordStep(report, "drag-dashboard-component-to-exact-position", { nodeCountBeforeDrag, insertedCenter, expectedCenter });
  await page.screenshot({ path: resolve(outputRoot, "02a-dashboard-library-drag.png"), fullPage: true });
  await auditResponsiveWorkspace({ page, report, outputRoot, id: "02a-dashboard-editor", scopeSelector: ".dashboard-workspace" });
  await verifyDashboardPanelCollapse({ page, report, outputRoot });
  closeUnityRuntime = await verifyUnityRuntimeReliability({ page, report, outputRoot });
  // 先在二维图层中选中一个组件，脚本入口必须继承这个对象而不是退回整个场景。
  // 左栏默认页签是"页面";图层树按需切页签进入(产品已移除"页面与图层"合并页签)。
  await page.locator(".dashboard-workspace").getByRole("button", { name: "图层", exact: true }).click();
  const firstDashboardLayer = page.locator(".dashboard-layer-select").first();
  await firstDashboardLayer.waitFor({ state: "visible" });
  await firstDashboardLayer.click();
  await page.waitForFunction(() => document.querySelectorAll(".dashboard-layer-row.active").length === 1);
  // 脚本编辑器属于 2D/3D 共用主链，至少验证可从工作区进入、创建并完成编辑器初始化。
  await page.getByRole("button", { name: "脚本", exact: true }).click();
  const behaviorPanel = page.locator(".behavior-panel");
  await behaviorPanel.waitFor({ state: "visible" });
  await behaviorPanel.getByRole("button", { name: "新建", exact: true }).click();
  await behaviorPanel.locator(".professional-code-editor").waitFor({ state: "visible", timeout: 30_000 });
  await behaviorPanel.locator(".monaco-editor, .professional-code-fallback").first().waitFor({ state: "visible", timeout: 30_000 });
  const attachedTarget = await behaviorPanel.locator(".behavior-context-badge").innerText();
  if (attachedTarget.includes("整个场景")) throw new Error(`二维选中组件未传入脚本上下文：${attachedTarget}`);
  report.behaviorUx = await auditBehaviorWorkbench(behaviorPanel);
  const behaviorFailures = behaviorUxFailures(report.behaviorUx);
  if (behaviorFailures.length) throw new Error(`脚本首屏体验验收失败：${behaviorFailures.join("；")}`);
  // 只量常驻可见的工具栏图标按钮;下拉菜单项(分屏/悬浮等)本就允许文字,
  // Chrome 对闭合 details 内容保留布局(content-visibility),须用 checkVisibility 过滤。
  const behaviorHeaderAudit = await behaviorPanel.locator(".behavior-panel-actions button").evaluateAll((buttons) => buttons.filter((button) => button.checkVisibility()).map((button) => {
    const bounds = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      runAction: button.classList.contains("behavior-run-action"),
      label: button.getAttribute("aria-label") || button.getAttribute("title") || button.textContent?.trim(),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      fontSize: style.fontSize,
      whiteSpace: style.whiteSpace,
    };
  }));
  // 图标按钮须 fontSize 0(纯图标);主操作(behavior-run-action)保留文字标签是有意设计,
  // 只执行尺寸与 nowrap 纪律(防挤压换行),不强制去文字。
  if (behaviorHeaderAudit.some((button) => button.width < 28 || button.height > 38 || button.whiteSpace !== "nowrap"
    || (button.fontSize !== "0px" && !button.runAction))) {
    throw new Error(`脚本分屏工具栏出现文字竖排或点击区异常：${JSON.stringify(behaviorHeaderAudit)}`);
  }
  recordStep(report, "keep-script-split-toolbar-icon-only", behaviorHeaderAudit);
  await verifyBehaviorPanelCollapse({ page, behaviorPanel, report, outputRoot });
  await verifyDependencyManagerResponsive({ page, behaviorPanel, report, outputRoot });
  await page.screenshot({ path: resolve(outputRoot, "02b-behavior-editor.png"), fullPage: true });
  // 不只验证“能打开编辑器”：脚本运行错误必须回到问题列表，可定位并修复后重跑。
  const runtimeErrorMessage = "online-flow-script-error";
  const monacoEditor = behaviorPanel.locator(".monaco-editor").first();
  const editorInput = behaviorPanel.locator(".monaco-editor textarea.inputarea, .monaco-editor textarea").first();
  await monacoEditor.click({ position: { x: 180, y: 100 } });
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  // Monaco 在首次获得焦点时可能保留末尾字符，再次全选清空可避免伪造语法故障。
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  // Monaco 会为左花括号自动补齐右花括号，测试输入不再重复插入末尾。
  await page.keyboard.insertText(`function onStart(ctx) {\n  throw new Error("${runtimeErrorMessage}");`);
  await behaviorPanel.getByText("有未应用的修改", { exact: true }).waitFor({ state: "visible" });
  recordStep(report, "edit-runtime-error-script", await monacoEditor.locator(".view-lines").innerText());
  // 应用+运行已合并为工具栏"试运行"主按钮(applyAndRun),旧"应用并运行"按钮不存在了。
  await behaviorPanel.locator(".behavior-run-action").click();
  const problemsButton = behaviorPanel.locator(".professional-code-problems.has-problems");
  await problemsButton.waitFor({ state: "visible", timeout: 15_000 });
  await problemsButton.click();
  const runtimeProblem = behaviorPanel.locator(".professional-code-problem-list button").filter({ hasText: runtimeErrorMessage });
  try {
    await runtimeProblem.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    const observedDiagnostics = await behaviorPanel.locator(".professional-code-problem-list button").allInnerTexts();
    throw new Error(`未观察到脚本运行错误，当前诊断：${JSON.stringify(observedDiagnostics)}`);
  }
  if (!((await runtimeProblem.innerText()).includes("Ln 2"))) throw new Error("脚本运行错误未定位到第 2 行");
  await runtimeProblem.click();
  try {
    await page.waitForFunction(() => document.querySelector(".monaco-editor")?.classList.contains("focused"), undefined, { timeout: 5_000 });
  } catch {
    const focusState = await page.evaluate(() => ({ tag: document.activeElement?.tagName, className: document.activeElement?.className }));
    throw new Error(`点击脚本诊断后未将焦点返编辑器：${JSON.stringify(focusState)}`);
  }
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText('function onStart(ctx) {\n  ctx.log("online-flow-script-recovered");');
  await behaviorPanel.getByText("有未应用的修改", { exact: true }).waitFor({ state: "visible" });
  // 应用+运行已合并为工具栏"试运行"主按钮(applyAndRun),旧"应用并运行"按钮不存在了。
  await behaviorPanel.locator(".behavior-run-action").click();
  await behaviorPanel.locator(".professional-code-problems.healthy").waitFor({ state: "visible", timeout: 15_000 });
  await behaviorPanel.getByText("试运行已提交，请查看运行状态与日志", { exact: true }).waitFor({ state: "visible" });
  recordStep(report, "recover-runtime-script-error", { target: attachedTarget, line: 2 });
  await page.screenshot({ path: resolve(outputRoot, "02bb-behavior-editor-recovered.png"), fullPage: true });
  const popoutFingerprint = await behaviorPanel.locator(".professional-code-editor").getAttribute("data-content-fingerprint");
  // 独立窗口入口在"切换窗口布局"下拉里;先展开菜单再点(与真实用户路径一致)。
  const [scriptWindow] = await Promise.all([
    page.waitForEvent("popup"),
    behaviorPanel.locator(".behavior-layout-menu > summary").click(),
    behaviorPanel.getByRole("button", { name: "独立窗口", exact: true }).click(),
  ]);
  const popoutPanel = scriptWindow.locator(".behavior-panel.layout-window");
  await popoutPanel.waitFor({ state: "visible", timeout: 10_000 });
  if (!/· 脚本编辑器 · DeepMonkey Studio$/.test(await scriptWindow.title())) throw new Error(`脚本独立窗口标题不符合规范：${await scriptWindow.title()}`);
  const windowFingerprint = await popoutPanel.locator(".professional-code-editor").getAttribute("data-content-fingerprint");
  if (!popoutFingerprint || popoutFingerprint !== windowFingerprint) throw new Error(`脚本独立窗口丢失编辑内容：${popoutFingerprint} -> ${windowFingerprint}`);
  await scriptWindow.screenshot({ path: resolve(outputRoot, "02bd-behavior-editor-window.png"), fullPage: true });
  // 独立窗口的收回入口在主窗口"回到分屏"(changeLayout 会关闭 popup),旧"收回主窗口"按钮已移除。
  await Promise.all([
    scriptWindow.waitForEvent("close"),
    page.locator(".behavior-window-return").getByRole("button", { name: "回到分屏", exact: true }).click(),
  ]);
  await behaviorPanel.locator(`.professional-code-editor[data-content-fingerprint="${popoutFingerprint}"]`).waitFor({ state: "visible", timeout: 5_000 });
  recordStep(report, "open-script-window-and-return-with-state", { fingerprint: popoutFingerprint });
  await auditResponsiveWorkspace({ page, report, outputRoot, id: "02bb-behavior-editor", scopeSelector: ".behavior-panel" });
  report.scriptAgentEntry = await verifyScriptAgentEntry({ page, behaviorPanel, outputRoot });
  recordStep(report, "open-agent-from-script-and-return-with-draft", report.scriptAgentEntry);
  injectingBehaviorWorkerFailure = true;
  try {
    await verifyBehaviorWorkerCrash({ page, behaviorPanel, report });
  } finally {
    injectingBehaviorWorkerFailure = false;
  }
  // 行为编辑的草稿防抖可能随时弹出恢复对话框并拦截点击;交互前统一处置。
  await dismissRecoveryDialogs(page);
  await behaviorPanel.getByRole("button", { name: "定位目标", exact: true }).click();
  await behaviorPanel.waitFor({ state: "hidden" });
  await page.locator(".dashboard-workspace").waitFor({ state: "visible" });
  if (await page.locator(".dashboard-layer-row.active").count() === 0) throw new Error("脚本定位二维目标后未恢复图层选中状态");
  await page.getByRole("button", { name: "脚本", exact: true }).click();
  await behaviorPanel.waitFor({ state: "visible" });
  // 工作区模式由全局标题栏统一控制；切换时必须保存未应用草稿并保持上下文。
  await behaviorPanel.locator(".monaco-editor").first().click({ position: { x: 180, y: 100 } });
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// workspace-switch-keeps-draft");
  await behaviorPanel.getByText("有未应用的修改", { exact: true }).waitFor({ state: "visible" });
  const continuityFingerprint = await behaviorPanel.locator(".professional-code-editor").getAttribute("data-content-fingerprint");
  if (!continuityFingerprint) throw new Error("脚本编辑器未生成草稿指纹");
  await page.getByRole("button", { name: "三维", exact: true }).click();
  await page.locator(".app-shell .viewport").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "脚本", exact: true }).click();
  await behaviorPanel.waitFor({ state: "visible" });
  await behaviorPanel.locator(`.professional-code-editor[data-content-fingerprint="${continuityFingerprint}"]`).waitFor({ state: "visible", timeout: 5_000 }).catch(async () => {
    const reopenedFingerprint = await behaviorPanel.locator(".professional-code-editor").getAttribute("data-content-fingerprint");
    throw new Error(`脚本切换到三维后草稿指纹不一致：${continuityFingerprint} -> ${reopenedFingerprint ?? "missing"}`);
  });
  await page.screenshot({ path: resolve(outputRoot, "02bc-behavior-editor-3d-restored.png"), fullPage: true });
  await page.getByRole("button", { name: "二维", exact: true }).click();
  await page.locator(".dashboard-workspace").waitFor({ state: "visible" });
  await behaviorPanel.waitFor({ state: "hidden" });
  // 验证 2D → 3D → 2D 的统一工作区切换，不依赖重新打开项目来掩盖上下文断裂。
  await page.getByRole("button", { name: "三维", exact: true }).click();
  await page.locator(".app-shell .viewport").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "二维", exact: true }).click();
  await page.locator(".dashboard-workspace").waitFor({ state: "visible" });
  recordStep(report, "switch-2d-3d-script-workspace", { url: page.url(), draftPreserved: true });
  const sceneEditorUrl = `${productOrigin}/studio/${encodeURIComponent(project.id)}/applications/${encodeURIComponent(application.metadata.id)}/scenes/${encodeURIComponent(scene.id)}`;
  await page.goto(sceneEditorUrl, { waitUntil: "networkidle" });
  await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor({ state: "visible", timeout: 30_000 });
  // 前面工作区的编辑可能留下本地恢复副本;直连场景编辑器时先处置恢复对话框。
  // 副本读取与应用身份都是异步就位,首个对话框关闭后同类副本可能再次弹出
  // (Deep 下加载更慢,时序更晚),单发点击不再够:按既有循环处置同族处理。
  await dismissRecoveryDialogs(page);
  if (await page.locator(".workspace-recovery-backdrop").isVisible().catch(() => false)) {
    throw new Error("恢复对话框未在循环处置后关闭，存在重复复活的产品路径");
  }
  // 从规则数据生成 GeoJSON 设备方盒，并同时创建可绑定数据的模型标签。
  // 批量设备布局已收纳进"更多场景工具"菜单;导入模型直连文件选择器(不再有导入面板)。
  // 设备必须只落在本地恢复副本里:自动保存若开着,设备会先上服务器,草稿就与服务器等价,
  // 恢复判定会正确地按 discard-equivalent 静默丢弃,后面的故障注入测试失去意义。
  if (await page.getByLabel("自动保存").isChecked().catch(() => false)) {
    await page.getByLabel("自动保存").click();
  }
  await page.getByTitle("更多场景工具").click();
  await page.getByRole("button", { name: "批量设备布局" }).click();
  const deviceLayout = page.locator(".device-layout-workbench");
  await deviceLayout.waitFor({ state: "visible" });
  await page.screenshot({ path: resolve(outputRoot, "02c-device-layout-workbench.png"), fullPage: true });
  await deviceLayout.getByRole("button", { name: "创建 12 台设备" }).click();
  // 设备创建完成后工作台可能已自动收起(completed → onClose);仍在才需要手动关。
  const deviceLayoutClose = page.getByLabel("关闭设备布局");
  if (await deviceLayoutClose.isVisible().catch(() => false)) await deviceLayoutClose.click();
  await showFlatSceneObjects(page);
  await page.locator(".scene-object-row").filter({ hasText: "设备 001" }).first().waitFor({ state: "visible" });
  const generatedDeviceAudit = await page.evaluate(() => ({
    boxes: [...document.querySelectorAll(".scene-object-row")].filter((element) => element.textContent?.includes("基础元素")).length,
    labels: document.querySelectorAll(".scene-object-row .annotation-badge").length
  }));
  if (generatedDeviceAudit.boxes < 12 || generatedDeviceAudit.labels < 12) {
    throw new Error(`批量设备与标签创建不完整：${JSON.stringify(generatedDeviceAudit)}`);
  }
  // 故障注入：正式请求前应已有本地恢复副本，服务临时不可用也不能丢失未保存设备。
  const failWorkspaceSave = async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "故障注入：暂时无法保存" }) });
  };
  await page.route("**/workspace", failWorkspaceSave);
  injectingWorkspaceFailure = true;
  const failedWorkspaceResponse = page.waitForResponse((response) => response.url().endsWith("/workspace") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存项目" }).click();
  const failedSave = await failedWorkspaceResponse;
  report.faultChecks.push({ id: "recover-after-workspace-save-failure", expectedStatus: 503, actualStatus: failedSave.status() });
  await page.locator(".toast.error").waitFor({ state: "visible" });
  injectingWorkspaceFailure = false;
  const recoveryIdentity = { projectId: project.id, applicationId: application.metadata.id, sceneId: scene.id };
  const recoveryDraftBeforeReload = await readBrowserRecoveryDraft(page, recoveryIdentity);
  if (!recoveryDraftBeforeReload?.scene?.primitives?.length) throw new Error("保存失败后未落盘本地恢复副本");
  await page.unroute("**/workspace", failWorkspaceSave);
  await page.reload({ waitUntil: "networkidle" });
  // 两类恢复对话框共用 .workspace-recovery-dialog 类,按 aria-label 区分:
  // 场景级"恢复未保存修改"(本步被试对象) vs 应用级"恢复应用修改"(行为工作区遗留,
  // 先弹且压住场景级;稍前已"稍后处理"过会保留副本,重载后会再次弹出)。
  // 两类恢复对话框共用 .workspace-recovery-dialog 类且场景草稿异步加载,谁先弹不确定:
  // 场景级=被试对象直接进入断言;应用级=遗留副本,"稍后处理"后继续等场景级。
  const appRecoveryDialog = page.locator('section[aria-label="恢复应用修改"]');
  const recoveryDialog = page.locator('section[aria-label="恢复未保存工作"]');
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await recoveryDialog.isVisible().catch(() => false)) break;
    if (await appRecoveryDialog.isVisible().catch(() => false)) {
      await appRecoveryDialog.getByRole("button", { name: "稍后处理" }).click();
      await appRecoveryDialog.waitFor({ state: "hidden" });
    }
    await page.waitForTimeout(500);
  }
  await recoveryDialog.waitFor({ state: "visible", timeout: 10_000 });
  await recoveryDialog.getByRole("button", { name: "恢复到当前页" }).waitFor({ state: "visible" });
  report.pageAudits.push(await auditPage(page, "workspace-local-recovery"));
  await page.screenshot({ path: resolve(outputRoot, "02d-workspace-local-recovery.png"), fullPage: true });
  await recoveryDialog.getByRole("button", { name: "恢复到当前页" }).click();
  await recoveryDialog.waitFor({ state: "hidden" });
  if (await appRecoveryDialog.isVisible().catch(() => false)) {
    await appRecoveryDialog.getByRole("button", { name: "稍后处理" }).click();
    await appRecoveryDialog.waitFor({ state: "hidden" });
  }
  await showFlatSceneObjects(page);
  await page.locator(".scene-object-row").filter({ hasText: "设备 001" }).first().waitFor({ state: "visible" });
  if (await page.getByLabel("自动保存").isChecked()) throw new Error("恢复本地副本后未暂停自动保存");

  const generatedWorkspaceResponse = page.waitForResponse((response) => response.url().endsWith("/workspace") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存项目" }).click();
  const generatedWorkspace = await readJsonResponse(generatedWorkspaceResponse, 200);
  const generatedPersistence = { primitives: generatedWorkspace.scene?.primitives?.length ?? 0, annotations: generatedWorkspace.scene?.annotations?.length ?? 0 };
  if (generatedPersistence.primitives < 12 || generatedPersistence.annotations < 12) {
    throw new Error(`批量设备与标签未保存：${JSON.stringify(generatedPersistence)}`);
  }
  injectingWorkspaceFailure = true;
  try {
    await verifyOfflineWorkspaceRecovery({ page, report, identity: recoveryIdentity });
  } finally {
    injectingWorkspaceFailure = false;
  }
  // 三维编辑与二维/拓扑保持一致：删除、撤销、重做都通过显式历史按钮完成。
  const firstDeviceRow = page.locator(".scene-object-row").filter({ hasText: "设备 001" }).filter({ hasText: "基础元素" }).first();
  const objectCountBeforeDelete = await page.locator(".scene-object-row").filter({ hasText: "基础元素" }).count();
  const labelCountBeforeDelete = await page.locator(".scene-object-row .annotation-badge").count();
  // 对象计数断言统一走带诊断的等待:超时即抛出实际计数/历史按钮态/提示条文本,
  // 让"真竞态"与"页面变慢"可归因;断言本身不放宽。
  const expectSceneObjectCounts = async (label, objects, labels) => {
    try {
      await page.waitForFunction(({ objects, labels }) => {
        const currentObjects = [...document.querySelectorAll(".scene-object-row")].filter((element) => element.textContent?.includes("基础元素")).length;
        return currentObjects === objects && document.querySelectorAll(".scene-object-row .annotation-badge").length === labels;
      }, { objects, labels }, { timeout: 30_000 });
    } catch {
      const observed = await page.evaluate(() => ({
        objects: [...document.querySelectorAll(".scene-object-row")].filter((element) => element.textContent?.includes("基础元素")).length,
        labels: document.querySelectorAll(".scene-object-row .annotation-badge").length,
        historyButtons: [...document.querySelectorAll(".scene-history-controls button")].map((button) => ({ disabled: button.disabled, title: button.getAttribute("title") })),
        message: [...document.querySelectorAll(".toast")].map((toast) => toast.textContent?.trim()).filter(Boolean),
      }));
      throw new Error(`${label} 未在 30 秒内达成：期望 基础元素=${objects}/标签=${labels}，实际 ${JSON.stringify({ ...observed, sceneHistory: sceneHistoryDebugRing.slice(-14) })}`);
    }
  };
  // 行级操作已收纳进行内"更多操作"菜单;先展开再删。
  await firstDeviceRow.locator(".scene-row-menu > summary").click();
  // 菜单弹层带外侧 dismiss,Playwright 悬停预检会触发关闭;force 跳过可动性检查直点。
  await firstDeviceRow.getByTitle("删除基础元素").click({ force: true });
  await expectSceneObjectCounts("删除设备 001", objectCountBeforeDelete - 1, labelCountBeforeDelete - 1);
  const undoSceneButton = page.locator(".scene-history-controls button").nth(0);
  const redoSceneButton = page.locator(".scene-history-controls button").nth(1);
  await page.waitForFunction(() => !(document.querySelector(".scene-history-controls button")?.disabled));
  await undoSceneButton.click();
  await expectSceneObjectCounts("撤销删除", objectCountBeforeDelete, labelCountBeforeDelete);
  await redoSceneButton.click();
  await expectSceneObjectCounts("重做删除", objectCountBeforeDelete - 1, labelCountBeforeDelete - 1);
  await undoSceneButton.click();
  await expectSceneObjectCounts("二次撤销", objectCountBeforeDelete, labelCountBeforeDelete);
  report.pageAudits.push(await auditPage(page, "scene-undo-redo"));
  await page.screenshot({ path: resolve(outputRoot, "02e-scene-undo-redo.png"), fullPage: true });
  const recoveryDraftRemaining = await readBrowserRecoveryDraft(page, recoveryIdentity);
  if (recoveryDraftRemaining) throw new Error("正式保存成功后仍残留本地恢复副本");
  recordStep(report, "create-recover-save-and-undo-geojson-device-boxes-and-labels", { ...generatedDeviceAudit, persisted: generatedPersistence, undoRedo: "delete → undo → redo → undo" });

  const uploadResponse = page.waitForResponse((response) => response.url().includes(`/api/projects/${project.id}/models?`) && response.request().method() === "POST");
  await page.locator('input[type="file"][accept*=".glb"]').setInputFiles(modelFixturePath);
  const uploadedModel = await readJsonResponse(uploadResponse, 202);
  await waitForModelReady(page, project.id, uploadedModel.id);
  // 上传完成后产品会弹"选择模型处理方式"(直接插入/进入优化/取消);插入场景后才进模型树。
  const uploadChoice = page.locator('section[aria-label="选择模型处理方式"]');
  await uploadChoice.waitFor({ state: "visible", timeout: 15_000 });
  await uploadChoice.getByRole("button", { name: "直接插入" }).click();
  await uploadChoice.waitFor({ state: "hidden", timeout: 30_000 });
  // 直接插入只作用于活动会话;等模型进入场景树并显式保存后再 reload,否则插入会丢。
  await page.locator(".asset-row").filter({ hasText: "online-flow-triangle.gltf" }).first()
    .waitFor({ state: "visible", timeout: 30_000 });
  const insertSaveResponse = page.waitForResponse((response) => response.url().endsWith("/workspace") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存项目" }).click();
  await insertSaveResponse;
  await page.reload({ waitUntil: "networkidle" });
  await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor({ state: "visible", timeout: 30_000 });
  // 离线保存测试的场景恢复副本(内容服务器已有,丢弃)与行为工作区的应用级恢复副本
  // (稍后处理保留)都可能在 reload 后弹出,逐个处置后再继续。
  const staleRecovery = page.locator('section[aria-label="恢复未保存工作"]');
  if (await staleRecovery.isVisible().catch(() => false)) {
    await staleRecovery.getByRole("button", { name: "丢弃副本" }).click();
    await staleRecovery.waitFor({ state: "hidden", timeout: 15_000 });
  }
  const appRecoveryAfterReload = page.locator('section[aria-label="恢复应用修改"]');
  if (await appRecoveryAfterReload.isVisible().catch(() => false)) {
    await appRecoveryAfterReload.getByRole("button", { name: "稍后处理" }).click();
    await appRecoveryAfterReload.waitFor({ state: "hidden", timeout: 15_000 });
  }
  await showFlatSceneObjects(page);
  const modelRow = page.locator(".asset-row").filter({ hasText: "online-flow-triangle.gltf" });
  await modelRow.waitFor({ state: "visible" });
  await modelRow.locator(".asset-main").click();
  await modelRow.locator(".mini-button").first().waitFor({ state: "visible", timeout: 30_000 });
  const workspaceResponse = page.waitForResponse((response) => response.url().endsWith("/workspace") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存项目" }).click();
  const workspace = await readJsonResponse(workspaceResponse, 200);
  if (!workspace.scene?.models?.some((model) => model.modelId === uploadedModel.id)) throw new Error("保存后的场景未引用已加载模型");
  const persistedGeneratedContent = { primitives: workspace.scene?.primitives?.length ?? 0, annotations: workspace.scene?.annotations?.length ?? 0 };
  if (persistedGeneratedContent.primitives < 12 || persistedGeneratedContent.annotations < 12) throw new Error(`保存后的场景未完整保留批量设备与标签：${JSON.stringify(persistedGeneratedContent)}`);
  // 用上一版本应用再次保存，必须返回 409 且不能覆盖刚保存的工作区。
  const staleSaveToken = await page.evaluate(() => localStorage.getItem("bim-studio-auth-token") ?? sessionStorage.getItem("bim-studio-auth-token"));
  if (!staleSaveToken) throw new Error("保存冲突检查缺少访问令牌");
  const staleSaveResponse = await fetch(`${apiOrigin}/api/projects/${encodeURIComponent(project.id)}/applications/${encodeURIComponent(application.metadata.id)}/workspace`, {
    method: "PUT",
    headers: { authorization: `Bearer ${staleSaveToken}`, "content-type": "application/json" },
    body: JSON.stringify({ application: generatedWorkspace.application, scene: workspace.scene })
  });
  const staleSaveBody = await staleSaveResponse.json();
  report.faultChecks.push({ id: "reject-stale-workspace-save", expectedStatus: 409, actualStatus: staleSaveResponse.status });
  if (staleSaveBody.currentRevision !== workspace.application?.metadata?.revision) {
    throw new Error(`保存冲突未返回当前版本：${JSON.stringify(staleSaveBody)}`);
  }
  await page.reload({ waitUntil: "networkidle" });
  await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor({ state: "visible", timeout: 30_000 });
  await showFlatSceneObjects(page);
  await page.locator(".asset-row").filter({ hasText: "online-flow-triangle.gltf" }).locator(".mini-button").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(".scene-object-row").filter({ hasText: "设备 001" }).first().waitFor({ state: "visible" });
  const modeSwitchAudit = await page.locator(".workspace-mode-switch").evaluate((element) => ({
    buttons: [...element.querySelectorAll("button")].map((button) => {
      const bounds = button.getBoundingClientRect();
      return {
        label: button.textContent?.trim(),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
        whiteSpace: getComputedStyle(button).whiteSpace,
      };
    }),
  }));
  if (modeSwitchAudit.buttons.some((button) => button.width < 48 || button.height < 24 || button.whiteSpace !== "nowrap")) {
    throw new Error(`二维／三维／脚本导航发生折行或点击区过小：${JSON.stringify(modeSwitchAudit)}`);
  }
  recordStep(report, "upload-load-save-and-restore-3d-model", uploadedModel.id);
  recordStep(report, "keep-workspace-mode-switch-readable", modeSwitchAudit);
  report.pageAudits.push(await auditPage(page, "scene-editor-model-loaded"));
  report.keyboardAudits.push(await auditKeyboardNavigation(page, "scene-editor-model-loaded"));
  await page.screenshot({ path: resolve(outputRoot, "03-scene-editor-model-loaded.png"), fullPage: true });
  await auditResponsiveWorkspace({ page, report, outputRoot, id: "03-scene-editor", scopeSelector: ".app-shell" });
  // 资源树与属性检查器应能独立收起，释放三维画布而不改变场景状态。
  // 容器是 display:contents(无盒,Playwright 视为 hidden);等 attached,子按钮有盒可点。
  await dismissRecoveryDialogs(page);
  const panelControls = page.locator(".workspace-panel-controls");
  await panelControls.waitFor({ state: "attached" });
  const canvasBeforePanels = await page.locator(".workspace").boundingBox();
  await panelControls.getByRole("button", { name: "收起场景目录" }).click();
  await panelControls.getByRole("button", { name: "收起属性检查器" }).click();
  await page.locator(".left-panel").waitFor({ state: "hidden" });
  await page.locator(".right-panel").waitFor({ state: "hidden" });
  const canvasAfterPanels = await page.locator(".workspace").boundingBox();
  if (!canvasBeforePanels || !canvasAfterPanels || canvasAfterPanels.width < canvasBeforePanels.width + 400) {
    throw new Error(`收起三维辅助面板后画布未明显扩展：${JSON.stringify({ canvasBeforePanels, canvasAfterPanels })}`);
  }
  report.pageAudits.push(await auditPage(page, "scene-canvas-maximized"));
  await page.screenshot({ path: resolve(outputRoot, "03-scene-canvas-maximized.png"), fullPage: true });
  await panelControls.getByRole("button", { name: "展开场景目录" }).click();
  await panelControls.getByRole("button", { name: "展开属性检查器" }).click();
  await page.locator(".left-panel").waitFor({ state: "visible" });
  await page.locator(".right-panel").waitFor({ state: "visible" });
  recordStep(report, "collapse-and-restore-3d-side-panels", { canvasBeforePanels, canvasAfterPanels });
  recordStep(report, "scene-move-and-animation-settings", await verifySceneMoveAndAnimation({ page, outputRoot }));

  // AI 普通问答应直接可用；打开面板不能要求用户先进入审批流。
  await page.getByTitle("AI 场景助手").click();
  const assistantPanel = page.locator(".ai-assistant-panel");
  await assistantPanel.waitFor({ state: "visible" });
  // T9:能力目录收进"可用能力"折叠行,展开才挂载(避免双请求);先展开再断言。
  await assistantPanel.locator(".ai-capability-drawer > summary").click();
  await assistantPanel.locator(".ai-capability-catalog:not(.is-loading)").waitFor({ state: "visible" });
  const assistantAudit = await assistantPanel.evaluate((element) => ({
    // 五页签已收敛为"模式下拉 + 对话/执行任务双体验页签"(信息架构简化)。
    tabCount: element.querySelectorAll('.ai-assistant-experience [role="tab"]').length,
    suggestionCount: element.querySelectorAll(".ai-platform-suggestions button").length,
    capabilityCount: Number(element.querySelector(".ai-capability-catalog > header strong")?.textContent ?? 0),
    capabilitySamples: element.querySelectorAll(".ai-capability-catalog > div > *").length,
    capabilityCatalogUnavailable: element.querySelector(".ai-capability-catalog")?.classList.contains("is-unavailable") ?? true,
    explainsPluginLoading: /插件按需装载/.test(element.textContent ?? ""),
    hasApprovalQueue: /审批人|审批中心|待审批/.test(element.textContent ?? "")
  }));
  if (assistantAudit.tabCount < 2 || assistantAudit.suggestionCount < 2 || assistantAudit.capabilityCount < 5 || assistantAudit.capabilitySamples < 4 || assistantAudit.capabilityCatalogUnavailable || !assistantAudit.explainsPluginLoading || assistantAudit.hasApprovalQueue) {
    throw new Error(`AI 助手简化交互验收失败：${JSON.stringify(assistantAudit)}`);
  }
  report.pageAudits.push(await auditPage(page, "scene-ai-assistant"));
  await page.screenshot({ path: resolve(outputRoot, "03a-ai-assistant.png"), fullPage: true });
  report.industrialAgent = await verifyIndustrialAgentBrowser({ page, assistantPanel, projectId: project.id, outputRoot });
  recordStep(report, "industrial-agent-confirmation-recovery-cancel-evidence", report.industrialAgent);
  await verifyAskDataBrowser({ page, assistantPanel, dataset: askDataDataset, report, screenshotPath: resolve(outputRoot, "03aa-ai-ask-data.png") });
  report.pageAudits.push(await auditPage(page, "scene-ai-ask-data"));
  await assistantPanel.getByRole("button", { name: "关闭 AI 助手" }).click();
  await assistantPanel.waitFor({ state: "hidden" });
  recordStep(report, "open-simple-ai-assistant", assistantAudit);

  // 低频三维工具采用任务菜单承载；验证菜单真实可达、未越界，并可用 Escape 连贯返回画布。
  await page.getByRole("button", { name: "查看与分析", exact: true }).click();
  const sceneToolMenu = page.locator("#scene-tool-menu-inspect");
  await sceneToolMenu.waitFor({ state: "visible" });
  const sceneToolMenuAudit = await sceneToolMenu.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      insideViewport: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
      actionCount: element.querySelectorAll('[role="menuitem"]').length
    };
  });
  if (!sceneToolMenuAudit.insideViewport || sceneToolMenuAudit.actionCount < 8) {
    throw new Error(`三维任务菜单验收失败：${JSON.stringify(sceneToolMenuAudit)}`);
  }
  await page.screenshot({ path: resolve(outputRoot, "03b-scene-tool-menu.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await sceneToolMenu.waitFor({ state: "hidden" });
  recordStep(report, "open-and-close-scene-task-menu", sceneToolMenuAudit);

  // 刷新后不依赖偶然残留的选中状态，先按真实用户路径显式选择模型。
  await page.locator(".asset-row").filter({ hasText: "online-flow-triangle.gltf" }).locator(".asset-main").click();
  const inspectorTabs = page.locator(".right-panel .inspector-context-tabs");
  await inspectorTabs.waitFor({ state: "visible" });
  await inspectorTabs.locator("button").nth(1).click();
  await page.locator(".right-panel .scene-data-binding-editor").waitFor({ state: "visible" });
  report.pageAudits.push(await auditPage(page, "scene-inspector-data"));
  await page.screenshot({ path: resolve(outputRoot, "03c-scene-inspector-data.png"), fullPage: true });

  await inspectorTabs.locator("button").nth(2).click();
  await page.locator(".right-panel .scene-behavior-entry").waitFor({ state: "visible" });
  await page.locator(".right-panel .interaction-editor").waitFor({ state: "visible" });
  report.pageAudits.push(await auditPage(page, "scene-inspector-behavior"));
  await page.screenshot({ path: resolve(outputRoot, "03d-scene-inspector-behavior.png"), fullPage: true });

  await inspectorTabs.locator("button").nth(0).click();
  await page.locator(".right-panel .remove-scene").waitFor({ state: "visible" });
  recordStep(report, "switch-scene-inspector-contexts", { views: ["overview", "data", "behavior"] });

  await page.goto(applicationPageUrl(productOrigin, project.id, application), { waitUntil: "networkidle" });
  await page.locator(".dashboard-workspace").waitFor({ state: "visible" });
  await dismissRecoveryDialogs(page);

  await page.getByRole("button", { name: "浏览", exact: true }).click();
  await page.locator(".dashboard-runtime-preview").waitFor({ state: "visible" });
  recordStep(report, "dashboard-runtime", page.url());
  report.pageAudits.push(await auditPage(page, "dashboard-runtime"));
  await page.screenshot({ path: resolve(outputRoot, "04-dashboard-runtime.png"), fullPage: true });
  await auditResponsiveWorkspace({ page, report, outputRoot, id: "04-dashboard-preview", scopeSelector: ".dashboard-runtime-preview" });

  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".dashboard-workspace").waitFor({ state: "visible" });
  recordStep(report, "reload-restores-workspace", page.url());

  await page.goto(productOrigin, { waitUntil: "networkidle" });
  await page.locator(".scene-manager-page").waitFor({ state: "visible" });
  await page.getByLabel("当前项目").selectOption(project.id);

  // AI 目录 → 运维工作台全链验收(已模块化:onlineFlowOperations.mjs)。
  await verifyAiOperationsFlow({ page, productOrigin, project, report, outputRoot });

  await verifyTopologyFlow({ page, productOrigin, projectId: project.id, report, outputRoot });

  await page.goto(productOrigin, { waitUntil: "networkidle" });
  await page.locator(".scene-manager-page").waitFor({ state: "visible" });
  await page.getByLabel("当前项目").selectOption(project.id);
  const sceneCard = page.locator(".scene-card").filter({ hasText: "产线在线验收场景" });
  await sceneCard.waitFor({ state: "visible" });
  const publication = await publishWithViewerToolbar({ page, sceneCard, apiOrigin, outputRoot, readJsonResponse });
  recordStep(report, "publish-and-read-public-scene", publication);
  report.pageAudits.push(await auditPage(page, "manager-published"));
  await page.screenshot({ path: resolve(outputRoot, "05-published-manager.png"), fullPage: true });

  const anonymousResponse = await fetch(`${apiOrigin}/api/projects`);
  report.faultChecks.push({ id: "anonymous-project-list", expectedStatus: 401, actualStatus: anonymousResponse.status });
  const accessToken = await page.evaluate(() => localStorage.getItem("bim-studio-auth-token") ?? sessionStorage.getItem("bim-studio-auth-token"));
  if (!accessToken) throw new Error("登录后未找到访问令牌");
  const invalidUploadBody = new FormData();
  invalidUploadBody.append("file", new Blob(["not-a-model"], { type: "application/octet-stream" }), "blocked.exe");
  const invalidUploadResponse = await fetch(`${apiOrigin}/api/projects/${encodeURIComponent(project.id)}/models`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
    body: invalidUploadBody
  });
  const invalidUploadStatus = invalidUploadResponse.status;
  report.faultChecks.push({ id: "reject-unsupported-model", expectedStatus: 415, actualStatus: invalidUploadStatus });

  const failures = finalizeOnlineFlowReport(report);
  writeFileSync(resolve(outputRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (failures.length > 0) throw new Error(`在线流程浏览器门禁失败：\n- ${failures.join("\n- ")}`);
  console.log(`[online-flow] 通过：登录 → 项目 → 2D → 模型上传/三维加载/保存恢复 → 浏览 → 发布 → 公开读取；报告 ${resolve(outputRoot, "report.json")}`);
} catch (reason) {
  // 失败现场证据:Deep 激活后页面变慢,超时类失败必须留下 URL/可见文本/截图才能归因,
  // 与 gate-asset-material-flow 的 catch 同族。
  if (page && !page.isClosed()) {
    report.failureUrl = page.url();
    report.failureVisibleText = (await page.locator("body").innerText().catch(() => "")).slice(0, 4_000);
    await page.screenshot({ path: resolve(outputRoot, "failure.png"), fullPage: true }).catch(() => undefined);
  }
  report.apiLogs = apiLogs.slice(-80);
  report.failure = reason instanceof Error ? reason.message : String(reason);
  writeFileSync(resolve(outputRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  throw reason;
} finally {
  await browser?.close();
  await closeUnityRuntime?.();
  api.kill();
  await new Promise((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
  rmSync(dataRoot, { recursive: true, force: true });
}
