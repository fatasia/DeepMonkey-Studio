// 全站 UI/UX/功能遍历(u120)。可重复执行;单步失败不中断;汇总 JSON 报告。
// 用法: node scripts/u120-ui-sweep.mjs [origin]
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "test-output", "ui-sweep-2026-09-12");
mkdirSync(outDir, { recursive: true });

const report = { origin, startedAt: new Date().toISOString(), steps: [], consoleErrors: [], httpFailures: [], notes: [] };
let currentStep = "init";
let page;
let shotIndex = 0;

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeContext(viewport) {
  const browser = await playwright.chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") report.consoleErrors.push({ step: currentStep, text: m.text().slice(0, 500) }); });
  page.on("pageerror", (e) => report.consoleErrors.push({ step: currentStep, kind: "pageerror", text: String(e?.message ?? e).slice(0, 500) }));
  page.on("response", (r) => { if (r.status() >= 400) report.httpFailures.push({ step: currentStep, status: r.status(), url: r.url().slice(0, 300) }); });
  return { browser, context, page };
}

async function shot(p, name) {
  const file = `${String(++shotIndex).padStart(2, "0")}-${name}.png`;
  await (p ?? page).screenshot({ path: join(outDir, file), fullPage: false });
  return `test-output/ui-sweep-2026-09-12/${file}`;
}

async function step(name, fn) {
  currentStep = name;
  const entry = { name, ok: false, error: null, screenshot: null, notes: [] };
  report.steps.push(entry);
  const t0 = Date.now();
  try { await fn(entry); entry.ok = true; }
  catch (e) {
    entry.error = String(e?.message ?? e).slice(0, 600);
    try { entry.screenshot = await shot(page, `FAIL-${name}`); } catch {}
  }
  entry.ms = Date.now() - t0;
  console.log(`[${entry.ok ? "OK " : "ERR"}] ${name} (${entry.ms}ms)${entry.error ? " :: " + entry.error : ""}`);
}

/** 等待登录页或管理台出现,再决定是否需要登录。 */
async function ensureLoggedIn(p, pass = "admin") {
  await p.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await p.waitForLoadState("networkidle").catch(() => {});
  const loginInput = p.locator("input[aria-label=用户名]");
  const manager = p.locator(".scene-manager-page");
  for (let i = 0; i < 40; i++) {
    if (await manager.isVisible().catch(() => false)) return "already";
    if (await loginInput.isVisible().catch(() => false)) break;
    await sleep(250);
  }
  if (!(await loginInput.isVisible().catch(() => false))) throw new Error("既不见登录页也不见管理台");
  await loginInput.fill("admin");
  await p.locator("input[aria-label=密码]").fill(pass);
  await p.getByRole("button", { name: "登录" }).click();
  await manager.waitFor({ timeout: 30000 });
  return "loggedIn";
}

async function clickIfVisible(p, selector, { waitMs = 700, note = null } = {}) {
  const loc = p.locator(selector).first();
  try {
    if (!(await loc.isVisible().catch(() => false))) { report.notes.push({ step: currentStep, note: `不可见: ${note ?? selector}` }); return false; }
    if (await loc.isDisabled().catch(() => false)) { report.notes.push({ step: currentStep, note: `禁用: ${note ?? selector}` }); return false; }
    await loc.click({ timeout: 3000 });
    await sleep(waitMs);
    return true;
  } catch (e) {
    report.notes.push({ step: currentStep, note: `点击失败 ${note ?? selector}: ${String(e?.message ?? e).slice(0, 120)}` });
    return false;
  }
}

/** Esc 后检查弹层是否关闭(返回 true=已关闭)。 */
async function escCloses(p, closeSelector) {
  await p.keyboard.press("Escape");
  await sleep(500);
  return !(await p.locator(closeSelector).first().isVisible().catch(() => false));
}

const V_MAIN = { width: 1440, height: 900 };
const V_MID = { width: 1280, height: 800 };
const V_NARROW = { width: 980, height: 800 };

