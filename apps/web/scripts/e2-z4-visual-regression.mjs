/**
 * E2/Z4 全页面关键路径两轮深色 1280×1080 视觉回归(只修实际视觉回归,不重设计)。
 *
 * 用法:node apps/web/scripts/e2-z4-visual-regression.mjs <round>   (round = 1|2)
 * 产物:test-output/e2-z4-20261003/round<N>/*.png + report.json
 *
 * 页面清单(21):login / manager×4 tab / 新建场景对话框 / dashboard / studio /
 * AI 助手面板 / topology / optimizer / parametric / data / vision / operations /
 * system(users+cloud-render) / branding / docs / view 浏览 / published 已发布浏览。
 *
 * 每页断言:无未分类 console error/pageerror;核心交互元素在场;
 * 深色令牌生效(data-theme 非 light、页面底色非纯黑、manager 底色=--bg-0);
 * 主文本对比度 ≥4.5、全文 ≥3.0 硬地板;无横向溢出;1280 宽下导航按钮全部在视口内且可命中。
 *
 * 基建复用:isolatedStudioGate(独立端口/数据目录/OBJECT_STORE=local,不触碰用户数据)+
 * browserTextContrast(只读 DOM 对比度探针)。禁 cargo;不 commit/push。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";

const round = Number(process.argv[2] ?? "1");
assert.ok(round === 1 || round === 2, "用法:node e2-z4-visual-regression.mjs <1|2>");
const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const outputRoot = resolve(repositoryRoot, `test-output/e2-z4-20261003/round${round}`);
await mkdir(outputRoot, { recursive: true });

const report = { round, viewport: { width: 1280, height: 1080 }, theme: "dark", startedAt: new Date().toISOString(), pages: [], summary: {} };
const BG_0 = "rgb(11, 17, 20)"; // --bg-0 深色默认;纯黑裸背景是对标红线

/** 已知良性 console error 白名单——每条必须有理由,不许为过门静默放宽。 */
const knownConsoleClassifications = [
  // modelSceneApi.loadProbeGridBake 注释:「未命中(404=无)由调用方降级处理」——文档化设计语义。
  { match: /probe-bake/, reason: "探针烘焙缓存未命中:404=无,由调用方降级处理(modelSceneApi 文档化设计语义)" },
];

const round2 = (value) => Math.round(value * 100) / 100;

async function main() {
  const gate = await createIsolatedStudioGate("e2-z4-visual");
  try {
    await runRound(gate);
  } finally {
    await gate.close().catch(() => undefined);
  }
}

