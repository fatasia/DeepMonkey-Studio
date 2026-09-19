import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { buildVisualQaArtifact, createStaticServer } from "./productBrowserSupport.mjs";
import { compareImageFiles } from "./renderImageSimilarity.mjs";

// P1 模型版本对比评审·真实浏览器证据脚本。
// 流程：视觉验收构建 → 打开 ?__visualQa=model-diff → 真实点击面板
// （捕获快照 ×2 → 选择 before/after → 运行对比 → 三色高亮 → 构件定位），
// 留存截图、DOM 断言与高亮前后画布差异统计。

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(webRoot, "../..");
const outputRoot = resolve(repositoryRoot, "test-output/p1-diff-review-20260919-r1");
const distRoot = resolve(outputRoot, "dist");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!existsSync(chromePath)) throw new Error(`Chrome 不存在：${chromePath}`);
mkdirSync(outputRoot, { recursive: true });

const { chromium } = playwright;

buildVisualQaArtifact({ webRoot, outputRoot: distRoot });

const server = createStaticServer(distRoot);
await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const report = { createdAt: new Date().toISOString(), origin, url: `${origin}/?__visualQa=model-diff`, steps: [], assertions: {}, screenshots: [] };

function record(step, ok, detail) {
  report.steps.push({ step, ok, detail });
  console.log(`[model-diff-qa] ${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`步骤失败：${step}${detail ? `：${detail}` : ""}`);
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await page.goto(report.url);
  await page.waitForSelector('[data-qa-ready="true"]', { timeout: 120_000 });
  record("视觉验收页就绪（真实 ViewerEngine + 两份 GLB 版本加载完成）", true);

  const captureButtons = page.getByRole("button", { name: "捕获快照" });
  if (await captureButtons.count() !== 2) record("面板列出两个已加载版本实例", false, `实际 ${await captureButtons.count()} 个捕获按钮`);
  await captureButtons.nth(0).click();
  await captureButtons.nth(1).click();
  await page.waitForSelector(".model-diff-pick select", { timeout: 10_000 });
  record("两个版本实例的构件快照捕获成功", true);

  const selects = page.locator(".model-diff-pick select");
  await selects.nth(0).selectOption({ index: 1 });
  await selects.nth(1).selectOption({ index: 2 });
  await page.screenshot({ path: resolve(outputRoot, "step-2-snapshots-selected.png"), fullPage: false });
  report.screenshots.push("step-2-snapshots-selected.png");

  await page.getByRole("button", { name: /运行对比/ }).click();
  await page.waitForSelector(".model-diff-summary", { timeout: 10_000 });
  const summaryText = await page.locator(".model-diff-summary").innerText();
  for (const expected of ["新增 1", "删除 1", "修改 1", "未变化 2", "属性 1"]) {
    if (!summaryText.includes(expected)) record(`变更汇总包含「${expected}」`, false, summaryText.replace(/\s+/g, " "));
  }
  record("diff 汇总与夹具预期一致（新增 1 / 删除 1 / 修改 1 / 属性级变更）", true, summaryText.replace(/\s+/g, " "));
  await page.screenshot({ path: resolve(outputRoot, "step-3-diff-result.png"), fullPage: false });
  report.screenshots.push("step-3-diff-result.png");

  const canvasShot = resolve(outputRoot, "step-4-canvas-before-highlight.png");
  const canvasRegion = { x: 0, y: 0, width: 840, height: 900 };
  await page.screenshot({ path: canvasShot, clip: canvasRegion });

  await page.getByRole("button", { name: /三色高亮/ }).click();
  await page.waitForSelector(".model-diff-highlight-toggle.on", { timeout: 10_000 });
  await page.waitForTimeout(700);
  record("三色高亮已应用（按钮进入 on 状态）", true);
  await page.screenshot({ path: resolve(outputRoot, "step-5-highlight-scene.png"), fullPage: false });
  report.screenshots.push("step-5-highlight-scene.png");
  const afterShot = resolve(outputRoot, "step-5-canvas-after-highlight.png");
  await page.screenshot({ path: afterShot, clip: canvasRegion });
  report.highlightCanvasChange = await compareImageFiles(canvasShot, afterShot, "before-highlight", "after-highlight");
  record(
    "高亮前后画布发生可见变化",
    report.highlightCanvasChange.changedPixelRatio > 0,
    `changedPixelRatio=${(report.highlightCanvasChange.changedPixelRatio * 100).toFixed(2)}% meanAbsoluteError=${report.highlightCanvasChange.meanAbsoluteError?.toFixed(5)}`,
  );

  await page.locator(".model-diff-list li button", { hasText: "定位" }).first().click();
  await page.waitForTimeout(900);
  const metrics = await page.locator("[data-qa-metrics]").innerText();
  if (!metrics.includes("focusName")) record("构件定位触发相机聚焦", false, metrics);
  record("构件定位触发相机聚焦（面板「定位」→ engine.focusComponent）", true);
  await page.screenshot({ path: resolve(outputRoot, "step-6-focus-component.png"), fullPage: false });
  report.screenshots.push("step-6-focus-component.png");

  // 浅色主题复核：语义令牌在 light 下切换为深色档，三色高亮与面板必须同步可读。
  const lightPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await lightPage.goto(`${report.url}&theme=light`);
  await lightPage.waitForSelector('[data-qa-ready="true"]', { timeout: 120_000 });
  const lightCaptures = lightPage.getByRole("button", { name: "捕获快照" });
  await lightCaptures.nth(0).click();
  await lightCaptures.nth(1).click();
  const lightSelects = lightPage.locator(".model-diff-pick select");
  await lightSelects.nth(0).selectOption({ index: 1 });
  await lightSelects.nth(1).selectOption({ index: 2 });
  await lightPage.getByRole("button", { name: /运行对比/ }).click();
  await lightPage.waitForSelector(".model-diff-summary", { timeout: 10_000 });
  await lightPage.getByRole("button", { name: /三色高亮/ }).click();
  await lightPage.waitForSelector(".model-diff-highlight-toggle.on", { timeout: 10_000 });
  await lightPage.waitForTimeout(700);
  record("浅色主题下完整评审链路可用", true);
  await lightPage.screenshot({ path: resolve(outputRoot, "step-7-light-theme.png"), fullPage: false });
  report.screenshots.push("step-7-light-theme.png");
  await lightPage.close();

  report.assertions.consoleErrors = consoleErrors;
  record("浏览器控制台 0 错误", consoleErrors.length === 0, consoleErrors.join(" | ") || "0 errors");
  writeFileSync(resolve(outputRoot, "browser-evidence.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[model-diff-qa] 通过：证据目录 ${outputRoot}`);
} finally {
  await browser.close();
  await new Promise((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
}
