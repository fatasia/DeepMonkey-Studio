// 真实渲染封面 + 示例数据端到端取证(非正式门禁):登录 → 编辑器模板库渐进渲染 →
// 12 跨域封面特写 → 插入 3 模板验证画布示例数据 → 管理端资源页双主题 → 清理临时项目。
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const apiOrigin = process.argv[3] ?? "http://127.0.0.1:4100";
const output = resolve(fileURLToPath(new URL("../test-output/cover-real", import.meta.url)));
await mkdir(output, { recursive: true });

const metrics = { origin, consoleErrors: [], pageErrors: [], failedRequests: [], coverTimings: {}, insertedTemplates: [], riskMapStaysSvg: null, insertEvidence: null };
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
let project = null;

// ---- 会话与取证基建 ----------------------------------------------------------------
const login = await fetch(`${apiOrigin}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }),
}).then((response) => response.json());
const auth = { authorization: `Bearer ${login.token}` };

function watchConsole(page, phase) {
  page.on("console", (message) => { if (message.type() === "error") metrics.consoleErrors.push(`[${phase}] ${message.text()}`); });
  page.on("pageerror", (error) => metrics.pageErrors.push(`[${phase}] ${error.message}`));
  page.on("response", async (response) => {
    const url = response.url();
    if (response.status() >= 400 && !url.includes("/data/ws")) {
      let body = "";
      try { body = (await response.text()).slice(0, 200); } catch { body = "<unreadable>"; }
      metrics.failedRequests.push(`[${phase}] ${response.request().method()} ${response.status()} ${url} :: ${body}`);
    }
  });
}

async function loginPage(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(origin, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    // 已登录会话会被重定向到上次工作区路由(不一定是 /manager),后续步骤自带目标等待
    const formVisible = await page.getByLabel("用户名").isVisible({ timeout: 8000 }).catch(() => false);
    if (!formVisible) {
      const leftLogin = await page.waitForFunction(() => location.pathname !== "/", undefined, { timeout: 20000 }).then(() => true).catch(() => false);
      if (leftLogin) return;
      await page.reload().catch(() => undefined);
      continue;
    }
    await page.getByLabel("用户名").fill("admin");
    await page.getByLabel("密码").fill("admin");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator(".scene-manager-page").waitFor({ timeout: 20000 });
    return;
  }
  throw new Error("登录失败:既无登录表单也无已登录页面");
}

// 用滚轮遍历触发 IntersectionObserver(不依赖具体滚动容器实现)。
async function scrollThrough(page) {
  await page.locator(".template-layout-preview").first().hover();
  for (let step = 0; step < 24; step++) { await page.mouse.wheel(0, 500); await page.waitForTimeout(70); }
  for (let step = 0; step < 24; step++) { await page.mouse.wheel(0, -500); await page.waitForTimeout(40); }
}

// 渐进渲染取证:封面 <img> 数量 0(SVG 先行)→ 部分 → 稳定;`drain` 为真时等队列全量排空。
async function captureProgressive(page, prefix, { drain = false } = {}) {
  await page.locator(".template-layout-preview").first().waitFor({ timeout: 30000 });
  const t0 = Date.now();
  const photoCount = () => page.locator(".dashboard-template-cover-photo").count();
  const previewCount = () => page.locator(".template-layout-preview").count();
  const stat0 = { at: 0, photos: await photoCount(), previews: await previewCount() };
  await page.screenshot({ path: resolve(output, `${prefix}-t0-svg-first.png`) });

  void scrollThrough(page).catch(() => undefined);
  let t1 = null, lastCount = -1, stableSince = 0;
  const stableMs = drain ? 25000 : 9000;
  const deadline = Date.now() + (drain ? 600000 : 120000);
  while (Date.now() < deadline) {
    const photos = await photoCount();
    if (photos > 0 && !t1) {
      t1 = { at: Date.now() - t0, photos };
      await page.screenshot({ path: resolve(output, `${prefix}-t1-partial.png`) });
    }
    if (photos === lastCount) {
      if (!stableSince) stableSince = Date.now();
      else if (Date.now() - stableSince > stableMs) break;
    } else { stableSince = 0; lastCount = photos; }
    await page.waitForTimeout(400);
  }
  const stat2 = { at: Date.now() - t0, photos: await photoCount(), previews: await previewCount() };
  await page.screenshot({ path: resolve(output, `${prefix}-t2-ready.png`) });
  const perf = await page.evaluate(() => window.__templateCoverPerf ?? []).catch(() => []);
  return { t0: stat0, t1: t1 ?? { at: -1, photos: 0 }, t2: stat2, perCoverPerf: perf };
}

async function openEditorTemplateLibrary(page) {
  if (await page.locator(".dashboard-template-library-backdrop").isVisible().catch(() => false)) return;
  await page.locator(".dashboard-left-tabs").getByRole("button", { name: "资源", exact: true }).click();
  await page.getByRole("button", { name: "模板", exact: true }).first().click();
  await page.locator(".template-layout-preview").first().waitFor({ timeout: 20000 });
}

// ---- 主流程 ----------------------------------------------------------------
try {
  const projectResponse = await fetch(`${apiOrigin}/api/projects`, {
    method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ name: "临时-封面真渲染验证" }),
  });
  project = await projectResponse.json();

  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
  watchConsole(page, "editor");
  await loginPage(page);
  await page.goto(`${origin}/manager?project=${project.id}`);
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("封面验证场景");
  const created = page.waitForResponse((response) => response.url().endsWith(`/api/projects/${project.id}/applications`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "创建并进入", exact: true }).click();
  const application = await (await created).json();
  const dashboardPageUrl = `${origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${application.pages[0].id}`;
  await page.goto(dashboardPageUrl);
  await page.locator(".dashboard-artboard").waitFor();

  await openEditorTemplateLibrary(page);
  // drain:全量排空渲染队列(约 1.5s/张 × 277),之后 12 个跨域特写即时可拍
  metrics.coverTimings.editorLibrary = await captureProgressive(page, "01-editor-library", { drain: true });

  // map 主图(risk 布局)保持 SVG 回退:含"风险处置"的卡片不应出现真渲染 img
  const riskCard = page.locator("article").filter({ has: page.locator("strong", { hasText: "风险处置" }) }).first();
  await riskCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  metrics.riskMapStaysSvg = (await riskCard.locator(".dashboard-template-cover-photo").count()) === 0;
  await riskCard.screenshot({ path: resolve(output, "04-risk-map-svg-fallback.png") });

  // 12 个跨域封面特写(均匀取样,等待各自真渲染就绪)
  const articles = page.locator(".dashboard-template-body article");
  const total = await articles.count();
  const picks = [...new Set(Array.from({ length: 12 }, (_, index) => Math.floor((index * Math.max(1, total - 1)) / 11)))];
  for (const [index, pick] of picks.entries()) {
    await articles.nth(pick).waitFor({ timeout: 20000 }).catch(() => undefined);
    const card = articles.nth(pick);
    await card.scrollIntoViewIfNeeded();
    const name = (await card.locator("strong").first().textContent())?.trim() ?? `#${pick}`;
    try { await card.locator(".dashboard-template-cover-photo").waitFor({ timeout: 25000 }); } catch { /* map 或超时:保留 SVG 现状 */ }
    await card.screenshot({ path: resolve(output, `closeup-${String(index + 1).padStart(2, "0")}.png`) }).catch(async () => {
      await articles.nth(pick).screenshot({ path: resolve(output, `closeup-${String(index + 1).padStart(2, "0")}.png`) });
    });
    metrics.insertedTemplates.push({ closeup: name, pick, hasRealCover: (await card.locator(".dashboard-template-cover-photo").count()) > 0 });
  }

  // 插入 3 个跨域模板,验证画布带示例数据渲染
  const canvas = page.locator(".dashboard-artboard");
  for (const nameText of ["经营驾驶舱 · 经营总览", "生产运行监控 · 经营总览", "能源效率分析 · 经营总览"]) {
    await openEditorTemplateLibrary(page);
    const card = page.locator("article").filter({ has: page.locator("strong", { hasText: nameText }) }).first();
    await card.scrollIntoViewIfNeeded();
    await card.getByRole("button", { name: "插入当前页面", exact: true }).click();
    await page.locator(".dashboard-template-library-backdrop").waitFor({ state: "detached", timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
    metrics.insertedTemplates.push({ inserted: nameText });
  }
  const nodeCount = await canvas.locator(".dashboard-node").count();
  const valueTexts = await canvas.locator(".dashboard-value strong").allTextContents();
  const chartCanvasCount = await canvas.locator(".dashboard-drill-chart canvas").count();
  metrics.insertEvidence = { nodeCount, sampleValues: valueTexts.slice(0, 8), chartCanvasCount };
  await page.screenshot({ path: resolve(output, "05-insert-3-templates-canvas.png") });
  await canvas.screenshot({ path: resolve(output, "06-canvas-closeup.png") });
  await page.close();

  // 管理端资源页模板 tab(暗色)
  const managerDark = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
  watchConsole(managerDark, "manager-dark");
  await loginPage(managerDark);
  await managerDark.goto(`${origin}/manager?project=${project.id}`);
  await managerDark.getByRole("button", { name: "资源", exact: true }).click();
  await managerDark.getByRole("button", { name: /看板模板/ }).click();
  metrics.coverTimings.managerResourcesDark = await captureProgressive(managerDark, "07-manager-resources-dark");
  await managerDark.close();

  // 亮色主题(资源页 + 编辑器库)
  const light = await browser.newContext({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
  const lightPage = await light.newPage();
  watchConsole(lightPage, "manager-light");
  await loginPage(lightPage);
  await lightPage.goto(`${origin}/manager?project=${project.id}&theme=light`);
  await lightPage.getByRole("button", { name: "资源", exact: true }).click();
  await lightPage.getByRole("button", { name: /看板模板/ }).click();
  await lightPage.locator(".template-layout-preview").first().waitFor();
  await scrollThrough(lightPage);
  await lightPage.waitForTimeout(15000);
  await lightPage.screenshot({ path: resolve(output, "08-manager-resources-light.png") });
  const lightStats = { photos: await lightPage.locator(".dashboard-template-cover-photo").count(), previews: await lightPage.locator(".template-layout-preview").count() };
  metrics.coverTimings.managerResourcesLight = lightStats;
  await lightPage.close();

  const lightEditor = await light.newPage();
  watchConsole(lightEditor, "editor-light");
  await loginPage(lightEditor);
  await lightEditor.goto(`${dashboardPageUrl}&theme=light`);
  await lightEditor.locator(".dashboard-artboard").waitFor();
  await openEditorTemplateLibrary(lightEditor);
  await scrollThrough(lightEditor);
  await lightEditor.waitForTimeout(15000);
  await lightEditor.screenshot({ path: resolve(output, "09-editor-library-light.png") });
  metrics.coverTimings.editorLibraryLight = { photos: await lightEditor.locator(".dashboard-template-cover-photo").count(), previews: await lightEditor.locator(".template-layout-preview").count() };
  await lightEditor.close();
  await light.close();
} finally {
  await writeFile(resolve(output, "metrics.json"), JSON.stringify(metrics, null, 2), "utf8");
  await browser.close();
  if (project?.id) await fetch(`${apiOrigin}/api/projects/${project.id}`, { method: "DELETE", headers: auth }).catch(() => undefined);
}
console.log(JSON.stringify(metrics, null, 2));