/* ================= Pass A:1440x900 全功能遍历 ================= */
{
  const { browser, page: p } = await makeContext(V_MAIN);
  page = p;

  await step("01-login-page", async (s) => {
    await p.goto(origin + "/", { waitUntil: "domcontentloaded" });
    await p.locator("input[aria-label=用户名]").waitFor({ timeout: 20000 });
    await sleep(600);
    s.screenshot = await shot(p, "login-page");
    s.notes.push(`空表单登录按钮 disabled=${await p.getByRole("button", { name: "登录" }).isDisabled()}`);
  });

  await step("02-login-empty-submit", async (s) => {
    const btn = p.getByRole("button", { name: "登录" });
    if (!(await btn.isDisabled())) { await btn.click(); await sleep(500); }
    s.notes.push(`仍停留在登录页=${await p.locator("input[aria-label=用户名]").isVisible()}`);
    s.screenshot = await shot(p, "login-empty");
  });

  await step("03-login-wrong-password", async (s) => {
    await p.locator("input[aria-label=用户名]").fill("admin");
    await p.locator("input[aria-label=密码]").fill("wrong-password-001");
    const t0 = Date.now();
    await p.getByRole("button", { name: "登录" }).click();
    await p.locator("em[role=alert]").waitFor({ timeout: 15000 });
    s.notes.push(`错误提示出现耗时=${Date.now() - t0}ms,文案=${await p.locator("em[role=alert]").textContent()}`);
    await sleep(300);
    s.screenshot = await shot(p, "login-error");
  });

  await step("04-login-success", async (s) => {
    const t0 = Date.now();
    await p.locator("input[aria-label=用户名]").fill("admin");
    await p.locator("input[aria-label=密码]").fill("admin");
    await p.getByRole("button", { name: "登录" }).click();
    await p.locator(".scene-manager-page").waitFor({ timeout: 30000 });
    s.notes.push(`进入管理台耗时=${Date.now() - t0}ms`);
  });

  await step("05-manager-home", async (s) => {
    await sleep(1200);
    s.screenshot = await shot(p, "manager-home");
    s.notes.push(`场景卡片数=${await p.locator(".scene-card").count()}`);
    if (await p.locator(".scene-card").first().isVisible().catch(() => false)) {
      await p.locator(".scene-card").first().hover();
      await sleep(400);
      s.screenshot = await shot(p, "manager-card-hover");
    }
  });

  await step("06-manager-filter-sort", async (s) => {
    const status = p.locator("select[aria-label=场景状态]");
    const sort = p.locator("select[aria-label=场景排序]");
    if (!(await status.isVisible().catch(() => false))) { s.notes.push("筛选/排序不可见"); return; }
    const total = await p.locator(".scene-card").count();
    await status.selectOption("published");
    await sleep(600);
    const published = await p.locator(".scene-card").count();
    await status.selectOption("draft");
    await sleep(600);
    const draft = await p.locator(".scene-card").count();
    s.notes.push(`全部=${total} 已发布=${published} 未发布=${draft}`);
    await shot(p, "manager-filter-draft");
    await sort.selectOption("name");
    await sleep(600);
    await shot(p, "manager-sort-name");
    await status.selectOption("all");
    await sleep(400);
  });

  await step("07-manager-search", async (s) => {
    const input = p.locator("input[aria-label=搜索场景]");
    await input.fill("不存在的场景XYZ");
    await sleep(600);
    s.notes.push(`过滤后卡片=${await p.locator(".scene-card").count()}`);
    s.screenshot = await shot(p, "manager-search-empty");
    // 空态的"清除筛选"按钮是否可用
    const clear = p.getByRole("button", { name: "清除筛选" });
    if (await clear.isVisible().catch(() => false)) {
      await clear.click();
      await sleep(600);
      s.notes.push(`清除筛选后卡片=${await p.locator(".scene-card").count()}`);
    } else s.notes.push("空态无『清除筛选』按钮");
  });

  await step("08-manager-new-project-dialog", async (s) => {
    await p.locator(".manager-project-switch details summary").click();
    await sleep(400);
    await shot(p, "manager-project-menu");
    await p.getByRole("button", { name: "新建项目" }).first().click();
    await sleep(800);
    s.screenshot = await shot(p, "new-project-dialog");
    // Esc 应关闭弹窗(取消按钮存在则优先点取消,避免残留输入)
    const cancel = p.getByRole("button", { name: "取消" }).first();
    if (await cancel.isVisible().catch(() => false)) { await cancel.click(); }
    else {
      const closed = await escCloses(p, "dialog[open], [role=dialog]:visible, .modal:visible");
      s.notes.push(`Esc 关闭新建项目弹窗=${closed}`);
      await p.keyboard.press("Escape");
    }
    await sleep(400);
  });

  await step("09-manager-tab-assets", async (s) => {
    if (!(await clickIfVisible(p, '.manager-primary-nav button[aria-label="资源"]', { waitMs: 1800 }))) { s.notes.push("资源 tab 不可见/禁用"); return; }
    s.screenshot = await shot(p, "assets-default");
    for (const [label, file] of [["二维资源", "assets-2d"], ["看板模板", "assets-templates"], ["工业预制体", "assets-prefabs"]]) {
      if (await clickIfVisible(p, `button:has-text("${label}")`, { waitMs: 1000 })) await shot(p, file);
    }
    // 子筛选
    for (const sub of ["三维模型", "环境 HDR", "PBR 材质"]) {
      if (await clickIfVisible(p, `button:has-text("${sub}")`, { waitMs: 900 })) await shot(p, `assets-sub-${sub.replace(/\s+/g, "")}`);
    }
  });

  await step("10-manager-tab-topology", async (s) => {
    if (!(await clickIfVisible(p, '.manager-primary-nav button[aria-label="拓扑"]', { waitMs: 1200 }))) { s.notes.push("拓扑 tab 不可见"); return; }
    s.screenshot = await shot(p, "topology-list");
  });

  await step("11-topology-editor", async (s) => {
    const open = p.locator('button:has-text("打开编辑")').first();
    if (!(await open.isVisible().catch(() => false))) { s.notes.push("无已存拓扑,跳过编辑器"); return; }
    await open.click();
    await sleep(3500);
    s.screenshot = await shot(p, "topology-editor");
    // 点击一个节点 → 属性面板
    const node = p.locator("[class*=topology] [class*=node], svg g[class*=node]").first();
    if (await node.isVisible().catch(() => false)) {
      await node.click({ timeout: 3000 }).catch(() => {});
      await sleep(800);
      s.notes.push("点击拓扑节点 OK");
    }
    await shot(p, "topology-node-selected");
    // 缩放控件/2D-2.5D 切换
    await clickIfVisible(p, 'button:has-text("2.5D")', { waitMs: 900 });
    await shot(p, "topology-2d5d");
    await clickIfVisible(p, 'button:has-text("2D")', { waitMs: 900 });
    // 返回管理台
    await clickIfVisible(p, ".topbar-back, header button[title*=返回]", { waitMs: 1500 });
  });

  await step("12-manager-tab-examples", async (s) => {
    if (!(await clickIfVisible(p, '.manager-primary-nav button[aria-label="示例场景"]', { waitMs: 1200 }))) { s.notes.push("示例场景 tab 不可见"); return; }
    s.screenshot = await shot(p, "manager-tab-examples");
  });

  /* ---------- 打开工作区(默认二维):先测看板 ---------- */
  await step("13-workspace-open-2d", async (s) => {
    // 上一步可能停在示例场景 tab,先回到项目场景
    await p.goto(origin + "/manager?tab=scenes", { waitUntil: "domcontentloaded" });
    await sleep(1800);
    const editBtn = p.locator('.scene-card button[aria-label="编辑场景"]').first();
    if (!(await editBtn.isVisible().catch(() => false))) throw new Error("找不到编辑场景按钮");
    await editBtn.click();
    await sleep(5000);
    s.screenshot = await shot(p, "dashboard-initial");
    s.notes.push(`默认模式=二维(工作区直接落在看板)`);
  });

  await step("14-restore-layer-visibility", async (s) => {
    // 上一轮误点的图层隐藏若被持久化,这里恢复显示
    const showBtn = p.locator('button[aria-label="显示图层"]');
    if (await showBtn.first().isVisible().catch(() => false)) {
      await showBtn.first().click();
      await sleep(1500);
      s.notes.push("检测到隐藏图层,已恢复显示");
    } else s.notes.push("图层均处于显示状态");
    s.screenshot = await shot(p, "dashboard-layer-state");
  });

  await step("15-dashboard-left-tabs", async (s) => {
    await clickIfVisible(p, 'button:has-text("图层")', { waitMs: 800 });
    await shot(p, "dashboard-left-layers");
    await clickIfVisible(p, 'button:has-text("资源")', { waitMs: 800 });
    await shot(p, "dashboard-left-library");
  });

  await step("16-dashboard-library-tabs", async (s) => {
    for (const [label, file] of [["图表", "lib-chart"], ["控件", "lib-control"], ["媒体", "lib-media"], ["3D", "lib-3d"], ["资源", "lib-vector"]]) {
      const ok = await clickIfVisible(p, `.dashboard-library-tabs button:text-is("${label}")`, { waitMs: 900 });
      if (ok) await shot(p, `dashboard-${file}`);
      else await clickIfVisible(p, `[aria-label="资源分类"] button:text-is("${label}")`, { waitMs: 900 });
    }
    // 组件搜索
    const search = p.locator('.dashboard-library-search input, input[aria-label*="搜索组件"], input[placeholder*="搜索组件"]').first();
    if (await search.isVisible().catch(() => false)) {
      await search.fill("按钮");
      await sleep(800);
      s.notes.push("组件搜索『按钮』已输入");
      await shot(p, "dashboard-lib-search");
      await search.fill("");
      await sleep(500);
    }
    // (模板入口改到 16b 单独测,避免页内导航打断后续步骤)
  });

  await step("16b-dashboard-template-entry", async (s) => {
    const tpl = p.locator('.dashboard-library-template-button, button[title*="行业模板"]').first();
    if (!(await tpl.isVisible().catch(() => false))) { s.notes.push("模板入口不可见"); return; }
    await tpl.click();
    await sleep(1800);
    s.screenshot = await shot(p, "dashboard-template-jump");
    s.notes.push(`模板入口点击后 URL=${p.url().slice(0, 90)}`);
    s.notes.push(`看板模板库弹窗出现=${await p.locator(':text("看板模板库")').first().isVisible().catch(() => false)}`);
    const escClosedTpl = await escCloses(p, ':text("看板模板库")');
    s.notes.push(`模板库弹窗 Esc 关闭=${escClosedTpl}`);
    // 确定性重开工作区
    await p.goto(origin + "/manager?tab=scenes", { waitUntil: "domcontentloaded" });
    await sleep(1600);
    const editBtn = p.locator('.scene-card button[aria-label="编辑场景"]').first();
    if (await editBtn.isVisible().catch(() => false)) { await editBtn.click(); await sleep(4500); }
    // 确保处于二维模式
    if (!(await p.locator(".dashboard-page-bar").first().isVisible().catch(() => false))) {
      await clickIfVisible(p, '.workspace-mode-switch button:text-is("二维")', { waitMs: 3500 });
    }
    s.notes.push(`重开编辑器后 page-bar 可见=${await p.locator(".dashboard-page-bar").first().isVisible().catch(() => false)}`);
  });

  await step("17-dashboard-drag-component", async (s) => {
    if (!(await p.locator(".dashboard-page-bar").first().isVisible().catch(() => false))) {
      await clickIfVisible(p, '.workspace-mode-switch button:text-is("二维")', { waitMs: 3500 });
    }
    const railRes = p.locator('aside button:text-is("资源"), [class*=left-panel] button:text-is("资源")').first();
    if (!(await p.locator(".dashboard-library-browser").first().isVisible().catch(() => false))) {
      await railRes.click({ timeout: 2500 }).catch(() => {});
      await sleep(900);
    }
    await clickIfVisible(p, '.dashboard-library-tabs button:text-is("图表")', { waitMs: 800 });
    const item = p.locator('.dashboard-library-browser [draggable="true"]:has-text("经营指标卡")').first();
    const artboard = p.locator(".dashboard-artboard").first();
    if (!(await item.isVisible().catch(() => false))) { s.notes.push("找不到可拖组件(图表)"); return; }
    if (!(await artboard.isVisible().catch(() => false))) { s.notes.push("画布不可见"); return; }
    try {
      await p.dragAndDrop('.dashboard-library-browser [draggable="true"]:has-text("经营指标卡")', ".dashboard-artboard", { timeout: 8000 });
    } catch (e) { s.notes.push(`dragAndDrop 失败: ${String(e?.message ?? e).slice(0, 120)}`); }
    await sleep(1200);
    s.screenshot = await shot(p, "dashboard-after-drop");
    await p.keyboard.press("Control+z");
    await sleep(1000);
    s.notes.push("已 Ctrl+Z 撤销拖入");
    await shot(p, "dashboard-after-undo");
  });

  await step("18-dashboard-select-inspector", async (s) => {
    const artboard = p.locator(".dashboard-artboard").first();
    const box = await artboard.boundingBox().catch(() => null);
    if (box) {
      await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(1000);
    }
    s.screenshot = await shot(p, "dashboard-component-selected");
    const sections = p.locator('.dashboard-inspector-panel summary, .dashboard-inspector-panel [class*=section] > button, .dashboard-inspector-panel [class*=collapse]');
    const n = await sections.count();
    s.notes.push(`组件检查器可折叠分区数=${n}`);
    for (let i = 0; i < Math.min(n, 8); i++) {
      const t = sections.nth(i);
      if (await t.isDisabled().catch(() => false)) continue;
      await t.click().catch(() => {});
      await sleep(500);
      await shot(p, `dashboard-inspector-sec-${i + 1}`);
    }
  });

  await step("19-dashboard-data-panel", async (s) => {
    if (!(await p.locator(".dashboard-page-bar").first().isVisible().catch(() => false))) {
      await clickIfVisible(p, '.workspace-mode-switch button:text-is("二维")', { waitMs: 3500 });
    }
    const dataBtn = p.locator('.dashboard-field-panel-handle, button[title*="展开数据字段"]').first();
    if (!(await dataBtn.isVisible().catch(() => false))) { s.notes.push("数据字段面板入口不可见"); return; }
    await dataBtn.click();
    await sleep(1200);
    s.screenshot = await shot(p, "dashboard-data-panel");
    await clickIfVisible(p, 'button[aria-label*="收起字段面板"]', { waitMs: 800 });
    s.notes.push("数据字段面板已展开并收起");
  });

  await step("20-dashboard-page-bar", async (s) => {
    // 底部页面栏:新增空白页面 + 删除当前页面(自清理)
    if (!(await p.locator(".dashboard-page-bar").first().isVisible().catch(() => false))) {
      await clickIfVisible(p, '.workspace-mode-switch button:text-is("二维")', { waitMs: 3500 });
    }
    const addPage = p.locator('button[aria-label="新增空白页面"]').first();
    if (!(await addPage.isVisible().catch(() => false))) { s.notes.push("新增空白页面入口不可见"); return; }
    await addPage.click();
    await sleep(1500);
    s.notes.push("已新增空白页面");
    await shot(p, "dashboard-page-added");
    const delPage = p.locator('button[aria-label="删除当前页面"]').first();
    if (await delPage.isVisible().catch(() => false)) {
      await delPage.click();
      await sleep(800);
      const confirm = p.getByRole("button", { name: /删除|确认|确定/ }).first();
      if (await confirm.isVisible().catch(() => false)) { await confirm.click(); await sleep(1000); }
      s.notes.push("已删除测试页面");
    } else s.notes.push("删除当前页面入口不可见(留有测试页面)");
    await shot(p, "dashboard-page-deleted");
  });

  /* ---------- 三维编辑器 ---------- */
  await step("21-mode-3d", async (s) => {
    if (!(await p.locator(".dashboard-page-bar").first().isVisible().catch(() => false))) {
      throw new Error("不在看板工作区(可能被上一步导航走)");
    }
    if (!(await p.locator(".dashboard-page-bar").first().isVisible().catch(() => false))) {
      // 已在三维(重开后默认三维):切到二维再切回三维,验证切换链路
      await clickIfVisible(p, '.workspace-mode-switch button:text-is("二维")', { waitMs: 3500 });
    }
    const btn = p.locator('.workspace-mode-switch button:text-is("三维")').first();
    if (!(await btn.isVisible().catch(() => false))) throw new Error("三维模式按钮不可见");
    if (await btn.isDisabled()) throw new Error("三维按钮禁用(场景不可用?)");
    await btn.click();
    await sleep(5000);
    s.screenshot = await shot(p, "studio3d-initial");
  });

  await step("22-studio3d-tools", async (s) => {
    // 先选中一个对象,变换工具才可用
    const row = p.locator('button:has-text("设备 001")').first();
    if (await row.isVisible().catch(() => false)) { await row.click().catch(() => {}); await sleep(900); }
    for (const [label, file] of [["适应全部", "fit"], ["选择", "select"], ["移动", "move"], ["旋转", "rotate"], ["缩放", "scale"]]) {
      const ok = await clickIfVisible(p, `button[aria-label*="${label}"], button[title*="${label}"]`, { waitMs: 800 });
      if (ok) await shot(p, `studio3d-tool-${file}`);
    }
  });

  await step("23-studio3d-measure", async (s) => {
    if (!(await clickIfVisible(p, 'button[aria-label*="测量"], button[title*="测量"]', { waitMs: 1200 }))) { s.notes.push("测量工具不可见"); return; }
    await shot(p, "studio3d-measure-on");
    await clickIfVisible(p, 'button[aria-label*="测量"], button[title*="测量"]', { waitMs: 800 }); // 关闭
    s.notes.push("测量已开关一次");
  });

  await step("24-studio3d-annotation", async (s) => {
    if (!(await clickIfVisible(p, 'button[aria-label*="标注"], button[title*="标注"]', { waitMs: 1200 }))) { s.notes.push("标注工具不可见"); return; }
    await shot(p, "studio3d-annotation-on");
    await clickIfVisible(p, 'button[aria-label*="标注"], button[title*="标注"]', { waitMs: 800 });
    s.notes.push("标注已开关一次");
  });

  await step("25-studio3d-create-menu", async (s) => {
    if (!(await clickIfVisible(p, 'button[aria-label*="创建"]', { waitMs: 900 }))) { s.notes.push("创建菜单不可见"); return; }
    await shot(p, "studio3d-create-menu");
    await p.keyboard.press("Escape");
    await sleep(400);
  });

  await step("26-studio3d-view-menu", async (s) => {
    if (!(await clickIfVisible(p, 'button[aria-label*="查看与分析"], button[title*="查看与分析"]', { waitMs: 900 }))) { s.notes.push("查看与分析菜单不可见"); return; }
    await shot(p, "studio3d-view-menu");
    // 菜单展开状态下点击子项(剖切)
    if (await clickIfVisible(p, '[role=menuitem]:has-text("剖切模型")', { waitMs: 1500 })) {
      await shot(p, "studio3d-clipping");
      await clickIfVisible(p, 'button[aria-label*="剖切模型"], button[title*="关闭剖切"]', { waitMs: 1000 });
    }
    // 模型爆炸
    if (await clickIfVisible(p, 'button[aria-label*="查看与分析"], button[title*="查看与分析"]', { waitMs: 800 })
      && await clickIfVisible(p, '[role=menuitem]:has-text("模型爆炸")', { waitMs: 1500 })) {
      await shot(p, "studio3d-explode");
      await clickIfVisible(p, 'button[aria-label*="查看与分析"], button[title*="查看与分析"]', { waitMs: 700 });
      await clickIfVisible(p, '[role=menuitem]:has-text("模型爆炸")', { waitMs: 1200 });
    }
    // 场景信息
    if (await clickIfVisible(p, 'button[aria-label*="查看与分析"], button[title*="查看与分析"]', { waitMs: 800 })
      && await clickIfVisible(p, '[role=menuitem]:has-text("场景信息")', { waitMs: 1400 })) {
      await shot(p, "studio3d-scene-info");
      await p.keyboard.press("Escape");
      await sleep(500);
    }
    // 环境与灯光
    if (await clickIfVisible(p, 'button[aria-label*="查看与分析"], button[title*="查看与分析"]', { waitMs: 800 })
      && await clickIfVisible(p, '[role=menuitem]:has-text("环境与灯光")', { waitMs: 1400 })) {
      await shot(p, "studio3d-environment");
      await clickIfVisible(p, 'button[aria-label*="关闭环境与灯光"]', { waitMs: 900 });
      await p.keyboard.press("Escape");
      await sleep(400);
    }
    // 相机与漫游
    if (await clickIfVisible(p, 'button[aria-label*="查看与分析"], button[title*="查看与分析"]', { waitMs: 800 })
      && await clickIfVisible(p, '[role=menuitem]:has-text("相机与漫游")', { waitMs: 1200 })) {
      await shot(p, "studio3d-camera-nav");
      await p.keyboard.press("Escape");
      await sleep(400);
    }
    // 动画与时间线
    if (await clickIfVisible(p, 'button[aria-label*="查看与分析"], button[title*="查看与分析"]', { waitMs: 800 })
      && await clickIfVisible(p, '[role=menuitem]:has-text("动画与时间线")', { waitMs: 1400 })) {
      await shot(p, "studio3d-timeline");
      await p.keyboard.press("Escape");
      await sleep(400);
    }
  });

  await step("27-studio3d-sim-menu", async (s) => {
    if (!(await clickIfVisible(p, 'button[aria-label*="仿真与开发"], button[title*="仿真与开发"]', { waitMs: 900 }))) { s.notes.push("仿真与开发菜单不可见"); return; }
    await shot(p, "studio3d-sim-menu");
    // 菜单展开态点击 物理系统
    if (await clickIfVisible(p, '[role=menuitem]:has-text("物理系统")', { waitMs: 1800 })) {
      await shot(p, "studio3d-physics");
      await p.keyboard.press("Escape");
      await sleep(500);
    }
  });

  await step("28-studio3d-select-object-inspector", async (s) => {
    const row = p.locator('button:has-text("设备 001"), [class*=object] :text("设备 001")').first();
    if (await row.isVisible().catch(() => false)) {
      await row.click();
      await sleep(1200);
      s.notes.push("已通过对象列表选中 设备 001");
    } else {
      const anyRow = p.locator('[class*=scene-object] button, [class*=object-list] button').first();
      if (!(await anyRow.isVisible().catch(() => false))) { s.notes.push("对象列表不可见"); return; }
      await anyRow.click();
      await sleep(1200);
    }
    await shot(p, "studio3d-object-selected");
    const tabs = p.locator(".inspector-context-tabs button");
    const n = await tabs.count();
    s.notes.push(`3D 属性面板 tab 数=${n}`);
    for (let i = 0; i < Math.min(n, 4); i++) {
      const t = tabs.nth(i);
      if (await t.isDisabled().catch(() => false)) continue;
      const label = ((await t.textContent().catch(() => "")) ?? "").trim().slice(0, 8) || `tab${i}`;
      await t.click().catch(() => {});
      await sleep(800);
      await shot(p, `studio3d-inspector-${i + 1}-${label.replace(/[^\w一-龥-]/g, "")}`);
    }
    // 有选中对象后,变换工具应可用
    for (const [label, file] of [["移动", "move-sel"], ["旋转", "rotate-sel"], ["缩放", "scale-sel"]]) {
      const ok = await clickIfVisible(p, `.scene-dock-button[aria-label*="${label}"], button[aria-label*="${label}"]`, { waitMs: 800 });
      if (ok) await shot(p, `studio3d-tool-${file}`);
      else s.notes.push(`工具 ${label} 不可见(选中态)`);
    }
  });

  await step("29-studio3d-asset-dialog", async (s) => {
    // 场景对象面板头部的资源库按钮(金色箱体图标)
    const opened = await clickIfVisible(p, 'button[aria-label*="资源库"], button[title*="资源库"], aside button[aria-label*="资源"]', { waitMs: 1500 });
    if (!opened) { s.notes.push("3D 资源库入口不可见"); return; }
    await shot(p, "studio3d-asset-dialog");
    await p.keyboard.press("Escape");
    await sleep(600);
    await shot(p, "studio3d-asset-dialog-after-esc");
  });

  /* ---------- 脚本编辑器 ---------- */
  await step("30-script-editor", async (s) => {
    const btn = p.locator('.workspace-mode-switch button:text-is("脚本")').first();
    if (!(await btn.isVisible().catch(() => false))) throw new Error("脚本模式按钮不可见");
    await btn.click();
    await sleep(3500);
    s.screenshot = await shot(p, "script-editor");
    s.notes.push(`运行入口可见=${await p.locator('button[aria-label*="运行"], button:has-text("试运行"), button:has-text("运行")').first().isVisible().catch(() => false)}`);
    // 新建脚本
    const newBtn = p.locator('button:has-text("新建")').first();
    if (await newBtn.isVisible().catch(() => false)) {
      await newBtn.click();
      await sleep(1000);
      await shot(p, "script-new");
      const closed = await escCloses(p, "dialog[open], [role=dialog]:visible, input:focus-visible");
      s.notes.push(`新建脚本交互 Esc 恢复=${closed}`);
    }
    // 返回二维
    await clickIfVisible(p, 'button:has-text("返回二维")', { waitMs: 1500 });
  });

  /* ---------- 管理台各中心 ---------- */
  const centers = [
    ["24-data-center", 'button[aria-label="数据中心"]', "data-center"],
    ["25-ai-center", 'button[aria-label="AI 助手"]', "ai-center"],
    ["26-optimizer", 'button[aria-label="模型优化"]', "optimizer"],
    ["27-parametric", 'button[aria-label="参数化生成"]', "parametric"],
    ["28-cloud-settings", 'button[aria-label="云渲染设置"]', "cloud-settings"],
    ["29-vision-center", 'button[aria-label="视觉中心"]', "vision-center"],
    ["30-operations-center", 'button[aria-label="智能运营"]', "operations"],
    ["31-docs", 'button[aria-label="文档"]', "docs"],
  ];
  for (const [name, sel, file] of centers) {
    await step(name, async (s) => {
      await p.goto(origin + "/manager", { waitUntil: "domcontentloaded" });
      await sleep(1800);
      const btn = p.locator(`${sel}`).first();
      if (!(await btn.isVisible().catch(() => false))) throw new Error(`入口不可见: ${sel}`);
      if (await btn.isDisabled()) { s.notes.push("入口禁用"); return; }
      await btn.click();
      await sleep(3000);
      s.screenshot = await shot(p, file);
      // 优化器/运营的分页签
      if (name === "26-optimizer") {
        for (const t of ["2 转换", "3 编辑与优化", "4 项目素材"]) {
          if (await clickIfVisible(p, `button:has-text("${t}")`, { waitMs: 900 })) await shot(p, `optimizer-${t.slice(0, 1)}`);
        }
      }
      if (name === "30-operations-center") {
        const tabs = p.locator("[role=tab]");
        const n = await tabs.count();
        for (let i = 1; i < Math.min(n, 7); i++) {
          await tabs.nth(i).click().catch(() => {});
          await sleep(900);
          await shot(p, `operations-tab-${i + 1}`);
        }
      }
    });
  }

  await step("32-system-settings", async (s) => {
    await p.goto(origin + "/manager", { waitUntil: "domcontentloaded" });
    await sleep(1800);
    const btn = p.locator('.manager-utility-nav button[aria-label="设置"]');
    if (!(await btn.isVisible().catch(() => false))) throw new Error("设置入口不可见");
    await btn.click();
    await sleep(2500);
    s.screenshot = await shot(p, "system-settings");
    const tabs = p.locator("[role=tab]");
    const n = await tabs.count();
    s.notes.push(`设置 tab 数=${n}`);
    for (let i = 1; i < Math.min(n, 8); i++) {
      const t = tabs.nth(i);
      const label = ((await t.textContent().catch(() => "")) ?? "").trim().slice(0, 10) || `tab${i}`;
      await t.click().catch(() => {});
      await sleep(900);
      await shot(p, `settings-tab-${i + 1}-${label.replace(/[^\w\u4e00-\u9fa5-]/g, "")}`);
    }
  });

  await step("33-branding-performance-toggles", async (s) => {
    await p.goto(origin + "/manager", { waitUntil: "domcontentloaded" });
    await sleep(1800);
    const btn = p.locator('.manager-utility-nav button[aria-label="品牌设置"]');
    if (!(await btn.isVisible().catch(() => false))) throw new Error("品牌设置入口不可见");
    await btn.click();
    await sleep(2500);
    s.screenshot = await shot(p, "branding-settings");
    // 后台线程渲染开关真实点击(点击后还原,不保存)
    const toggle = p.locator('label:has-text("后台线程渲染") input[type=checkbox], :text("后台线程渲染") >> xpath=ancestor::label >> input[type=checkbox]').first();
    if (await toggle.isVisible().catch(() => false)) {
      const before = await toggle.isChecked();
      await toggle.click({ force: true });
      await sleep(900);
      const after = await toggle.isChecked();
      s.notes.push(`后台线程渲染开关: ${before} -> ${after}`);
      await shot(p, "branding-bg-thread-on");
      await toggle.click({ force: true });
      await sleep(700);
      s.notes.push(`已还原为 ${await toggle.isChecked()}`);
    } else s.notes.push("未找到后台线程渲染开关 input");
  });

  await browser.close();
}

