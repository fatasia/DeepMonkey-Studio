import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { createProductServer } from "./onlineFlowProductServer.mjs";
import {
  auditPage,
  captureProcessOutput,
  readJsonResponse,
  reservePort,
  waitForHealth,
} from "./onlineFlowAuditSupport.mjs";

const { chromium } = playwright;
const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(webRoot, "../..");
const webDistRoot = resolve(webRoot, "dist");
const apiEntry = resolve(repositoryRoot, "apps/api/dist/index.js");
const outputRoot = resolve(repositoryRoot, "test-output/data-center-flow");
const dataRoot = resolve(outputRoot, "data");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (!existsSync(webDistRoot) || !existsSync(apiEntry)) throw new Error("缺少生产产物，请先执行 pnpm build");
if (!existsSync(chromePath)) throw new Error(`Chrome 不存在：${chromePath}`);

// 验收数据严格限定在 test-output，不读取或覆盖用户项目。
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });
const apiPort = await reservePort();
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const productServer = createProductServer(webDistRoot, apiOrigin);
await new Promise((ready) => productServer.listen(0, "127.0.0.1", ready));
const address = productServer.address();
if (!address || typeof address === "string") throw new Error("无法创建数据中心验收服务器");
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
    METADATA_STORE: "json",
    OBJECT_STORE: "local",
    BIM_STUDIO_E2E_EPHEMERAL: "true",
    BIM_STUDIO_ADMIN_PASSWORD: "data-center-flow-admin",
    BIM_STUDIO_SESSION_SECRET: "data-center-flow-session-secret-2026",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
captureProcessOutput(api.stdout, apiLogs);
captureProcessOutput(api.stderr, apiLogs);

