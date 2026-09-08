import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createScene, observeDiagnostics, themeContext } from "./gateModelInstancesSupport.mjs";

// 已知用户反馈六项修复的浏览器门禁：
// 1) 顶栏“更多”弹层在 >1500px 视口可点开且可命中（overflow 裁剪回归）
// 2) 二级页 tab 栏高度 ≥40px（vision/operations），面板级 ≥32px
// 3) 资源页 2D 缩略图呈现多样图形语义（不再全是指标卡）
// 4) 优化器页控件字号 ≥11px、流水线三态、空态拖放区存在
// 5) 发布弹窗云渲染不可用时显示可见原因行
// 6) 3D 视口在连续 resize 期间无空白帧（分屏拖动同机制，screencast 帧长判定）
const gate = await createIsolatedStudioGate("known-issues-fixes");
const report = { cases: [] };
const entry = (name, data) => { const item = { name, ...data }; report.cases.push(item); return item; };
try {
  const context = await themeContext(gate, "dark", 1920);
  const page = await context.newPage();
  const diagnostics = { errors: [], driverWarnings: [], expectedNetworkErrors: [] };
  observeDiagnostics(page, diagnostics);
  const project = await gate.json("POST", "/api/projects", { name: "已知问题修复验证" });
  // createScene 内部完成登录（loginPage 不能重复调用：已登录状态找不到登录表单）。
  const { scenePath } = await createScene(gate, page, project.id);

  // ---- 1) 更多菜单（1920 宽，历史补丁只覆盖 ≤1500px 的区间）----
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto(scenePath);
  await page.locator(".topbar").waitFor();
  await page.evaluate(() => document.fonts.ready);
  const moreSummary = page.locator(".scene-workspace-more > summary");
  await moreSummary.click();
  await page.waitForTimeout(150);
  const menu = await page.evaluate(() => {
    const details = document.querySelector(".scene-workspace-more");
    const popover = details?.querySelector(".scene-workspace-more-popover");
    if (!details || !popover) return { found: false };
    const rect = popover.getBoundingClientRect();
    const sample = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(18, Math.max(4, rect.height / 2)));
    return { found: true, open: details.open, visible: rect.width > 0 && rect.height > 0, fullyOnScreen: rect.bottom <= innerHeight, hitInside: Boolean(sample && (popover.contains(sample) || sample === popover)) };
  });
  assert.equal(menu.found, true, "更多菜单不存在");
  assert.equal(menu.open, true, "更多菜单未展开");
  assert.equal(menu.visible, true, "更多弹层不可见");
  assert.equal(menu.hitInside, true, "弹层中心点未命中菜单（被裁剪）");
  entry("more-menu-1920", { ...menu, passed: true });
  await page.screenshot({ path: resolve(gate.output, "more-menu-1920.png") });
  await page.keyboard.press("Escape");

  // ---- 2) vision / operations tab 高度 ----
  for (const [name, url, selector] of [
    ["vision", `${gate.origin}/vision`, ".vision-tabs button"],
    ["operations", `${gate.origin}/operations`, ".vision-tabs.operations-tabs button"],
  ]) {
    await page.goto(url);
    await page.locator(selector).first().waitFor();
    const heights = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((button) => button.getBoundingClientRect().height), selector);
    assert.ok(heights.length > 0, `${name} tab 不存在`);
    assert.ok(heights.every((h) => h >= 39), `${name} tab 高度不足: ${heights}`);
    entry(`tab-height-${name}`, { min: Math.min(...heights), passed: true });
    await page.screenshot({ path: resolve(gate.output, `tab-${name}.png`) });
  }

  // ---- 3) 资源页 2D 缩略图多样性 ----
  await page.goto(`${gate.origin}/manager?tab=assets`);
  await page.getByRole("button", { name: /^二维资源/ }).click();
  await page.locator(".built-in-assets-grid .built-in-asset-card").first().waitFor();
  const preview = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".built-in-assets-grid .built-in-asset-card")];
    const shapes = new Set();
    const variants = new Set();
    for (const card of cards) {
      const node = card.querySelector(".dashboard-library-preview");
      if (!node) continue;
      node.classList.forEach((cls) => { if (cls !== "dashboard-library-preview") shapes.add(cls); });
      if (node.dataset.previewVariant) variants.add(node.dataset.previewVariant);
    }
    return { cards: cards.length, shapes: [...shapes], variants: [...variants] };
  });
  assert.ok(preview.cards >= 12, `首页卡片过少: ${preview.cards}`);
  assert.ok(preview.shapes.length > 3, `预览图形语义单一: ${preview.shapes}`);
  entry("asset-thumbnails", { ...preview, passed: true });
  await page.screenshot({ path: resolve(gate.output, "asset-thumbnails.png") });

  // ---- 4) 优化器页：字号基线 + 空态拖放区 ----
  await page.goto(`${gate.origin}/optimizer?project=${project.id}`);
  await page.locator(".optimizer-page").waitFor();
  await page.evaluate(() => document.fonts.ready);
  const optimizer = await page.evaluate(() => {
    const small = [];
    for (const button of document.querySelectorAll(".optimizer-page button")) {
      const size = parseFloat(getComputedStyle(button).fontSize);
      if (size < 11) small.push({ text: button.textContent?.trim().slice(0, 16), size });
    }
    const steps = [...document.querySelectorAll(".optimizer-pipeline-steps span")].map((node) => node.className);
    return { smallButtons: small, dropZone: Boolean(document.querySelector(".optimizer-drop")), pipelineSteps: steps };
  });
  assert.equal(optimizer.smallButtons.length, 0, `仍有过小按钮: ${JSON.stringify(optimizer.smallButtons)}`);
  assert.equal(optimizer.dropZone, true, "空态缺少导入区");
  entry("optimizer-page", { ...optimizer, passed: true });
  await page.screenshot({ path: resolve(gate.output, "optimizer-empty.png") });

  // ---- 5) 发布弹窗：云渲染不可用时的可见原因 ----
  // 场景管理卡走同一 ScenePublicationDialog，且其 cloudConfigured 来自 admin overview。
  await page.goto(`${gate.origin}/manager?project=${project.id}`);
  const card = page.locator(".scene-card, .manager-scene-card").first();
  await card.waitFor();
  await card.hover();
  await page.getByRole("button", { name: "发布场景", exact: true }).first().click();
  await page.locator(".publication-dialog").waitFor();
  const cloudCard = page.getByRole("button", { name: "云渲染", exact: true });
  await cloudCard.click();
  await page.waitForTimeout(120);
  const hint = await page.evaluate(() => {
    const node = document.querySelector(".publication-cloud-hint");
    if (!node) return { present: false };
    const rect = node.getBoundingClientRect();
    return { present: true, visible: rect.height > 0, text: node.textContent?.trim().slice(0, 40) };
  });
  assert.equal(hint.present, true, "云渲染提示行未渲染");
  assert.equal(hint.visible, true, "云渲染提示行不可见");
  const publishDisabled = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll(".publication-dialog .dialog-actions button")];
    return buttons.at(-1)?.disabled === true;
  });
  assert.equal(publishDisabled, true, "云渲染未配置时发布按钮应禁用");
  entry("cloud-hint", { ...hint, publishDisabled, passed: true });
  await page.screenshot({ path: resolve(gate.output, "publication-cloud-hint.png") });
  await page.keyboard.press("Escape");

  // ---- 6) 连续 resize 期间 3D 视口无空白帧（与分屏拖动同一 resize→渲染链路）----
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.waitForTimeout(400);
  const cdp = await context.newCDPSession(page);
  const frames = [];
  await cdp.send("Page.startScreencast", { format: "jpeg", everyNthFrame: 1, maxWidth: 960, maxHeight: 540 });
  cdp.on("Page.screencastFrame", (frame) => {
    frames.push({ length: frame.data.length, ts: Date.now() });
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });
  for (let step = 0; step <= 12; step += 1) {
    const width = 1680 + step * 20; // 1680→1920 连续变化，模拟拖动分隔条时 3D 视口的每帧尺寸变化
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(45);
  }
  await page.waitForTimeout(400);
  await cdp.send("Page.stopScreencast").catch(() => {});
  // 3D 场景有深色渐变地面与网格：空白帧（纯背景清理帧）压缩后极小。
  const meaningful = frames.filter((frame) => frame.length > 6000);
  const blankDuringResize = frames.slice(0, -2).filter((frame) => frame.length <= 6000);
  assert.ok(meaningful.length >= 5, `screencast 帧过少: ${frames.length}`);
  assert.equal(blankDuringResize.length, 0, `resize 期间出现空白帧: ${JSON.stringify(frames.map((f) => f.length))}`);
  entry("viewport-resize-frames", { frames: frames.length, minLength: Math.min(...frames.map((f) => f.length)), passed: true });

  assert.deepEqual(diagnostics.errors, [], `页面错误: ${JSON.stringify(diagnostics.errors)}`);
  await context.close();
} finally {
  await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2));
  await gate.close();
}
assert.ok(report.cases.length >= 6);
assert.ok(report.cases.every((item) => item.passed));
console.log(JSON.stringify({ passed: report.cases.length, output: gate.output }));