/* ================= Pass B:1280x800 关键页 ================= */
{
  const { browser, page: p } = await makeContext(V_MID);
  page = p;
  await step("40-mid1280-manager", async (s) => {
    await ensureLoggedIn(p);
    await sleep(1200);
    s.screenshot = await shot(p, "mid1280-manager");
  });
  await step("41-mid1280-workspace-2d", async (s) => {
    const editBtn = p.locator('.scene-card button[aria-label="编辑场景"]').first();
    if (!(await editBtn.isVisible().catch(() => false))) { s.notes.push("无场景可编辑"); return; }
    await editBtn.click();
    await sleep(4500);
    s.screenshot = await shot(p, "mid1280-dashboard");
  });
  await step("42-mid1280-studio3d", async (s) => {
    const btn = p.locator('button:text-is("三维")').first();
    if (!(await btn.isVisible().catch(() => false))) { s.notes.push("三维按钮不可见"); return; }
    await btn.click();
    await sleep(5000);
    s.screenshot = await shot(p, "mid1280-studio3d");
  });
  await browser.close();
}

/* ================= Pass C:980 窄窗 ================= */
{
  const { browser, page: p } = await makeContext(V_NARROW);
  page = p;
  await step("50-narrow980-manager", async (s) => {
    await ensureLoggedIn(p);
    await sleep(1200);
    s.screenshot = await shot(p, "narrow980-manager");
    s.notes.push(`横向溢出=${await p.evaluate(() => document.body.scrollWidth > window.innerWidth)}`);
    s.notes.push(`场景卡片数=${await p.locator(".scene-card").count()}`);
  });
  await step("51-narrow980-workspace-2d", async (s) => {
    const editBtn = p.locator('.scene-card button[aria-label="编辑场景"]').first();
    if (!(await editBtn.isVisible().catch(() => false))) { s.notes.push("无场景可编辑"); return; }
    await editBtn.click();
    await sleep(4500);
    s.screenshot = await shot(p, "narrow980-dashboard");
    s.notes.push(`横向溢出=${await p.evaluate(() => document.body.scrollWidth > window.innerWidth)}`);
  });
  await step("52-narrow980-studio3d", async (s) => {
    const btn = p.locator('button:text-is("三维")').first();
    if (!(await btn.isVisible().catch(() => false))) { s.notes.push("三维按钮不可见"); return; }
    await btn.click();
    await sleep(5000);
    s.screenshot = await shot(p, "narrow980-studio3d");
    s.notes.push(`横向溢出=${await p.evaluate(() => document.body.scrollWidth > window.innerWidth)}`);
  });
  await step("53-narrow980-settings", async (s) => {
    await p.goto(origin + "/system", { waitUntil: "domcontentloaded" });
    await sleep(2500);
    s.screenshot = await shot(p, "narrow980-settings");
    s.notes.push(`横向溢出=${await p.evaluate(() => document.body.scrollWidth > window.innerWidth)}`);
  });
  await step("54-narrow980-branding", async (s) => {
    await p.goto(origin + "/branding", { waitUntil: "domcontentloaded" });
    await sleep(2500);
    s.screenshot = await shot(p, "narrow980-branding");
    s.notes.push(`横向溢出=${await p.evaluate(() => document.body.scrollWidth > window.innerWidth)}`);
  });
  await browser.close();
}

/* ================= 汇总 ================= */
report.finishedAt = new Date().toISOString();
report.summary = {
  total: report.steps.length,
  ok: report.steps.filter((x) => x.ok).length,
  failed: report.steps.filter((x) => !x.ok).map((x) => x.name),
  consoleErrorCount: report.consoleErrors.length,
  httpFailureCount: report.httpFailures.length,
};
writeFileSync(join(outDir, "sweep-report.json"), JSON.stringify(report, null, 2));
console.log("\n==== 汇总 ====");
console.log(JSON.stringify(report.summary, null, 2));
console.log(`报告: ${join(outDir, "sweep-report.json")}`);
