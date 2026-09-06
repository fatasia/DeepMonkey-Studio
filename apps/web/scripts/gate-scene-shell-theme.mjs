import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";
import { importGripper, prepareReviewedGripper, sha256 } from "./gateCameraFramingSupport.mjs";

const accent = process.env.SCENE_SHELL_ACCENT;
assert.ok(!accent || /^#[\da-f]{6}$/i.test(accent));
const gate = await createIsolatedStudioGate("scene-shell-theme");
const report = { createdAt: new Date().toISOString(), accent: accent ?? "default", cases: [] };
console.log(JSON.stringify({ output: gate.output }));

async function createScene(page, projectId) {
  await gate.loginPage(page);
  await page.goto(`${gate.origin}/manager?project=${projectId}`);
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("资产目录与编辑模式验收");
  const created = page.waitForResponse(response => response.url().endsWith(`/api/projects/${projectId}/applications`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "创建并进入", exact: true }).click();
  const response = await created; assert.equal(response.status(), 201);
  const application = await response.json();
  const scenePath = `${gate.origin}/studio/${projectId}/applications/${application.metadata.id}/scenes/${application.scenes[0].id}`;
  const dashboardPath = `${gate.origin}/studio/${projectId}/applications/${application.metadata.id}/pages/${application.pages[0].id}`;
  // 从实际二维入口进入，让产品保存返回上下文；直接 goto 三维 URL 不等于二维往返。
  await page.goto(dashboardPath); await page.locator(".dashboard-workspace").waitFor();
  await page.getByRole("button", { name: "三维", exact: true }).click();
  await page.waitForURL(scenePath); await page.locator(".viewport canvas").waitFor();
  const autoSave = page.getByLabel("自动保存"); if (await autoSave.isChecked()) await autoSave.uncheck();
  return { application, scenePath };
}

async function inspectRow(page, tree, shot, entry) {
  const row = tree.locator(".asset-row");
  await row.hover();
  const pause = tree.getByRole("button", { name: "暂停模型动画", exact: true });
  if (await pause.count()) await pause.click();
  await page.getByLabel("搜索构件", { exact: true }).click();
  await page.locator(".viewport canvas").hover();
  const title = tree.locator(".asset-copy strong");
  entry.idle = await title.evaluate(node => ({ text: node.textContent, width: node.clientWidth, contentWidth: node.scrollWidth, controlWidth: node.closest("button").clientWidth, fullName: node.title }));
  assert.ok(entry.idle.controlWidth >= 100 && entry.idle.width >= Math.min(entry.idle.contentWidth, 90), `Idle asset title must not collapse to one character: ${JSON.stringify(entry.idle)}`);
  assert.equal(entry.idle.fullName, entry.idle.text);
  const optional = row.locator(".scene-row-optional-action:not(.active):not(.colliding)");
  assert.ok(await optional.count() >= 3);
  for (const button of await optional.all()) assert.equal(await button.isVisible(), false);
  await shot("idle-assets");
  await row.hover();
  for (const button of await optional.all()) assert.equal(await button.isVisible(), true);
  entry.hover = await row.evaluate(root => {
    const bounds = root.getBoundingClientRect();
    return { height: bounds.height, title: [...root.querySelectorAll(".asset-main, .asset-copy, .asset-copy strong")].map(node => ({ className: node.className, width: node.clientWidth, minWidth: getComputedStyle(node).minWidth, flex: getComputedStyle(node).flex })), actionsContained: [...root.querySelectorAll("button")].every(button => {
      const box = button.getBoundingClientRect();
      return box.left >= bounds.left && box.right <= bounds.right + 1 && box.top >= bounds.top && box.bottom <= bounds.bottom + 1;
    }) };
  });
  assert.ok(entry.hover.actionsContained);
  await shot("hover-actions");
  await page.locator(".viewport canvas").hover();
  await row.locator(".asset-main").focus();
  for (const button of await optional.all()) assert.equal(await button.isVisible(), true);
  const focusNames = [];
  for (let index = 0; index < 7; index++) {
    await page.keyboard.press("Tab");
    focusNames.push(await row.evaluate(() => document.activeElement?.getAttribute("aria-label")));
  }
  entry.keyboardActions = focusNames;
  entry.keyboardFocus = await row.evaluate(() => {
    const active = document.activeElement, style = getComputedStyle(active);
    return { outline: style.outline, color: style.outlineColor, accent: style.getPropertyValue("--accent").trim(), shadow: style.boxShadow };
  });
  const focusAccent = entry.keyboardFocus.accent.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  assert.ok(focusAccent, "Test branding exposes a six-digit accent");
  assert.equal(entry.keyboardFocus.color, `rgb(${focusAccent.slice(1).map(channel => parseInt(channel, 16)).join(", ")})`);
  for (const expected of ["隐藏", "锁定模型", "开启碰撞检测", "播放模型动画", "移除实例"]) assert.ok(focusNames.includes(expected), `${expected} is not keyboard reachable`);
  assert.ok(focusNames.some(name => name?.startsWith("管理模型实例 ")), "Instance actions are keyboard reachable");
  await shot("keyboard-actions");
  const lock = tree.getByRole("button", { name: "锁定模型", exact: true });
  await lock.click(); await tree.getByRole("button", { name: "解锁模型", exact: true }).click();
  await tree.getByRole("button", { name: "隐藏", exact: true }).click();
  await tree.getByRole("button", { name: "显示", exact: true }).click();
}

async function inspectDashboardPrimary(page, shot, entry) {
  const actions = page.locator(".dashboard-workspace-actions");
  const primary = actions.getByRole("button", { name: "发布", exact: true });
  assert.equal(await primary.isDisabled(), false);
  await page.locator(".dashboard-scene-viewport").hover();
  entry.dashboardPrimary = {};
  for (const state of ["idle", "hover"]) {
    if (state === "hover") await primary.hover();
    const sample = await primary.evaluate(button => {
      const style = getComputedStyle(button);
      return { color: style.color, background: style.backgroundColor, image: style.backgroundImage,
        accent: style.getPropertyValue("--accent").trim(), foregroundToken: style.getPropertyValue("--on-accent").trim(), hovered: button.matches(":hover") };
    });
    const contrast = await actions.evaluate(collectTextContrast, "button.primary");
    entry.dashboardPrimary[state] = { ...sample, contrast };
    assert.equal(sample.hovered, state === "hover");
    assert.equal(sample.accent, entry.keyboardFocus.accent, "2D navigation must preserve the active brand");
    const channels = sample.accent.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
    assert.ok(channels);
    assert.equal(sample.background, `rgb(${channels.slice(1).map(channel => parseInt(channel, 16)).join(", ")})`);
    assert.equal(sample.image, "none", "Primary CTA must not retain a legacy gradient over its brand color");
    assert.equal(contrast.length, 1);
    assert.ok(contrast[0].contrast >= 4.5, `${state} primary contrast: ${JSON.stringify(contrast)}`);
    await shot(`2d-primary-${state}`);
  }
}

async function runCase(theme, width) {
  const entry = { theme, width, errors: [], driverWarnings: [] }; report.cases.push(entry);
  const context = await gate.browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
  await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme, ...(accent ? { primaryColor: accent } : {}) } }); });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  entry.requests = [];
  page.on("response", response => {
    if (response.url().includes("/applications/") && response.request().method() === "PUT") entry.requests.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  page.on("pageerror", error => entry.errors.push(error.message));
  page.on("console", message => {
    if (!["warning", "error"].includes(message.type())) return;
    if (/^THREE\.WebGLProgram: Program Info Log:/.test(message.text()) && /warning X4122: sum of/.test(message.text()) && !/error/i.test(message.text())) entry.driverWarnings.push(message.text());
    else entry.errors.push(message.text());
  });
  const shot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`) });
  try {
    const project = await gate.json("POST", "/api/projects", { name: `资产目录-${theme}-${width}` });
    const source = await importGripper(gate, project.id, page);
    const { application, scenePath } = await createScene(page, project.id);
    if (!await page.locator(".model-tree-item").count()) await page.getByRole("button", { name: "场景图层与编组", exact: true }).click();
    const tree = page.locator(`.model-tree-item[data-model-id="${source.id}"]`);
    await tree.locator(".asset-main").click(); await tree.getByRole("button", { name: "隐藏", exact: true }).waitFor();
    await inspectRow(page, tree, shot, entry);
    await tree.getByRole("button", { name: "展开模型结构", exact: true }).click();
    await tree.locator(".layer-node").first().waitFor(); await shot("model-structure");
    entry.contrast = await page.locator(".app-shell").evaluate(collectTextContrast, ".asset-copy strong, .layer-node-main span, .component-search-input input, .workspace-mode-switch button.active, .workspace-mode-switch button:not(:disabled), .topbar-back, .scene-title-wrap input, .topbar-save-action");
    assert.deepEqual(entry.contrast.filter(item => item.contrast < 4.5), []);
    entry.minimumContrast = Math.min(...entry.contrast.map(item => item.contrast));
    const search = page.getByLabel("搜索构件", { exact: true });
    await search.fill("无此构件验证"); assert.equal(await search.inputValue(), "无此构件验证");
    await page.getByRole("button", { name: "清空搜索", exact: true }).click(); assert.equal(await search.inputValue(), "");
    await page.getByRole("button", { name: "场景图层与编组", exact: true }).click();
    const sceneSearch = page.getByLabel("搜索场景元素", { exact: true });
    await sceneSearch.fill("平行"); assert.equal(await sceneSearch.inputValue(), "平行");
    entry.organizationContrast = await page.locator(".scene-tree-manager").evaluate(collectTextContrast, ".scene-organization-search input, .scene-tree-selection-bar > span, .scene-tree-selection-bar strong");
    assert.deepEqual(entry.organizationContrast.filter(item => item.contrast < 4.5), []);
    entry.selectionBar = await page.locator(".scene-tree-selection-bar").evaluate(root => {
      const count = root.querySelector(".scene-selection-count");
      const bounds = root.getBoundingClientRect();
      return { count: count.textContent, countHeight: count.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(count).lineHeight),
        actionsContained: [...root.querySelectorAll("button")].every(button => { const box = button.getBoundingClientRect(); return box.left >= bounds.left && box.right <= bounds.right + 1 && box.bottom <= bounds.bottom + 1; }) };
    });
    assert.ok(entry.selectionBar.countHeight <= entry.selectionBar.lineHeight + 1, "Selection count stays on one line");
    assert.ok(entry.selectionBar.actionsContained, "Selection actions remain within their toolbar");
    await shot("organization-search");
    await page.getByRole("button", { name: "清空搜索", exact: true }).click(); assert.equal(await sceneSearch.inputValue(), "");
    await page.getByRole("button", { name: "场景图层与编组", exact: true }).click();
    const appPath = `/api/projects/${project.id}/applications/${application.metadata.id}`;
    const saved = page.waitForResponse(response => response.url().endsWith(`${appPath}/workspace`) && response.request().method() === "PUT");
    await page.getByRole("button", { name: "保存项目", exact: true }).click(); assert.equal((await saved).status(), 200);
    await page.getByText("项目“资产目录与编辑模式验收”已保存", { exact: true }).waitFor();
    const beforeReturn = await gate.json("GET", appPath);
    const expectedScene = beforeReturn.scenes.find(scene => scene.id === application.scenes[0].id);
    assert.deepEqual(expectedScene.models.map(model => model.modelId), [source.id]);
    entry.modelBeforeReturn = expectedScene.models.map(model => model.modelId);
    const switch2d = page.getByRole("button", { name: "二维", exact: true });
    entry.modeBefore = { url: page.url(), disabled: await switch2d.isDisabled(), requests: entry.requests.length };
    await switch2d.click();
    try { await page.locator(".dashboard-workspace").waitFor({ timeout: 3000 }); }
    catch {
      entry.modeClickFailure = { url: page.url(), disabled: await switch2d.isDisabled(), requests: entry.requests.length, active: await page.locator("body").evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent })) };
      await switch2d.focus(); await page.keyboard.press("Enter");
      await page.locator(".dashboard-workspace").waitFor({ timeout: 5000 });
      entry.modeKeyboardRecovery = true;
    }
    await page.locator(".dashboard-scene-viewport .scene-viewport-preview.ready canvas").waitFor();
    const in2d = await gate.json("GET", appPath);
    const linkedScene = in2d.scenes.find(scene => scene.id === expectedScene.id);
    assert.deepEqual(linkedScene.models, expectedScene.models, "2D return must preserve the imported model state");
    assert.ok(in2d.pages.some(page => page.nodes.some(node => node.kind === "scene-viewport" && node.sceneId === linkedScene.id)));
    entry.modePersistedModelIds = linkedScene.models.map(model => model.modelId);
    entry.modeViewportRefs = in2d.pages.flatMap(page => page.nodes.filter(node => node.kind === "scene-viewport").map(node => node.sceneId));
    entry.embeddedSummary = await page.locator(".dashboard-scene-summary").innerText();
    await page.locator(".dashboard-scene-summary").getByText("1 个场景对象", { exact: true }).waitFor({ timeout: 5000 });
    await shot("2d-model-preserved");
    await inspectDashboardPrimary(page, shot, entry);
    await page.getByRole("button", { name: "三维", exact: true }).click(); await page.locator(".viewport canvas").waitFor();
    await tree.getByRole("button", { name: "隐藏", exact: true }).waitFor();
    assert.deepEqual((await gate.json("GET", appPath)).scenes.find(scene => scene.id === expectedScene.id).models, expectedScene.models);
    assert.equal(page.url(), scenePath); await shot("mode-roundtrip");
    assert.ok(!entry.modeClickFailure, "2D mode must respond to pointer, not require keyboard recovery");
    assert.ok(entry.hover.title[0].width >= 100, "Expanded actions must preserve the model name button width");
    assert.equal(sha256(await (await gate.client.get(source.sourceUrl)).body()), report.source.hash);
    assert.deepEqual(entry.errors, []); entry.passed = true;
  } catch (error) { entry.failure = String(error); entry.finalUrl = page.url(); entry.visibleUi = await page.locator("body").innerText(); await shot("failure"); }
  finally { await context.close(); console.log(JSON.stringify({ theme, width, passed: entry.passed, failure: entry.failure, minimumContrast: entry.minimumContrast })); }
}

try {
  report.source = await prepareReviewedGripper(gate);
  for (const theme of ["light", "dark"]) for (const width of [1280, 980]) {
    if (!process.env.SCENE_SHELL_CASE || process.env.SCENE_SHELL_CASE === `${theme}-${width}`) await runCase(theme, width);
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
assert.ok(report.cases.every(item => item.passed), `Inspect ${gate.output}`);
