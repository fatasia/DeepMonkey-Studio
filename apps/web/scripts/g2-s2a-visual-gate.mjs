/**
 * G2-S2a 行为图编辑器五路径视觉验收门禁(1920×1080 深色,两轮独立截图)。
 *
 * 用法:node apps/web/scripts/g2-s2a-visual-gate.mjs <round>   (round = 1|2)
 * 产物:test-output/g2-s2a-visual-20261002/round<N>/*.png + report.json
 *
 * 五路径:P1 拖入调色板 → P2 连线 → P3 改表达式 → P4 保存门禁 → P5 非法拦截。
 * 另含 A 线收口结构探针:受限脚本不渲染可信动作区(W3 UI 防呆)。
 * 基建复用 isolatedStudioGate(独立端口/数据目录/本地对象存储,不触碰用户数据)。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { showFlatSceneObjects, writeMinimalGltf } from "./onlineFlowAuditSupport.mjs";

const round = Number(process.argv[2] ?? "1");
assert.ok(round === 1 || round === 2, "用法:node g2-s2a-visual-gate.mjs <1|2>");
const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const outputRoot = resolve(repositoryRoot, `test-output/g2-s2a-visual-20261002/round${round}`);
await mkdir(outputRoot, { recursive: true });
const modelFixturePath = resolve(outputRoot, "fixture-triangle.gltf");
writeMinimalGltf(modelFixturePath);

const report = { round, startedAt: new Date().toISOString(), steps: [], failures: [], screenshots: [] };
const step = (id, detail) => { report.steps.push({ id, detail }); console.log(`  ✓ ${id}${detail ? ` — ${JSON.stringify(detail)}` : ""}`); };

  const gate = await createIsolatedStudioGate("g2-s2a-visual");
  let page;
  try {
    const context = await gate.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // 深色主题(默认即深色;显式锁定防止环境漂移)。
  await page.route("**/api/public/branding", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), themeMode: "dark" } });
  });
  const shot = async (name) => {
    const path = resolve(outputRoot, `${name}.png`);
    await page.screenshot({ path });
    report.screenshots.push(`test-output/g2-s2a-visual-20261002/round${round}/${name}.png`);
  };
  const assertDark = async () => {
    const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    assert.notEqual(theme, "light", "主题必须是深色(默认),不得回退浅色");
  };

  /* ---------------- 场景准备:项目 → 场景 → 模型入场景 → 选中 ---------------- */
  const project = await gate.json("POST", "/api/projects", { name: `G2-S2a 视觉验收-轮${round}` });
  await gate.loginPage(page);
  await page.getByLabel("当前项目").selectOption(project.id);
  await page.getByRole("button", { name: "项目场景", exact: true }).click();
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("行为图验收场景");
  const application = await (async () => {
    const response = page.waitForResponse((candidate) => candidate.url().includes(`/api/projects/${project.id}/applications`) && candidate.request().method() === "POST");
    await page.getByRole("button", { name: "创建并进入" }).click();
    return response.then((entry) => entry.json());
  })();
  const scene = application.scenes?.[0];
  assert.ok(scene?.id && application.metadata?.id, "创建场景后未返回有效应用与场景标识");
  await assertDark();
  step("scene-ready", { projectId: project.id, sceneId: scene.id });

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
  // 上传完成后应用弹出「选择模型处理方式」;选择「直接插入」把模型放进当前场景。
  await page.getByRole("dialog").getByRole("button", { name: "直接插入" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await showFlatSceneObjects(page);
  const modelRow = page.locator(".asset-row").filter({ hasText: "fixture-triangle.gltf" });
  await modelRow.waitFor();
  // 选中模型(真实用户路径):点对象主区,右侧检查器随选中对象出现。
  await modelRow.locator(".asset-main").click();
  await page.locator(".right-panel .inspector-context-tabs").waitFor();
  await page.locator(".right-panel .inspector-context-tabs button").nth(2).click();
  await page.locator(".right-panel .interaction-editor").waitFor();
  step("model-selected", { modelId: uploadedModel.id });

  /* ---------------- 进入受限行为图编辑器 ---------------- */
  const interactionEditor = page.locator(".right-panel .interaction-editor");
  await interactionEditor.locator("> summary").click();
  await interactionEditor.locator(".interaction-graph-new").click();
  // A 线收口探针(W3):受限脚本选中时,可信动作添加区不得出现。
  assert.equal(await page.locator(".interaction-action-add").count(), 0, "受限脚本不得渲染可信动作添加区");
  assert.ok(await interactionEditor.getByText("动作由受限行为图管理").isVisible(), "页脚应声明动作归属受限图");
  step("a-line-probe-w3", { actionAddCount: 0 });
  const advanced = interactionEditor.locator(".interaction-advanced");
  await advanced.locator("> summary").click();
  const editor = page.locator(".behavior-graph-editor");
  await editor.waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 0);
  const status = editor.locator(".behavior-graph-status-item");
  assert.ok((await status.innerText()).includes("校验通过"), "空图应显示校验通过");
  await shot("p0-empty-graph");
  step("editor-opened");

  /* ---------------- 画布操作基建:视口滚动 / 遮挡穿透 / 拖排布局 ---------------- */
  // 连线与 fitView 期间 minimap(pannable)与 controls 会拦截落在其区域上的指针事件;
  // 仅在手势瞬间把它们设为 pointer-events:none——mousedown/mousemove/mouseup 仍是打在
  // 真实端口上的原生事件链,拖完恢复。
  const setOverlayPassthrough = (passthrough) =>
    page.evaluate((on) => {
      for (const element of document.querySelectorAll(".react-flow__minimap, .react-flow__controls")) {
        element.style.pointerEvents = on ? "none" : "";
      }
    }, passthrough);
  const debugProbe = async (label) => {
    if (!process.env.G2_DEBUG) return;
    console.log("    [debug]", label, await page.evaluate(() => ({
      edges: document.querySelectorAll(".react-flow__edge").length,
      connecting: document.querySelectorAll(".react-flow__connection").length,
      handles: document.querySelectorAll(".behavior-graph-editor .react-flow__handle").length,
    })));
  };
  // 把 .behavior-editor-body 滚入视口(右面板内容总高超过 1080,画布 bottom 常超出视口)。
  const ensurePaneInView = async () => {
    await page.evaluate(() => {
      const pane = document.querySelector(".behavior-editor-body");
      if (!pane) return;
      const rect = pane.getBoundingClientRect();
      const overflow = rect.bottom - window.innerHeight;
      if (overflow > 0) window.scrollBy(0, overflow + 12);
    });
    await page.waitForTimeout(200);
  };
  // 若 handle 中心被相邻节点卡片盖住(round1 失败根因:节点叠压),逐层临时关闭遮挡层
  // 的 pointer-events 直到 elementFromPoint 命中 handle;恢复走 window 上的暂存列表。
  const revealHandle = (selector) => page.evaluate((sel) => {
    const state = (window.__g2ClearedCover ??= []);
    const handle = document.querySelector(sel);
    if (!handle) return { ok: false, reason: "handle-not-found" };
    for (let index = 0; index < 6; index += 1) {
      const rect = handle.getBoundingClientRect();
      const element = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (!element) return { ok: false, reason: "out-of-viewport" };
      if (element === handle || handle.contains(element) || element.contains(handle)) return { ok: true, cleared: state.length };
      element.style.pointerEvents = "none";
      state.push(element);
    }
    return { ok: false, reason: "still-covered", cleared: state.length };
  }, selector);
  const restoreCover = () => page.evaluate(() => {
    for (const element of window.__g2ClearedCover ?? []) element.style.pointerEvents = "";
    window.__g2ClearedCover = [];
  });
  // 拖节点同理:节点叠压时 mouse.down 会命中上层节点,穿透到目标节点再起拖。
  const revealNode = (nodeId) => page.evaluate((id) => {
    const state = (window.__g2ClearedCover ??= []);
    const node = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    if (!node) return { ok: false, reason: "node-not-found" };
    for (let index = 0; index < 6; index += 1) {
      const rect = node.getBoundingClientRect();
      const element = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (!element) return { ok: false, reason: "out-of-viewport" };
      if (element === node || node.contains(element)) return { ok: true, cleared: state.length };
      element.style.pointerEvents = "none";
      state.push(element);
    }
    return { ok: false, reason: "still-covered", cleared: state.length };
  }, nodeId);
  const dragHandleToHandle = async (fromSelector, toSelector) => {
    await canvas.scrollIntoViewIfNeeded();
    await ensurePaneInView();
    const from = await page.locator(fromSelector).boundingBox();
    const to = await page.locator(toSelector).boundingBox();
    assert.ok(from && to, `连线端点不可见: ${fromSelector} → ${toSelector}`);
    const revealed = await revealHandle(fromSelector);
    assert.ok(revealed.ok, `连线起点被遮挡无法命中: ${fromSelector} → ${JSON.stringify(revealed)}`);
    if (process.env.G2_DEBUG) {
      const hit = await page.evaluate(({ x, y, selector }) => {
        const element = document.elementFromPoint(x, y);
        const handle = document.querySelector(selector);
        return {
          point: { x, y },
          hitTag: element?.tagName ?? null,
          hitClass: element?.className?.toString?.().slice(0, 90) ?? null,
          handlePointerEvents: handle ? getComputedStyle(handle).pointerEvents : null,
          handleRect: handle ? (({ x, y, width, height }) => ({ x, y, width, height }))(handle.getBoundingClientRect()) : null,
        };
      }, { x: from.x + from.width / 2, y: from.y + from.height / 2, selector: fromSelector });
      console.log("    [debug] hit-test", JSON.stringify(hit));
    }
    const edgesBefore = await page.locator(".react-flow__edge").count();
    await setOverlayPassthrough(true);
    try {
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await debugProbe("after-down");
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 14 });
      await debugProbe("before-up");
      await page.waitForTimeout(150);
      await page.mouse.up();
      await debugProbe("after-up");
    } finally {
      await setOverlayPassthrough(false);
      await restoreCover();
    }
    // up 后 5s 内必须新增一条边,否则带诊断快速失败(替代 30s 盲等)。
    try {
      await page.waitForFunction((expected) => document.querySelectorAll(".react-flow__edge").length === expected, edgesBefore + 1, { timeout: 5_000 });
    } catch {
      const diagnostic = await page.evaluate(() => ({
        edges: document.querySelectorAll(".react-flow__edge").length,
        handles: document.querySelectorAll(".behavior-graph-editor .react-flow__handle").length,
        status: document.querySelector(".behavior-editor-status")?.textContent?.slice(0, 160) ?? null,
      }));
      throw new Error(`连线未生效(${fromSelector} → ${toSelector}):${JSON.stringify(diagnostic)}`);
    }
  };
  // 拖节点到画布内目标偏移(屏幕跟手 1:1;snapGrid 20 自动对齐),用于消除节点叠压。
  const dragNodeToPaneOffset = async (nodeId, offsetX, offsetY) => {
    const paneBox = await canvas.boundingBox();
    const nodeBox = await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox();
    assert.ok(paneBox && nodeBox, `拖排节点不可见: ${nodeId}`);
    const revealed = await revealNode(nodeId);
    assert.ok(revealed.ok, `拖排节点被遮挡无法命中: ${nodeId} → ${JSON.stringify(revealed)}`);
    try {
      await page.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(paneBox.x + offsetX + nodeBox.width / 2, paneBox.y + offsetY + nodeBox.height / 2, { steps: 10 });
      await page.mouse.up();
    } finally {
      await restoreCover();
    }
    await page.waitForTimeout(150);
  };
  // 布局整理:三节点贴左拉开竖列(让出右下 Controls 与连线长度)→ 断言无叠压且画布内完整可见。
  // 不依赖 Controls 的 fitView:拖动过的节点 z 提升后会反盖 Controls 按钮,点击不可靠;
  // 隐藏窄画布 minimap 后(platform-components.css 容器查询),240px 竖列本身即可完整呈现。
  const arrangeFlowLayout = async () => {
    await ensurePaneInView();
    await dragNodeToPaneOffset("data-change-1", 0, 12);
    await dragNodeToPaneOffset("condition-1", 0, 120);
    await dragNodeToPaneOffset("set-value-1", 0, 240);
    await page.waitForTimeout(400);
    const boxes = await page.evaluate(() => {
      const pane = document.querySelector(".behavior-editor-body").getBoundingClientRect();
      const nodes = [...document.querySelectorAll(".react-flow__node")].map((node) => {
        const rect = node.getBoundingClientRect();
        return { id: node.getAttribute("data-id"), x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      });
      return { pane: { x: pane.x, y: pane.y, w: pane.width, h: pane.height }, nodes };
    });
    assert.equal(boxes.nodes.length, 3, "布局整理后应仍为 3 个节点");
    for (const node of boxes.nodes) {
      assert.ok(node.y >= boxes.pane.y - 2 && node.y + node.h <= boxes.pane.y + boxes.pane.h + 2, `节点 ${node.id} 超出画布垂直范围: ${JSON.stringify(node)}`);
    }
    for (let a = 0; a < boxes.nodes.length; a += 1) {
      for (let b = a + 1; b < boxes.nodes.length; b += 1) {
        const first = boxes.nodes[a];
        const second = boxes.nodes[b];
        const overlap = first.x < second.x + second.w && second.x < first.x + first.w && first.y < second.y + second.h && second.y < first.y + first.h;
        assert.ok(!overlap, `节点叠压: ${first.id} 与 ${second.id}`);
      }
    }
  };

  /* ---------------- P1 拖入:数据变化 → 条件 → 写入数据 ---------------- */
  const canvas = page.locator(".behavior-editor-body");
  const canvasBox = await canvas.boundingBox();
  assert.ok(canvasBox && canvasBox.height >= 200, "画布不可见或过小");
  const dropPoints = [
    { x: 40, y: 24 },
    { x: 40, y: 122 },
    { x: 40, y: 220 },
  ];
  const paletteChips = ["数据变化", "条件", "写入数据"];
  // headless 下 CDP 原生 HTML5 DnD 对该调色板不稳定;这里以合成 DragEvent 走与真实
  // 拖拽完全相同的 DOM 处理链(onDragStart/setData → onDragOver → onDrop → 落点换算)。
  for (const [index, label] of paletteChips.entries()) {
    if (process.env.G2_DEBUG) {
      console.log("    [debug] pre-drop", index, JSON.stringify(await page.evaluate(() => ({
        transform: document.querySelector(".behavior-editor-body .react-flow__viewport")?.getAttribute("style"),
        bodyTop: document.querySelector(".behavior-editor-body")?.getBoundingClientRect().top,
      }))));
    }
    await page.evaluate(({ entryLabel, point }) => {
      const chip = [...document.querySelectorAll(".behavior-palette-chips > div")].find((el) => el.textContent?.includes(entryLabel));
      if (!chip) throw new Error(`调色板 chip 未找到: ${entryLabel}`);
      const target = document.querySelector(".behavior-editor-body");
      if (!target) throw new Error("画布 .behavior-editor-body 未找到");
      const rect = target.getBoundingClientRect();
      const clientX = rect.left + point.x;
      const clientY = rect.top + point.y;
      const transfer = new DataTransfer();
      const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer };
      chip.dispatchEvent(new DragEvent("dragstart", init));
      target.dispatchEvent(new DragEvent("dragover", { ...init, clientX, clientY }));
      target.dispatchEvent(new DragEvent("drop", { ...init, clientX, clientY }));
      chip.dispatchEvent(new DragEvent("dragend", init));
    }, { entryLabel: label, point: dropPoints[index] });
    await page.waitForFunction((expected) => document.querySelectorAll(".react-flow__node").length === expected, index + 1);
  }
  assert.equal(await page.locator(".react-flow__node").count(), 3, "拖入后应共 3 个节点");
  if (process.env.G2_DEBUG) {
    console.log("    [debug] nodes", JSON.stringify(await page.evaluate(() =>
      [...document.querySelectorAll(".react-flow__node")].map((node) => {
        const rect = node.getBoundingClientRect();
        return { id: node.getAttribute("data-id"), flow: node.style.transform, screen: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } };
      }),
    )));
    console.log("    [debug] viewport", JSON.stringify(await page.evaluate(() => {
      const pane = document.querySelector(".behavior-editor-body .react-flow");
      const body = document.querySelector(".behavior-editor-body");
      return { pane: pane?.getBoundingClientRect().toJSON(), body: body?.getBoundingClientRect().toJSON(), scrollY: window.scrollY };
    })));
  }
  // 收起随新增打开的节点表单,滚动作画布入视口,给连线与截图一个完整画布。
  await page.locator(".behavior-node-form-close").click();
  await canvas.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  // 布局整理:窄画布(约 237×320)下默认落点会互相叠压(round1 根因),等效于用户
  // 手动拖排节点:拉开竖列 + fitView 收纳,再截图。
  await arrangeFlowLayout();
  await ensurePaneInView();
  await shot("p1-drag-in");
  step("p1-drag-in", { nodes: 3 });

  /* ---------------- P2 连线:事件→条件→动作 ---------------- */
  await dragHandleToHandle('.react-flow__node[data-id="data-change-1"] .react-flow__handle.source', '.react-flow__node[data-id="condition-1"] .react-flow__handle.target');
  await dragHandleToHandle('.react-flow__node[data-id="condition-1"] .react-flow__handle.source', '.react-flow__node[data-id="set-value-1"] .react-flow__handle.target');
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__edge").length === 2);
  await ensurePaneInView();
  await page.waitForFunction(() => document.querySelector(".behavior-editor-save")?.getAttribute("data-state") === "ready", undefined, { timeout: 10_000 });
  await shot("p2-connect");
  step("p2-connect", { edges: 2 });

  /* ---------------- P3 改表达式:点条件节点,填真实条件 ---------------- */
  await ensurePaneInView();
  await page.locator('.react-flow__node[data-id="condition-1"] .behavior-graph-card').click();
  const nodeForm = page.locator(".behavior-node-form");
  await nodeForm.waitFor();
  const expressionInput = nodeForm.locator("textarea");
  await expressionInput.fill("values.temperature > 80");
  await page.waitForFunction(() => {
    const output = document.querySelector(".behavior-node-form .behavior-field-error");
    return output === null || !output.textContent?.trim();
  });
  assert.equal(await nodeForm.locator(".behavior-field-error").count(), 0, "合法表达式不应有行内错误");
  await ensurePaneInView();
  await shot("p3-expression");
  step("p3-expression", { expression: "values.temperature > 80" });

  /* ---------------- P4 保存:门禁通过,非法 0 条落库的反向证明 ---------------- */
  const saveButton = editor.locator(".behavior-editor-save");
  await page.waitForFunction(() => document.querySelector(".behavior-editor-save")?.getAttribute("data-state") === "ready");
  await saveButton.click();
  await page.waitForFunction(() => document.querySelector(".behavior-editor-save")?.getAttribute("data-state") === "clean");
  assert.ok((await status.innerText()).includes("校验通过"), "保存后应显示校验通过");
  assert.ok(await saveButton.isDisabled(), "已保存态按钮应禁用");
  await shot("p4-saved");
  // 切到源码 JSON 页签,肉眼可见已提交文档(与图同源)。编辑器按需加载智能服务,
  // 加载态容器内只有提示文案;monaco 挂载后容器带 data-content-fingerprint(含完整值)。
  await page.locator(".interaction-graph-tabs button", { hasText: "源码 JSON" }).click();
  await page.locator(".interaction-advanced .professional-code-editor[data-content-fingerprint], .interaction-advanced .professional-code-fallback textarea").first().waitFor({ timeout: 20_000 });
  await shot("p4b-saved-source");
  await page.locator(".interaction-graph-tabs button", { hasText: "行为图" }).click();
  step("p4-saved", { state: "clean" });

  /* ---------------- P5 非法拦截:非法表达式阻断保存 ---------------- */
  await page.locator('.react-flow__node[data-id="condition-1"] .behavior-graph-card').click();
  await nodeForm.locator("textarea").fill("values.temperature >");
  // 行内错误是 output 元素;表单底部另有汇总条 span 同类名,取 output 避开 strict 冲突。
  await nodeForm.locator("output.behavior-field-error").waitFor();
  const illegalError = await nodeForm.locator("output.behavior-field-error").innerText();
  assert.ok(/第 1 行/.test(illegalError), "行内错误应带行列定位");
  await page.waitForFunction(() => document.querySelector(".behavior-editor-save")?.getAttribute("data-state") === "invalid");
  assert.ok(await saveButton.isDisabled(), "非法草案保存按钮必须禁用");
  await saveButton.click({ force: true, timeout: 2_000 }).catch(() => {}); // 强点也不得写回
  await page.waitForFunction(() => document.querySelector(".behavior-editor-save")?.getAttribute("data-state") === "invalid");
  // 表达式非法走 projection.parseError 分支:状态栏呈现权威失败理由(此时 issue-list 有意隐藏)。
  const statusError = page.locator(".behavior-editor-status .behavior-graph-status-item.is-error");
  assert.ok(await statusError.isVisible(), "状态栏应显示权威校验失败理由");
  assert.ok(/非法/.test(await statusError.innerText()), "权威理由应指明表达式非法");
  await shot("p5-illegal-blocked");
  // 连线非法反馈(重复边):parseError 会短路状态栏的 hover 理由项,先按真实用户路径
  // 修正表达式恢复合法草案,再拖线悬停同目标,红端口 + 状态栏 ✕ 理由,松手不新增边。
  await nodeForm.locator("textarea").fill("values.temperature > 80");
  // 与已保存值相同时草案不 dirty(data-state=clean),校验通过即可,不必等 ready。
  try {
    await page.waitForFunction(() => {
      const state = document.querySelector(".behavior-editor-save")?.getAttribute("data-state");
      return state === "ready" || state === "clean";
    }, undefined, { timeout: 8_000 });
  } catch {
    const diagnostic = await page.evaluate(() => ({
      save: document.querySelector(".behavior-editor-save")?.getAttribute("data-state") ?? null,
      inlineError: document.querySelector(".behavior-node-form .behavior-field-error")?.textContent ?? null,
      status: document.querySelector(".behavior-editor-status")?.textContent?.slice(0, 160) ?? null,
      textarea: document.querySelector(".behavior-node-form textarea")?.value ?? null,
    }));
    throw new Error(`恢复合法表达式后保存门禁未回到 ready:${JSON.stringify(diagnostic)}`);
  }
  await nodeForm.locator(".behavior-node-form-close").click();
  await canvas.scrollIntoViewIfNeeded();
  await ensurePaneInView();
  await page.waitForTimeout(250);
  const sourceHandleBox = await page.locator('.react-flow__node[data-id="condition-1"] .react-flow__handle.source').boundingBox();
  const targetHandleBox = await page.locator('.react-flow__node[data-id="set-value-1"] .react-flow__handle.target').boundingBox();
  assert.ok(sourceHandleBox && targetHandleBox, "重复边探测端点不可见");
  await setOverlayPassthrough(true);
  try {
    await page.mouse.move(sourceHandleBox.x + sourceHandleBox.width / 2, sourceHandleBox.y + sourceHandleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetHandleBox.x + targetHandleBox.width / 2, targetHandleBox.y + targetHandleBox.height / 2, { steps: 14 });
    await page.waitForFunction(() => {
      const item = document.querySelector(".behavior-editor-status .behavior-graph-status-item.is-error");
      return Boolean(item?.textContent?.includes("重复边"));
    });
    // 按住悬停状态下截图,红端口与 ✕ 理由保持可见。screenshot 会诱发一次渲染提交,
    // hover 理由可能瞬时闪断;故每轮微移 1px 主动重建 mouseover,等理由再现后立即拍,
    // 拍后采样状态栏,命中保持瞬间即停(悬停目标是节点级,微移仍在目标节点内)。
    let hoverCaptured = false;
    for (let attempt = 0; attempt < 6 && !hoverCaptured; attempt += 1) {
      await page.mouse.move(targetHandleBox.x + targetHandleBox.width / 2 + attempt, targetHandleBox.y + targetHandleBox.height / 2, { steps: 2 });
      await page.waitForFunction(() => {
        const item = document.querySelector(".behavior-editor-status .behavior-graph-status-item.is-error");
        return Boolean(item?.textContent?.includes("重复边"));
      }, undefined, { timeout: 4_000 });
      // DOM 已更新不等于已上屏:screenshot 捕获的是最近合成帧,先双 rAF 等新帧提交再拍。
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForTimeout(150);
      await shot("p5b-connect-reject-hover");
      hoverCaptured = (await page.evaluate(() => document.querySelector(".behavior-editor-status")?.textContent ?? "")).includes("重复边");
      if (!hoverCaptured && process.env.G2_DEBUG) console.log("    [debug] p5b hover-status retry", attempt);
    }
    const hoverStatus = await page.evaluate(() => document.querySelector(".behavior-editor-status")?.textContent ?? "");
    if (process.env.G2_DEBUG) console.log("    [debug] p5b hover-status", JSON.stringify(hoverStatus.slice(0, 140)));
    assert.ok(hoverCaptured && hoverStatus.includes("重复边"), "拖线悬停截图时刻状态栏必须仍显示重复边理由");
  } finally {
    await page.mouse.up();
    await setOverlayPassthrough(false);
  }
  assert.equal(await page.locator(".react-flow__edge").count(), 2, "非法连线不得新增边");
  step("p5-illegal-blocked", { inlineError: illegalError.trim(), duplicateEdgeBlocked: true });

  assert.deepEqual(pageErrors, [], "全程不得有页面错误");
  report.finishedAt = new Date().toISOString();
  report.passed = true;
  await writeFile(resolve(outputRoot, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\nG2-S2a 视觉门禁 轮次 ${round}:全部路径通过 → ${outputRoot}`);
} catch (error) {
  report.failures.push(String(error?.stack ?? error));
  report.passed = false;
  await page?.screenshot({ path: resolve(outputRoot, "failure.png") }).catch(() => {});
  await writeFile(resolve(outputRoot, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  throw error;
} finally {
  await gate.close();
}