let browser;
const report = {
  createdAt: new Date().toISOString(),
  productOrigin,
  steps: [],
  pageAudits: [],
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
};
try {
  await waitForHealth(`${apiOrigin}/health`, api);
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on("console", (message) => {
    if (message.type() !== "error" || message.text().includes("/asset-library")) return;
    report.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("requestfailed", (request) => report.requestFailures.push(`${request.method()} ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`));

  await page.goto(productOrigin, { waitUntil: "networkidle" });
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("data-center-flow-admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.locator(".scene-manager-page").waitFor({ state: "visible" });

  await page.locator('summary[aria-label="项目管理"]').click();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("数据中心验收项目");
  const projectResponse = page.waitForResponse((response) => response.url().endsWith("/api/projects") && response.request().method() === "POST");
  await page.getByRole("button", { name: "创建并切换" }).click();
  const project = await readJsonResponse(projectResponse, 201);
  await page.getByLabel("当前项目").selectOption(project.id);
  await page.getByRole("button", { name: "数据中心", exact: true }).click();
  await page.locator(".data-center-page").waitFor({ state: "visible" });
  report.steps.push("open-data-center");
  report.pageAudits.push(await auditPage(page, "data-center-empty"));
  await page.screenshot({ path: resolve(outputRoot, "01-empty-data-center.png"), fullPage: true });

  const connectionPane = page.locator(".data-center-pane").first();
  await connectionPane.getByRole("button", { name: "新建", exact: true }).click();
  const connectionForm = connectionPane.locator(".data-inline-form");
  await connectionForm.getByLabel("名称").fill("产线模拟数据");
  await connectionForm.getByLabel("类型").selectOption("simulation");
  if (await connectionForm.locator(".data-form-advanced").evaluate((node) => node.hasAttribute("open"))) {
    throw new Error("高级连接策略不应默认展开");
  }
  await connectionForm.getByRole("button", { name: "保存连接" }).click();
  await connectionPane.getByRole("button", { name: /^产线模拟数据/ }).waitFor();
  report.steps.push("create-simulation-connection");

  await connectionPane.getByTitle("测试连接").click();
  await page.getByRole("status").getByText(/连接正常/).waitFor();
  if (await page.locator(".data-center-error").count()) throw new Error("连接成功被错误显示为失败状态");
  report.steps.push("test-connection-success");

  const datasetPane = page.locator(".data-center-pane").nth(1);
  await datasetPane.getByRole("button", { name: "新建", exact: true }).click();
  const datasetForm = datasetPane.locator(".data-inline-form");
  await datasetForm.getByLabel("名称").fill("产线遥测数据");
  await datasetForm.getByRole("button", { name: "保存数据集" }).click();
  await datasetPane.getByText("产线遥测数据", { exact: true }).waitFor();
  await datasetPane.getByRole("button", { name: /产线遥测数据/ }).click();
  await page.getByText("字段已同步", { exact: true }).waitFor();
  report.steps.push("create-and-preview-dataset");
  report.pageAudits.push(await auditPage(page, "data-center-preview"));
  await page.screenshot({ path: resolve(outputRoot, "02-dataset-preview.png"), fullPage: true });

  await page.getByRole("button", { name: /处理逻辑/ }).click();
  await page.locator(".pipeline-studio").waitFor();
  await page.locator(".pipeline-blank").getByRole("button", { name: "创建流水线" }).click();
  await page.locator(".pipeline-toolbar").waitFor();
  await page.locator(".pipeline-palette").getByRole("button", { name: "限量", exact: true }).click();
  await page.locator(".pipeline-actions").getByRole("button", { name: "运行", exact: true }).click();
  await page.getByText(/运行成功/).waitFor();
  report.steps.push("build-and-run-pipeline");
  report.pageAudits.push(await auditPage(page, "data-pipeline"));
  await page.screenshot({ path: resolve(outputRoot, "03-pipeline-success.png"), fullPage: true });

  await page.locator(".pipeline-actions").getByRole("button", { name: "发布接口", exact: true }).click();
  await page.locator(".endpoint-studio").waitFor();
  await page.locator(".endpoint-toolbar").getByRole("button", { name: "保存", exact: true }).click();
  await page.locator(".endpoint-toolbar").getByRole("button", { name: "测试", exact: true }).click();
  await page.locator(".endpoint-runtime").getByText("测试通过", { exact: true }).waitFor();
  report.steps.push("publish-and-test-endpoint");
  report.pageAudits.push(await auditPage(page, "data-endpoint"));
  await page.screenshot({ path: resolve(outputRoot, "04-endpoint-success.png"), fullPage: true });

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: resolve(outputRoot, "05-endpoint-1024x768.png"), fullPage: true });
  report.pageAudits.push(await auditPage(page, "data-endpoint-1024"));
  report.responsiveProof = await page.evaluate(() => {
    const content = document.querySelector(".endpoint-content");
    const save = [...document.querySelectorAll(".endpoint-toolbar button")].find((button) => button.textContent?.includes("保存"));
    const saveBounds = save?.getBoundingClientRect();
    return {
      endpointContentOverflow: content ? content.scrollWidth > content.clientWidth + 1 : true,
      endpointVerticalAccess: Boolean(content && (content.scrollHeight <= content.clientHeight + 1 || ["auto", "scroll"].includes(getComputedStyle(content).overflowY))),
      saveVisible: Boolean(saveBounds && saveBounds.left >= 0 && saveBounds.right <= innerWidth && saveBounds.top >= 0),
    };
  });
  const runtimeResult = page.locator(".endpoint-test-result.success");
  await runtimeResult.waitFor();
  await runtimeResult.scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  const runtimeVisible = await runtimeResult.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= innerHeight;
  });
  report.responsiveProof.runtimeVisibleAfterScroll = runtimeVisible;
  report.responsiveProof.verticalDimensions = await page.locator(".endpoint-content").evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  await page.screenshot({ path: resolve(outputRoot, "06-endpoint-1024-runtime.png"), fullPage: true });
  if (report.consoleErrors.length || report.pageErrors.length || report.requestFailures.length) {
    throw new Error(`浏览器运行错误：${JSON.stringify({
      consoleErrors: report.consoleErrors,
      pageErrors: report.pageErrors,
      requestFailures: report.requestFailures,
    })}`);
  }
  if (report.pageAudits.some((audit) => audit.documentOverflow || audit.smallText.length || audit.smallTargets.length || audit.topbarIssues.length)) {
    throw new Error(`数据中心页面审计失败：${JSON.stringify(report.pageAudits)}`);
  }
  if (report.responsiveProof.endpointContentOverflow || !report.responsiveProof.endpointVerticalAccess || !report.responsiveProof.saveVisible || !runtimeVisible) {
    throw new Error(`数据中心响应式布局失败：${JSON.stringify(report.responsiveProof)}`);
  }
  writeFileSync(resolve(outputRoot, "report.json"), JSON.stringify(report, null, 2));
  console.log(`[data-center-flow] 通过：${report.steps.join(" -> ")}`);
} catch (error) {
  writeFileSync(resolve(outputRoot, "report.json"), JSON.stringify({ ...report, apiLogs }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await new Promise((done) => productServer.close(done));
  api.kill();
}