async function runRound(gate) {
  const context = await gate.browser.newContext({ viewport: report.viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  const consoleErrors = [];
  const pageErrors = [];
  let consoleCursor = 0;
  let pageErrorCursor = 0;
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location()?.url ?? "";
      consoleErrors.push({ text: message.text().slice(0, 400), url: location.slice(0, 300) });
    }
  });
  page.on("pageerror", (error) => pageErrors.push(String(error?.message ?? error).slice(0, 400)));

  const shot = async (name) => {
    const file = resolve(outputRoot, `${name}.png`);
    await page.screenshot({ path: file });
    const bytes = await readFile(file);
    return { path: `test-output/e2-z4-20261003/round${round}/${name}.png`, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  };
  const settle = async (ms = 400) => {
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await page.waitForTimeout(ms);
  };
  const navButton = (name) => page.getByRole("button", { name, exact: true });
  /** 回到项目工作台:优先真实「返回场景管理」入口,失败按真实 URL 兜底(两者都是用户可达路径)。 */
  const backToManager = async () => {
    const back = page.getByRole("button", { name: "返回场景管理", exact: true });
    if (await back.count()) {
      const clicked = await back.first().click({ timeout: 5000 }).then(() => true).catch(() => false);
      if (clicked) {
        const appeared = await page.locator(".scene-manager-page").waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
        if (appeared) return;
      }
    }
    await page.goto(`${gate.origin}/manager?project=${encodeURIComponent(gate.projectId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".scene-manager-page").waitFor();
  };

  /** 每页统一断言包:主题/底色/溢出/核心元素/对比度/console 卫生,失败不断轮。 */
  const audit = async (id, { shell, expect = [], exactBg } = {}) => {
    const entry = { id, screenshot: null, checks: {}, consoleErrors: [], pageErrors: [], ok: true };
    try {
      await settle();
      const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
      assert.notEqual(theme, "light", "主题必须是深色(默认),不得回退浅色");
      entry.checks.theme = theme ?? "dark(default)";
      const shellBg = shell
        ? await page.locator(shell).evaluate((node) => getComputedStyle(node).backgroundColor)
        : await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.notEqual(shellBg, "rgb(0, 0, 0)", "页面底色不得为纯黑裸背景(对标行业可视化基线的空气感红线)");
      entry.checks.shellBackground = shellBg;
      if (exactBg) assert.equal(shellBg, exactBg, `底色必须等于设计令牌 ${exactBg}`);
      const scroll = await page.evaluate(() => ({ inner: window.innerWidth, doc: document.documentElement.scrollWidth }));
      assert.ok(scroll.doc <= scroll.inner + 1, `横向溢出:doc ${scroll.doc} > viewport ${scroll.inner}`);
      entry.checks.noHorizontalOverflow = scroll;
      for (const [label, locator] of expect) {
        await locator.waitFor({ state: "visible", timeout: 15_000 });
        entry.checks[label] = true;
      }
      const root = page.locator(shell ?? "body");
      // 对比度只测「真实绘制的文本」:空文本节点(图标位/状态点)的 color 不参与绘制;
      // 全透明文本(color alpha=0,如 ECharts 隐藏测量节点)同样不可见。纳入会产出假阳性。
      const primaryAll = await root.evaluate(collectTextContrast, "button:not([disabled]), a[href], strong, th, label");
      const primary = primaryAll.filter((node) => node.text && node.color !== "rgba(0, 0, 0, 0)");
      const allAll = await root.evaluate(collectTextContrast, "small, span, p, h1, h2, h3, td, summary, input, code");
      const all = allAll.filter((node) => node.text && node.color !== "rgba(0, 0, 0, 0)");
      const primaryMin = Math.min(...primary.map((node) => node.contrast), Infinity);
      const allMin = Math.min(...all.map((node) => node.contrast), Infinity);
      entry.checks.contrast = { primaryMin: Number.isFinite(primaryMin) ? round2(primaryMin) : null, allMin: Number.isFinite(allMin) ? round2(allMin) : null, primarySamples: primary.length, allSamples: all.length, skippedUnpainted: primaryAll.length - primary.length + allAll.length - all.length };
      if (Number.isFinite(primaryMin) && primaryMin < 4.5) throw new Error(`主文本对比度不足 4.5(最低 ${round2(primaryMin)}):${JSON.stringify(primary.filter((node) => node.contrast < 4.5).slice(0, 3))}`);
      if (Number.isFinite(allMin) && allMin < 3.0) throw new Error(`存在不可读文本(对比度 <3.0):${JSON.stringify(all.filter((node) => node.contrast < 3).slice(0, 3))}`);
      entry.consoleErrors = consoleErrors.slice(consoleCursor).map((item) => {
        const known = knownConsoleClassifications.find((rule) => rule.match.test(`${item.text}\n${item.url}`));
        return known ? { ...item, classified: known.reason } : { ...item, classified: null };
      });
      entry.pageErrors = pageErrors.slice(pageErrorCursor);
      consoleCursor = consoleErrors.length;
      pageErrorCursor = pageErrors.length;
      const unclassified = entry.consoleErrors.filter((item) => !item.classified);
      if (unclassified.length) throw new Error(`未分类 console error:${JSON.stringify(unclassified.slice(0, 3))}`);
      if (entry.pageErrors.length) throw new Error(`页面异常:${JSON.stringify(entry.pageErrors.slice(0, 3))}`);
      entry.screenshot = await shot(id);
      entry.ok = true;
      console.log(`  ✓ ${id}`);
    } catch (error) {
      entry.ok = false;
      entry.error = String(error?.message ?? error).slice(0, 800);
      entry.screenshot = await shot(`${id}-FAILED`).catch(() => null);
      consoleCursor = consoleErrors.length;
      pageErrorCursor = pageErrors.length;
      console.log(`  ✗ ${id} — ${entry.error}`);
    }
    report.pages.push(entry);
    return entry.ok;
  };

  /* ---------------- 场景准备:项目先经 API 建好,其余全程走真实 UI ---------------- */
  const project = await gate.json("POST", "/api/projects", { name: `E2-Z4 视觉回归-轮${round}` });
  gate.projectId = project.id;

  // 01 登录页
  await page.goto(gate.origin);
  const ok = await audit("01-login", {
    expect: [["username", page.getByLabel("用户名", { exact: true })], ["password", page.getByLabel("密码", { exact: true })], ["login", navButton("登录")]],
  });
  if (!ok) return finish();
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("isolated-field-flow-admin");
  await navButton("登录").click();
  await page.locator(".scene-manager-page").waitFor();
  await page.getByLabel("当前项目").selectOption(project.id);
  await settle(600);

  // 02-05 manager 四个 tab
  await audit("02-manager-scenes", {
    shell: ".scene-manager-page", exactBg: BG_0,
    expect: [["search", page.locator('input[aria-label="搜索场景"]')], ["newScene", navButton("新建场景")], ["tabScenes", navButton("项目场景")], ["tabExamples", navButton("示例场景")]],
  });
  // manager 布局断言:1280 宽下全部导航按钮在视口内且可命中(布局破碎/遮挡检测)。
  {
    const layout = await page.locator(".scene-manager-page").evaluate(() => {
      const visible = [...document.querySelectorAll(".manager-primary-nav button, .manager-capability-nav button, .manager-utility-nav button")].filter((node) => node.checkVisibility());
      const rects = visible.map((node) => { const r = node.getBoundingClientRect(); return { label: node.getAttribute("aria-label"), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; });
      const occluded = visible.filter((node) => {
        const r = node.getBoundingClientRect();
        const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !target || (!node.contains(target) && target !== node);
      }).map((node) => node.getAttribute("aria-label"));
      return { width: window.innerWidth, height: window.innerHeight, rects, occluded, doc: document.documentElement.scrollWidth };
    });
    const problems = layout.rects.filter((rect) => rect.left < 0 || rect.right > layout.width || rect.top < 0 || rect.bottom > layout.height);
    const entry = report.pages.at(-1);
    entry.checks.managerNavLayout = { buttons: layout.rects.length, problems, occluded: layout.occluded, docWidth: layout.doc };
    if ((problems.length || layout.occluded.length || layout.doc > layout.width + 1) && entry.ok) {
      entry.ok = false;
      entry.error = `manager 导航布局回归:${JSON.stringify({ problems, occluded: layout.occluded, docWidth: layout.doc })}`;
    }
  }
  await navButton("资源").click();
  await audit("03-manager-assets", { shell: ".scene-manager-page", exactBg: BG_0, expect: [["tabAssetsActive", page.locator(".manager-primary-nav button.active").filter({ hasText: "资源" })]] });
  await navButton("拓扑").click();
  await audit("04-manager-topology", { shell: ".scene-manager-page", exactBg: BG_0, expect: [["newTopology", navButton("新建拓扑")]] });
  await navButton("示例场景").click();
  await audit("05-manager-examples", { shell: ".scene-manager-page", exactBg: BG_0 });

  // 06 新建场景对话框 → 创建并进入
  await navButton("项目场景").click();
  await navButton("新建场景").click();
  const dialog = page.locator("form.dialog");
  await dialog.waitFor();
  await dialog.locator("input").first().fill("E2Z4 巡检总览");
  await audit("06-new-scene-dialog", { shell: ".scene-manager-page", exactBg: BG_0, expect: [["dialogTitle", dialog.getByRole("heading", { name: "新建场景" })], ["createButton", dialog.getByRole("button", { name: "创建并进入" })]] });
  const applicationResponse = page.waitForResponse((candidate) => candidate.url().includes(`/api/projects/${project.id}/applications`) && candidate.request().method() === "POST");
  await dialog.getByRole("button", { name: "创建并进入" }).click();
  const application = await applicationResponse.then((entry) => entry.json());
  const scene = application.scenes?.[0];
  assert.ok(scene?.id && application.metadata?.id, "创建场景后未返回有效应用与场景标识");
  const applicationId = application.metadata.id;
  const sceneId = scene.id;
  const studioUrl = `${gate.origin}/studio/${encodeURIComponent(project.id)}/applications/${encodeURIComponent(applicationId)}/scenes/${encodeURIComponent(sceneId)}`;

  // 07 dashboard(创建后未落在 dashboard 时,经场景卡「编辑场景」真实路径进入)
  const landedOnDashboard = await page.locator(".dashboard-workspace").waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  if (!landedOnDashboard) {
    await backToManager();
    await page.getByRole("button", { name: "编辑场景", exact: true }).first().click();
    await page.locator(".dashboard-workspace").waitFor({ timeout: 30_000 });
  }
  await audit("07-dashboard", { shell: ".dashboard-workspace", expect: [["topbar", page.locator(".dashboard-workspace-topbar")]] });

  // 08 studio 三维编辑器(深链路由,渲染稳定后再截)
  await page.goto(studioUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.locator(".viewport canvas").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2500);
  await audit("08-studio", { shell: ".app-shell", expect: [["viewport", page.locator(".viewport canvas")], ["leftPanel", page.locator(".left-panel")], ["rightPanel", page.locator(".right-panel")]] });

  // 09 AI 助手面板(manager 上层浮层)
  await page.goto(`${gate.origin}/manager?project=${encodeURIComponent(project.id)}`, { waitUntil: "domcontentloaded" });
  await page.locator(".scene-manager-page").waitFor();
  await navButton("AI 助手").click();
  await audit("09-ai-assistant", { shell: ".scene-manager-page", expect: [["assistantPanel", page.locator(".ai-assistant-panel")], ["prompt", page.getByRole("textbox", { name: "向 AI 助手提问", exact: true })]] });
  await page.getByRole("textbox", { name: "向 AI 助手提问", exact: true }).press("Escape").catch(() => undefined);
  await page.locator(".ai-assistant-panel").waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);

  // 10 拓扑编辑器(manager-topology tab 的「新建拓扑」真实入口)
  await navButton("拓扑").click();
  await navButton("新建拓扑").click();
  const topologyOk = await audit("10-topology", { shell: ".topology-editor" });
  if (topologyOk) await backToManager();
  else console.log("  ! topology 未能进入(该页本轮如实登记未验证,不阻塞全页面巡检)");

  // 11-15 能力页(各自真实导航入口 → 返回)
  for (const [id, nav, shell] of [
    ["11-optimizer", "模型优化", ".optimizer-page"],
    ["12-parametric", "参数化生成", ".parametric-page-shell"],
    ["13-data-center", "数据中心", ".data-center-page"],
    ["14-vision-center", "视觉中心", ".vision-page"],
    ["15-operations", "智能运营", ".operations-page"],
  ]) {
    await backToManager();
    await navButton(nav).click();
    if (await audit(id, { shell })) await backToManager();
  }

  // 16-17 系统设置(users 默认 tab + 云渲染 tab)
  await backToManager();
  await navButton("设置").click();
  if (await audit("16-system-users", { shell: ".system-center-page" })) {
    await page.getByRole("button", { name: "云渲染设置", exact: true }).click();
    await audit("17-system-cloud-render", { shell: ".system-center-page" });
    await backToManager();
  }

  // 18 品牌设置 / 19 使用文档
  await navButton("品牌设置").click();
  if (await audit("18-branding", { shell: ".branding-settings-page" })) await backToManager();
  await navButton("文档").click();
  if (await audit("19-docs", { shell: ".docs-center-page" })) await backToManager();

  // 20 浏览(/view/ 深链 = 预览场景)
  await page.goto(`${gate.origin}/view/${encodeURIComponent(sceneId)}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.locator("canvas").first().waitFor({ timeout: 60_000 });
  await page.getByText("正在初始化").waitFor({ state: "hidden", timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(2000);
  await audit("20-view", { expect: [["viewerCanvas", page.locator("canvas").first()]] });

  // 21 已发布浏览(卡片「发布场景」→ 发布对话框「发布」真实路径 → /published/)
  await page.goto(`${gate.origin}/manager?project=${encodeURIComponent(project.id)}`, { waitUntil: "domcontentloaded" });
  await page.locator(".scene-manager-page").waitFor();
  let published = false;
  try {
    await page.getByRole("button", { name: "发布场景", exact: true }).first().click();
    const publishDialog = page.locator("section.publication-dialog");
    await publishDialog.waitFor({ timeout: 15_000 });
    const publishResponse = page.waitForResponse((candidate) => candidate.url().endsWith("/publish") && candidate.request().method() === "POST" && candidate.status() === 201);
    await publishDialog.getByRole("button", { name: "发布", exact: true }).click();
    await publishResponse;
    published = true;
  } catch (error) {
    report.publishNote = `发布流程未完成:${String(error?.message ?? error).slice(0, 300)}`;
    console.log(`  ! publish 未完成(21-published 登记为未验证):${report.publishNote}`);
  }
  if (published) {
    await page.goto(`${gate.origin}/published/${encodeURIComponent(sceneId)}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.locator("canvas").first().waitFor({ timeout: 60_000 });
    await page.getByText("正在初始化").waitFor({ state: "hidden", timeout: 45_000 }).catch(() => undefined);
    await page.waitForTimeout(2000);
    await audit("21-published", { expect: [["publishedCanvas", page.locator("canvas").first()]] });
  }

  await context.close();
  return finish();

  function finish() {
    const passed = report.pages.filter((entry) => entry.ok).length;
    report.summary = {
      pages: report.pages.length, passed, failed: report.pages.length - passed,
      totalConsoleErrors: consoleErrors.length,
      classifiedConsoleErrors: consoleErrors.filter((item) => knownConsoleClassifications.some((rule) => rule.match.test(`${item.text}\n${item.url}`))).length,
      pageErrors: pageErrors.length, finishedAt: new Date().toISOString(),
    };
    return writeFile(resolve(outputRoot, "report.json"), JSON.stringify(report, null, 2)).then(() => {
      console.log(`\nround ${round}: ${passed}/${report.pages.length} pages PASS;console ${report.summary.classifiedConsoleErrors}/${report.summary.totalConsoleErrors} classified;pageErrors ${report.summary.pageErrors}`);
      console.log(`report: test-output/e2-z4-20261003/round${round}/report.json`);
      assert.ok(report.pages.length >= 19, "页面覆盖不足,视为未完成全页面巡检");
      assert.equal(report.summary.failed, 0, `存在未通过页面:${report.pages.filter((entry) => !entry.ok).map((entry) => entry.id).join(", ")}`);
    });
  }
}

main().catch(async (error) => {
  report.fatal = String(error?.stack ?? error).slice(0, 2000);
  await writeFile(resolve(outputRoot, "report.json"), JSON.stringify(report, null, 2)).catch(() => undefined);
  console.error(error);
  process.exit(1);
});
