/**
 * G2-S2b/S2d Play 草稿丢弃汇报 + 行为轨迹回放 视觉验收门禁(1920×1080 深色,两轮独立截图)。
 *
 * 用法:node apps/web/scripts/g2-s2b-s2d-visual-gate.mjs <round>   (round = 1|2)
 * 产物:test-output/g2-s2b-s2d-visual-20261002/round<N>/*.png + report.json + exported-trace.json
 *
 * 剧本:
 *  t0 空态:导演台「行为轨迹」页签,尚未产生轨迹的只读审阅器空态
 *  b1 进入呈现:Play 进入消息「修改仅在本次播放期间生效」
 *  t1 轨迹累计:tick 受限图在 Play 中产生 T31 条目,时间轴/outcome 标记/详情卡
 *  t2 步进+scrub:上一条/轨道点击改选,详情与播放头随动;导出 JSON 落盘并断言格式
 *  t3 退出后审阅:退出 Play 后轨迹仍可审阅(审计器语义)+ 退出消息
 *  b2 丢弃汇报:Play 中放置立方体(被门禁吸收),退出消息「1 项临时修改已丢弃」
 * 基建复用 isolatedStudioGate(独立端口/数据目录/OBJECT_STORE=local,用完即关)。
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { showFlatSceneObjects, writeMinimalGltf } from "./onlineFlowAuditSupport.mjs";

const round = Number(process.argv[2] ?? "1");
assert.ok(round === 1 || round === 2, "用法:node g2-s2b-s2d-visual-gate.mjs <1|2>");
const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const outputRoot = resolve(repositoryRoot, `test-output/g2-s2b-s2d-visual-20261002/round${round}`);
await mkdir(outputRoot, { recursive: true });
const modelFixturePath = resolve(outputRoot, "fixture-triangle.gltf");
writeMinimalGltf(modelFixturePath);

const report = { round, startedAt: new Date().toISOString(), steps: [], failures: [], screenshots: [] };
const step = (id, detail) => { report.steps.push({ id, detail }); console.log(`  ✓ ${id}${detail ? ` — ${JSON.stringify(detail)}` : ""}`); };

const gate = await createIsolatedStudioGate("g2-s2b-s2d-visual");
let page;
try {
  const context = await gate.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/public/branding", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), themeMode: "dark" } });
  });
  const shot = async (name) => {
    const path = resolve(outputRoot, `${name}.png`);
    await page.screenshot({ path });
    report.screenshots.push(`test-output/g2-s2b-s2d-visual-20261002/round${round}/${name}.png`);
  };
  const assertDark = async () => {
    const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    assert.notEqual(theme, "light", "主题必须是深色(默认),不得回退浅色");
  };
  const statusText = () => page.evaluate(() => document.querySelector(".viewport-status")?.textContent ?? "");
  // S2a §三-4 同族教训:DOM 更新 ≠ 已上屏,合成帧滞后会让截图拍到旧状态。
  // 消息类截图前双 rAF + 150ms 等新帧提交。
  const settle = async () => {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForTimeout(150);
  };

  /* ---------------- 场景准备:项目 → 场景 → 模型入场景 → 选中(沿 S2a 真实用户路径) ---------------- */
  const project = await gate.json("POST", "/api/projects", { name: `G2-S2b/S2d 视觉验收-轮${round}` });
  await gate.loginPage(page);
  await page.getByLabel("当前项目").selectOption(project.id);
  await page.getByRole("button", { name: "项目场景", exact: true }).click();
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill(`轨迹回放验收场景${round}`);
  const application = await (async () => {
    const response = page.waitForResponse((candidate) => candidate.url().includes(`/api/projects/${project.id}/applications`) && candidate.request().method() === "POST");
    await page.getByRole("button", { name: "创建并进入" }).click();
    return response.then((entry) => entry.json());
  })();
  const scene = application.scenes?.[0];
  assert.ok(scene?.id && application.metadata?.id, "创建场景后未返回有效应用与场景标识");
  await assertDark();
  const sceneEditorUrl = `${gate.origin}/studio/${encodeURIComponent(project.id)}/applications/${encodeURIComponent(application.metadata.id)}/scenes/${encodeURIComponent(scene.id)}`;
  await page.goto(sceneEditorUrl, { waitUntil: "networkidle", timeout: 90_000 });
  await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor();
  const uploadResponse = page.waitForResponse((candidate) => candidate.url().includes(`/api/projects/${project.id}/models?`) && candidate.request().method() === "POST");
  await page.locator('input[type="file"][accept*=".glb"]').setInputFiles(modelFixturePath);
  const uploadedModel = await uploadResponse.then((entry) => entry.json());
  await page.waitForFunction(async ({ projectId, modelId }) => {
    const token = localStorage.getItem("bim-studio-auth-token") ?? sessionStorage.getItem("bim-studio-auth-token");
    const entry = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!entry.ok) return false;
    const body = await entry.json();
    return body.models?.some((model) => model.id === modelId && model.status === "ready");
  }, { projectId: project.id, modelId: uploadedModel.id });
  await page.getByRole("dialog").getByRole("button", { name: "直接插入" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await showFlatSceneObjects(page);
  const modelRow = page.locator(".asset-row").filter({ hasText: "fixture-triangle.gltf" });
  await modelRow.waitFor();
  await modelRow.locator(".asset-main").click();
  await page.locator(".right-panel .inspector-context-tabs").waitFor();
  await page.locator(".right-panel .inspector-context-tabs button").nth(2).click();
  await page.locator(".right-panel .interaction-editor").waitFor();
  step("scene-ready", { projectId: project.id, sceneId: scene.id, modelId: uploadedModel.id });

  /* ---------------- 建 tick 受限图:调色板点击放置(确定性 dagre 布局,免拖拽叠压) ---------------- */
  const interactionEditor = page.locator(".right-panel .interaction-editor");
  await interactionEditor.locator("> summary").click();
  await interactionEditor.locator(".interaction-graph-new").click();
  const advanced = interactionEditor.locator(".interaction-advanced");
  await advanced.locator("> summary").click();
  await page.locator(".behavior-graph-editor").waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 0);
  // 点击调色板 chip 放到默认位置(dagre 增量布局,节点不叠压)。
  // 画布 onlyRenderVisibleElements:点击放置可能落在可视区外不渲染 DOM,
  // 故以编辑器自报的 data-debug-nodes 为放置真值;两节点就位后取消选中(关属性表单)
  // 再点 Controls 适应画布,把节点全部带入视口。
  const editorNodesCount = () => page.evaluate(() => Number(document.querySelector(".behavior-graph-editor")?.getAttribute("data-debug-nodes") ?? "0"));
  const placeChip = async (label, expectedCount) => {
    await page.locator(".behavior-palette-chips [role=button]", { hasText: label }).first().click();
    try {
      await page.waitForFunction((count) => Number(document.querySelector(".behavior-graph-editor")?.getAttribute("data-debug-nodes") ?? "0") === count, expectedCount, { timeout: 10_000 });
    } catch {
      const diagnostic = await page.evaluate(() => ({
        nodes: [...document.querySelectorAll(".react-flow__node")].map((node) => node.getAttribute("data-id")),
        chips: [...document.querySelectorAll(".behavior-palette-chips [role=button]")].map((chip) => chip.textContent?.trim()),
        status: document.querySelector(".behavior-editor-status")?.textContent?.slice(0, 200) ?? null,
        editors: document.querySelectorAll(".behavior-graph-editor").length,
        debug: [...document.querySelectorAll(".behavior-graph-editor")].map((section) => ({
          doc: section.getAttribute("data-debug-doc"),
          nodes: section.getAttribute("data-debug-nodes"),
          dirty: section.getAttribute("data-dirty"),
        })),
      }));
      throw new Error(`调色板节点 ${label} 未放置(期望 ${expectedCount}):${JSON.stringify(diagnostic)}`);
    }
  };
  await placeChip("定时 tick", 1);
  await placeChip("写入数据", 2);
  // 关闭节点属性表单(会盖住右下角 Controls),再适应画布让两节点进入渲染集。
  const closeForm = page.locator(".behavior-node-form-close");
  if (await closeForm.count()) await closeForm.first().click();
  await page.locator(".behavior-node-form").waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 2, undefined, { timeout: 10_000 });
  step("palette-nodes-visible", { nodes: 2 });
  // 连线 tick-1 →(source 下端口)→ set-value-1(target 上端口);覆盖层瞬 时穿透后仍走真实鼠标链。
  const setOverlayPassthrough = (passthrough) =>
    page.evaluate((on) => {
      for (const element of document.querySelectorAll(".react-flow__minimap, .react-flow__controls")) {
        element.style.pointerEvents = on ? "none" : "";
      }
    }, passthrough);
  const revealHandle = (selector) => page.evaluate((sel) => {
    const state = (window.__g2ClearedCover ??= []);
    const handle = document.querySelector(sel);
    if (!handle) return { ok: false, reason: "handle-not-found" };
    for (let index = 0; index < 6; index += 1) {
      const rect = handle.getBoundingClientRect();
      const element = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (!element) return { ok: false, reason: "out-of-viewport" };
      if (element === handle || handle.contains(element) || element.contains(handle)) return { ok: true };
      element.style.pointerEvents = "none";
      state.push(element);
    }
    return { ok: false, reason: "still-covered" };
  }, selector);
  const restoreCover = () => page.evaluate(() => {
    for (const element of window.__g2ClearedCover ?? []) element.style.pointerEvents = "";
    window.__g2ClearedCover = [];
  });
  // 画布滚入视口(右面板内容总高大于视口)。
  await page.evaluate(() => {
    const pane = document.querySelector(".behavior-editor-body");
    if (!pane) return;
    const rect = pane.getBoundingClientRect();
    const overflow = rect.bottom - window.innerHeight;
    if (overflow > 0) window.scrollBy(0, overflow + 12);
  });
  const fromSelector = `.react-flow__node[data-id="tick-1"] .is-port-source`;
  const toSelector = `.react-flow__node[data-id="set-value-1"] .react-flow__handle.react-flow__handle-top`;
  const from = await page.locator(fromSelector).boundingBox();
  const to = await page.locator(toSelector).boundingBox();
  assert.ok(from && to, `连线端点不可见: ${JSON.stringify({ from, to })}`);
  assert.ok((await revealHandle(fromSelector)).ok, "连线起点被遮挡无法命中");
  const edgesBefore = await page.locator(".react-flow__edge").count();
  await setOverlayPassthrough(true);
  try {
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 14 });
    await page.waitForTimeout(150);
    await page.mouse.up();
  } finally {
    await setOverlayPassthrough(false);
    await restoreCover();
  }
  await page.waitForFunction((expected) => document.querySelectorAll(".react-flow__edge").length === expected, edgesBefore + 1, { timeout: 5_000 });
  // 保存(保存按钮真实点击)→ 已保存 clean 态。
  const saveButton = page.locator(".behavior-editor-save");
  await saveButton.click();
  await page.waitForFunction(() => document.querySelector(".behavior-editor-save")?.getAttribute("data-state") === "clean", undefined, { timeout: 10_000 });
  step("tick-graph-saved", { nodes: 2, edges: 1 });

  /* ---------------- 打开导演台「行为轨迹」页签(交互编辑器在三维右面板,无需切工作区) ---------------- */
  // 打开场景导演台:工具坞「查看与分析」→「场景导演台」。
  const dockMenu = page.locator(".scene-tool-dock").getByText("查看与分析", { exact: true }).first();
  await dockMenu.click();
  await page.getByText("场景导演台", { exact: true }).last().click();
  await page.locator(".timeline-panel").waitFor();
  await page.locator(".scene-director-tabs").getByRole("button", { name: "行为轨迹" }).click();
  await page.locator(".scene-behavior-trace").waitFor();
  await page.locator(".trace-replay-empty").waitFor();
  assert.ok(await page.locator(".trace-replay-empty").getByText("尚未产生行为轨迹").isVisible(), "空态文案必须可见");
  await assertDark();
  await shot("t0-empty-trace");
  step("t0-empty-trace", { emptyState: true });
  // 消息 pill(.viewport-status)锚在视口左下,会被展开的导演台面板遮住——
  // 拍进入/退出消息时先收起面板,消息呈现与面板内容分开取证。
  const closeDirector = async () => {
    await page.getByRole("button", { name: "关闭导演台" }).click();
    await page.locator(".timeline-panel").waitFor({ state: "hidden", timeout: 5_000 });
  };
  const openDirector = async () => {
    await page.locator(".scene-tool-dock").getByText("查看与分析", { exact: true }).first().click();
    await page.getByRole("menuitem", { name: "场景导演台" }).click();
    await page.locator(".timeline-panel").waitFor();
    // 坞开关重开固定落到 timeline 工作区(产品语义),回放取证需切回行为轨迹页签。
    await page.locator(".scene-director-tabs").getByRole("button", { name: "行为轨迹" }).click();
    await page.locator(".scene-behavior-trace").waitFor();
  };
  await closeDirector();

  /* ---------------- b1 进入播放:草稿语义呈现 ---------------- */
  const playButton = page.locator(".scene-play-action");
  await playButton.click();
  await page.waitForFunction(() => document.querySelector(".viewport-status")?.textContent?.includes("已进入播放模式"), undefined, { timeout: 15_000 });
  const entryNotice = await statusText();
  assert.ok(entryNotice.includes("修改仅在本次播放期间生效"), `进入消息必须声明播放草稿语义:${entryNotice}`);
  await assertDark();
  await settle();
  await shot("b1-entry-notice");
  step("b1-entry-notice", { notice: entryNotice.trim() });

  /* ---------------- t1 轨迹累计:tick 图在 Play 中产生 T31 条目 ---------------- */
  // 面板收起时轨迹仓照常累积(store 与面板可见性无关);等满 5 个 tick 后再展开面板取证。
  await page.waitForTimeout(6_200);
  await openDirector();
  await page.waitForFunction(() => {
    const text = document.querySelector(".trace-replay-summary")?.textContent ?? "";
    const match = text.match(/条目 (\d+)/);
    return match ? Number(match[1]) >= 5 : false;
  }, undefined, { timeout: 25_000 });
  await page.waitForFunction(() => Boolean(document.querySelector(".trace-replay-detail .trace-replay-outcome")), undefined, { timeout: 10_000 });
  const traceSummary = await page.evaluate(() => document.querySelector(".trace-replay-summary")?.textContent ?? "");
  await page.waitForFunction(() => document.querySelector(".trace-replay-summary")?.textContent === (document.querySelector(".trace-replay-summary")?.textContent ?? ""), undefined, { timeout: 1_200 }).catch(() => {});
  await assertDark();
  await shot("t1-trace-live");
  const entryCount = Number((traceSummary.match(/条目 (\d+)/) ?? [])[1] ?? 0);
  assert.ok(entryCount >= 5, `轨迹条目应累计 ≥5,实际 ${entryCount}`);
  step("t1-trace-live", { entryCount, summary: traceSummary.trim().slice(0, 80) });

  /* ---------------- t2 步进+scrub+导出 ---------------- */
  const positionText = () => page.evaluate(() => document.querySelector(".trace-replay-position")?.textContent ?? "");
  const before = await positionText();
  await page.locator('.trace-replay-step[aria-label="上一条"]').click();
  await page.waitForFunction((prev) => document.querySelector(".trace-replay-position")?.textContent !== prev, before, { timeout: 5_000 });
  // 轨道 scrub:点击轨道 30% 处,选择跳到时间域最近条目。
  const rail = await page.locator(".trace-replay-rail").first().boundingBox();
  assert.ok(rail, "轨迹轨道不可见");
  await page.mouse.click(rail.x + rail.width * 0.3, rail.y + rail.height / 2);
  await page.waitForTimeout(300);
  const afterScrub = await positionText();
  assert.notEqual(afterScrub, before, `scrub 后审阅位置必须变化:${before} → ${afterScrub}`);
  // 导出 JSON:真实下载,断言 T31 导出纪律(格式标识 + 条目数 + 体内容零墙钟)。
  const downloadPromise = page.waitForEvent("download", { timeout: 10_000 });
  await page.locator(".trace-replay-export").click();
  const download = await downloadPromise;
  const exportedPath = resolve(outputRoot, "exported-trace.json");
  await download.saveAs(exportedPath);
  const exported = JSON.parse(await readFile(exportedPath, "utf8"));
  assert.equal(exported.format, "bim-studio/behavior-trace/v1", "导出格式标识必须是 bim-studio/behavior-trace/v1");
  assert.ok(exported.entryCount >= 5, `导出条目数应 ≥5,实际 ${exported.entryCount}`);
  assert.ok(Array.isArray(exported.sources) && exported.sources[0]?.entries?.length === exported.entryCount, "导出 sources 与 entryCount 必须同构");
  await assertDark();
  await shot("t2-trace-step");
  step("t2-trace-step", { before, afterScrub, exportedEntries: exported.entryCount });

  /* ---------------- t3 退出后仍可审阅(审计器语义)+ 退出消息 ---------------- */
  await playButton.click();
  await page.waitForFunction(() => document.querySelector(".viewport-status")?.textContent?.includes("已退出播放模式"), undefined, { timeout: 20_000 });
  const exitNotice = await statusText();
  assert.ok(exitNotice.includes("恢复为进入前状态"), `退出消息必须声明恢复语义:${exitNotice}`);
  // 计数语义:门禁吸收的每一次记账(含物理/引擎在播放期的状态改写)退出时都会被丢弃,
  // 汇报数字必须与吸收次数一致;无吸收时为基数文案。两阶段的真实数字记入 report。
  const firstPlayDiscard = Number((exitNotice.match(/(\d+) 项临时状态变更/) ?? [])[1] ?? 0);
  await page.locator(".trace-replay-empty").waitFor({ state: "hidden", timeout: 10_000 });
  const afterExitCount = Number(((await page.evaluate(() => document.querySelector(".trace-replay-summary")?.textContent ?? "")).match(/条目 (\d+)/) ?? [])[1] ?? 0);
  assert.ok(afterExitCount >= 5, `退出后轨迹必须保留可审阅,实际条目 ${afterExitCount}`);
  await assertDark();
  await shot("t3-trace-after-exit");
  step("t3-trace-after-exit", { exitNotice: exitNotice.trim(), afterExitCount, firstPlayDiscard });

  /* ---------------- b2 Play 中临时修改 → 退出丢弃汇报 ---------------- */
  await playButton.click();
  await page.waitForFunction(() => document.querySelector(".viewport-status")?.textContent?.includes("已进入播放模式"), undefined, { timeout: 15_000 });
  // 工具坞「创建」→「立方体」→ 画布放置(放置基础元素 → 记账被 Play 门禁吸收)。
  await page.locator(".scene-tool-dock").getByText("创建", { exact: true }).first().click();
  await page.getByRole("menuitem", { name: "立方体" }).click();
  await page.waitForFunction(() => document.querySelector(".viewport-status")?.textContent?.includes("放置"), undefined, { timeout: 8_000 }).catch(() => {});
  const canvasBox = await page.locator('.viewport canvas:not([aria-hidden="true"])').first().boundingBox();
  assert.ok(canvasBox, "视口画布不可见");
  await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height * 0.5);
  await page.waitForFunction(() => document.querySelector(".viewport-status")?.textContent?.includes("已放置"), undefined, { timeout: 12_000 });
  // 等轨迹在第二会话继续累计(审计器对新会话重置后重新收纳)。
  await page.waitForFunction(() => {
    const text = document.querySelector(".trace-replay-summary")?.textContent ?? "";
    const match = text.match(/条目 (\d+)/);
    return match ? Number(match[1]) >= 2 : false;
  }, undefined, { timeout: 20_000 });
  // 收起面板再退出:退出丢弃汇报的消息 pill 需要在面板收起时入镜。
  await closeDirector();
  await playButton.click();
  await page.waitForFunction(() => document.querySelector(".viewport-status")?.textContent?.includes("已退出播放模式"), undefined, { timeout: 20_000 });
  const discardNotice = await statusText();
  await settle();
  const discardMatch = discardNotice.match(/(\d+) 项临时状态变更已丢弃/);
  assert.ok(discardMatch && Number(discardMatch[1]) >= 1, `退出消息必须如实汇报丢弃的临时状态变更(≥1,放置了立方体):${discardNotice}`);
  await assertDark();
  await shot("b2-discard-report");
  step("b2-discard-report", { discardNotice: discardNotice.trim(), discarded: Number(discardMatch[1]) });

  assert.deepEqual(pageErrors, [], "全程不得有页面错误");
  report.finishedAt = new Date().toISOString();
  report.passed = true;
  await writeFile(resolve(outputRoot, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\nG2-S2b/S2d 视觉门禁 轮次 ${round}:全部路径通过 → ${outputRoot}`);
} catch (error) {
  report.failures.push(String(error?.stack ?? error));
  report.passed = false;
  await page?.screenshot({ path: resolve(outputRoot, "failure.png") }).catch(() => {});
  await writeFile(resolve(outputRoot, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  await gate.close();
}
