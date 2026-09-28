// T21 复杂文本与输入矩阵的浏览器验收（非性能门禁；性能门禁见 gate-object-tree-100k.mjs）。
// 真实系统 IME 无法自动化：组合键序列以合成 DOM 事件注入，结论按"合成事件"标注。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { buildVisualQaArtifact, createStaticServer } from "./productBrowserSupport.mjs";

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputRoot = resolve(webRoot, "../../test-output/t21-text-input");
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(resolve(outputRoot, "run-"));
const dist = resolve(output, "dist");
buildVisualQaArtifact({ webRoot, outputRoot: dist });
const server = createStaticServer(dist);
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const report = { browser: browser.version(), viewport: "1280x800 DPR1", checks: {}, screenshots: [] };

// 合成键盘事件：KeyboardEventInit 无法直接带 keyCode，落盘后补 defineProperty（Safari 229 回声模拟）。
const composingEnter = isComposing => `(() => {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: ${isComposing} });
  Object.defineProperty(event, "keyCode", { get: () => ${isComposing ? 229 : 13} });
  return event;
})()`;

try {
  // ---------- 第一部分：复杂文本矩阵（100,000 行规模，矩阵行每 8 行一条） ----------
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(`${origin}/?__visualQa=object-tree&count=100000&mode=objects&windowed=1&theme=dark&text=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector('[data-total-rows]')?.getAttribute("data-total-rows") === "100000", undefined, { timeout: 60_000 });
  // 矩阵样本位于行 index = k*8（k=0..8，对应矩阵第 k 条）。逐条滚动挂载后验证 DOM 完整性。
  const scrollToMatrixRow = async k => {
    await page.evaluate(k => { const list = document.querySelector(".asset-list"); if (list) list.scrollTop = k * 8 * 32; }, k);
    await page.waitForFunction(k => [...document.querySelectorAll("[data-scene-row-key]")]
      .some(row => (row.getAttribute("data-scene-row-key") ?? "").endsWith(`device-${k * 8}`) && (row.textContent ?? "").length > 0),
    k, { timeout: 15_000 });
  };
  const sampleProbes = [
    { id: "arabic-rtl", marker: "مضخة" }, { id: "hebrew-rtl", marker: "משאבה" },
    { id: "thai-combining", marker: "ปั๊มน้ำอุตสาหกรรม" }, { id: "korean-nfd", marker: "페프가" },
    { id: "emoji-zwj", marker: "👨‍👩‍👧‍👦" }, { id: "surrogate-pair", marker: "𠀀" },
    { id: "mixed-bidi", marker: "חיפוש" }, { id: "long-unbroken", marker: "320MM-STAINLESS-STEEL" },
  ];
  report.checks.textMatrix = { renderedRowsMountedPerStop: [], rowHeights: [], probes: [], arabicBidi: null };
  for (const [k, probe] of sampleProbes.entries()) {
    await scrollToMatrixRow(k + 1);
    const probeResult = await page.evaluate(marker => {
      const rows = [...document.querySelectorAll("[data-scene-row-key]")];
      const directoryText = document.querySelector(".scene-object-directory")?.textContent ?? "";
      const arabicRow = rows.find(row => row.textContent?.includes("مضخة"));
      const arabicStrong = arabicRow?.querySelector(".asset-copy strong");
      return {
        mountedRows: rows.length,
        rowHeights: [...new Set(rows.map(row => Math.round(row.getBoundingClientRect().height)))],
        found: directoryText.includes(marker),
        arabicBidi: arabicStrong ? getComputedStyle(arabicStrong).unicodeBidi : null,
      };
    }, probe.marker);
    report.checks.textMatrix.renderedRowsMountedPerStop.push(probeResult.mountedRows);
    report.checks.textMatrix.rowHeights.push(...probeResult.rowHeights);
    report.checks.textMatrix.arabicBidi = probeResult.arabicBidi ?? report.checks.textMatrix.arabicBidi;
    assert.ok(probeResult.found, `矩阵样本 ${probe.id}（${probe.marker.slice(0, 12)}…）滚动挂载后在 DOM 中不完整`);
    assert.ok(probeResult.mountedRows <= 30, `滚动后挂载 ${probeResult.mountedRows} 行`);
    report.checks.textMatrix.probes.push({ id: probe.id, found: probeResult.found, mountedRows: probeResult.mountedRows });
  }
  await scrollToMatrixRow(1);
  const headRows = await page.evaluate(() => [...document.querySelectorAll(".asset-row")].map(row => Math.round(row.getBoundingClientRect().height)));
  report.checks.textMatrix.uniformRowHeight = [...new Set(headRows)];
  assert.deepEqual(report.checks.textMatrix.uniformRowHeight, [32], `行高不统一：${report.checks.textMatrix.uniformRowHeight}`);
  assert.equal(report.checks.textMatrix.arabicBidi, "plaintext", "阿拉伯语行名未启用 plaintext bidi");
  report.checks.textMatrix.panelNoHorizontalOverflow = await page.evaluate(() => {
    const panel = document.querySelector(".object-tree-qa-panel");
    return panel ? panel.scrollWidth <= panel.clientWidth + 1 : null;
  });
  assert.ok(report.checks.textMatrix.panelNoHorizontalOverflow, "面板出现横向溢出");
  await page.screenshot({ path: resolve(output, "text-matrix-100k-dark-1280.png") });
  report.screenshots.push("text-matrix-100k-dark-1280.png");

  // 视觉证据：韩文分解字母（行 24）、emoji ZWJ（行 32）、代理对（行 40）同屏。
  await scrollToMatrixRow(3);
  await page.waitForFunction(() => ["24", "32", "40"].every(suffix => [...document.querySelectorAll("[data-scene-row-key]")]
    .some(row => (row.getAttribute("data-scene-row-key") ?? "").endsWith(`device-${suffix}`))), undefined, { timeout: 15_000 });
  const exoticVisible = await page.evaluate(() => {
    const text = document.querySelector(".scene-object-directory")?.textContent ?? "";
    return { korean: text.includes("페프가"), emoji: text.includes("👨‍👩‍👧‍👦"), surrogate: text.includes("𠀀") };
  });
  report.checks.exoticRowsInViewport = exoticVisible;
  assert.ok(exoticVisible.korean && exoticVisible.emoji && exoticVisible.surrogate, "韩文/emoji/代理对行未同屏");
  await page.screenshot({ path: resolve(output, "text-matrix-exotic-rows-1280.png") });
  report.screenshots.push("text-matrix-exotic-rows-1280.png");

  // 长无空格串截断测量（k=7 → 行 56）。
  await scrollToMatrixRow(7);
  report.checks.longRowTruncated = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".asset-row")].find(candidate => (candidate.textContent ?? "").length > 200);
    const strong = row?.querySelector(".asset-copy strong");
    return strong ? { scrollWidth: strong.scrollWidth, clientWidth: strong.clientWidth, ellipsed: strong.scrollWidth > strong.clientWidth } : null;
  });
  assert.ok(report.checks.longRowTruncated?.ellipsed, "长无空格串未截断");

  // 选中长串行：选择高亮不破版（行高不变、无横向溢出）。
  const longText = "P4500-CENTRIFUGAL-PUMP-IMPELLER-DIAMETER-";
  await page.getByRole("button", { name: new RegExp(longText.replace(/[-]/g, "\\-")) }).first().click();
  await page.waitForTimeout(120);
  report.checks.longRowSelection = await page.evaluate(text => {
    const row = [...document.querySelectorAll(".asset-row")].find(candidate => candidate.textContent?.includes(text));
    const directory = document.querySelector(".scene-object-directory");
    return {
      selectedClass: row?.className.includes("selected") ?? false,
      height: row ? Math.round(row.getBoundingClientRect().height) : null,
      directoryOverflow: directory ? directory.scrollWidth <= directory.clientWidth + 1 : null,
    };
  }, longText);
  assert.ok(report.checks.longRowSelection.selectedClass, "长串行未进入选中态");
  assert.ok(report.checks.longRowSelection.directoryOverflow, "选中后目录出现横向溢出");
  await page.screenshot({ path: resolve(output, "text-matrix-longrow-selected-1280.png") });
  report.screenshots.push("text-matrix-longrow-selected-1280.png");
  await page.close();

  // 480 浅色响应式（矩阵文本）。
  const mobile = await browser.newPage({ viewport: { width: 480, height: 800 }, deviceScaleFactor: 1 });
  await mobile.goto(`${origin}/?__visualQa=object-tree&count=1000&mode=objects&windowed=1&theme=light&text=1`, { waitUntil: "domcontentloaded" });
  await mobile.waitForFunction(() => document.querySelector('[data-total-rows]')?.getAttribute("data-total-rows") === "1000", undefined, { timeout: 30_000 });
  report.checks.mobile = await mobile.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, theme: document.documentElement.dataset.theme }));
  assert.ok(report.checks.mobile.scrollWidth <= report.checks.mobile.viewportWidth, "480 px 页面出现横向溢出");
  await mobile.screenshot({ path: resolve(output, "text-matrix-light-480.png") });
  report.screenshots.push("text-matrix-light-480.png");
  await mobile.close();

  // ---------- 第二部分：输入矩阵（真实 OptimizerLayerTree 行内重命名 + 合成 IME 序列） ----------
  const input = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await input.goto(`${origin}/?__visualQa=object-tree&count=1000&mode=objects&windowed=1&theme=dark&text=1&input=1`, { waitUntil: "domcontentloaded" });
  await input.waitForFunction(() => Boolean(document.querySelector('[aria-label="行内输入验收"]')), undefined, { timeout: 30_000 });
  const section = '[aria-label="行内输入验收"]';
  await input.locator(`${section} .optimizer-layer-row__name`).first().dblclick();
  await input.waitForSelector(`${section} .optimizer-layer-row input`);
  report.checks.renameFocus = await input.evaluate(scope => ({
    focusedIsInput: document.activeElement?.tagName === "INPUT",
    withinSection: Boolean(document.activeElement?.closest(scope)),
    value: document.activeElement instanceof HTMLInputElement ? document.activeElement.value.slice(0, 40) : null,
  }), section);
  assert.ok(report.checks.renameFocus.focusedIsInput && report.checks.renameFocus.withinSection, "双击后重命名输入未获得焦点");

  // 滚动不丢焦点：行内 input 聚焦时滚动容器（keepMounted + focusedKey 双保险）。
  await input.evaluate(scope => {
    const tree = document.querySelector(`${scope} [role=tree]`);
    if (tree) tree.scrollTop = tree.scrollHeight;
  }, section);
  await input.waitForTimeout(150);
  report.checks.focusAfterScroll = await input.evaluate(scope => ({
    stillFocused: document.activeElement?.tagName === "INPUT" && Boolean(document.activeElement?.closest(scope)),
    scrollTop: document.querySelector(`${scope} [role=tree]`)?.scrollTop ?? 0,
  }), section);
  assert.ok(report.checks.focusAfterScroll.stillFocused, "滚动后重命名输入丢失焦点");

  // 合成 IME：compositionstart → isComposing Enter（229）不提交 → insertText 注入文本 → compositionend → Enter 提交。
  const layerText = await input.locator(`${section} .optimizer-layer-row`).first().textContent();
  await input.evaluate(scope => {
    const target = document.querySelector(`${scope} .optimizer-layer-row input`);
    target?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
  }, section);
  await input.keyboard.insertText("离心泵检修单元");
  await input.evaluate((payload) => {
    const target = document.querySelector(`${payload.scope} .optimizer-layer-row input`);
    target?.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: payload.data }));
    target?.dispatchEvent(new Function("return " + payload.enter)());
    target?.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: payload.data }));
  }, { scope: section, data: "离心泵检修单元", enter: composingEnter(true) });
  await input.waitForTimeout(100);
  report.checks.imeEnterGuard = await input.evaluate(scope => ({
    stillRenaming: Boolean(document.querySelector(`${scope} .optimizer-layer-row input`)),
    value: document.querySelector(`${scope} .optimizer-layer-row input`) instanceof HTMLInputElement
      ? document.querySelector(`${scope} .optimizer-layer-row input`).value : null,
  }), section);
  assert.ok(report.checks.imeEnterGuard.stillRenaming, "组合中的 Enter 泄漏为提交：重命名被提前结束");
  await input.screenshot({ path: resolve(output, "ime-composing-state-1280.png") });
  report.screenshots.push("ime-composing-state-1280.png");

  await input.evaluate((payload) => {
    const target = document.querySelector(`${payload.scope} .optimizer-layer-row input`);
    target?.dispatchEvent(new Function("return " + payload.enter)());
  }, { scope: section, enter: composingEnter(false) });
  await input.waitForTimeout(100);
  report.checks.imeCommit = await input.evaluate(scope => ({
    inputClosed: !document.querySelector(`${scope} .optimizer-layer-row input`),
    renamed: document.querySelector(`${scope} .optimizer-layer-row`)?.textContent?.includes("离心泵检修单元") ?? false,
  }), section);
  assert.ok(report.checks.imeCommit.inputClosed && report.checks.imeCommit.renamed, "组合结束后 Enter 未提交重命名");

  // Safari 229 回声（isComposing=false、keyCode=229）不得触发 Escape 取消/重复提交：仅验证 Enter 分支不再命中。
  await input.locator(`${section} .optimizer-layer-row__name`).nth(1).dblclick();
  await input.waitForSelector(`${section} .optimizer-layer-row input`);
  await input.evaluate((payload) => {
    const target = document.querySelector(`${payload.scope} .optimizer-layer-row input`);
    target?.dispatchEvent(new Function("return " + payload.escape)());
  }, { scope: section, escape: `(() => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true });
    Object.defineProperty(event, "keyCode", { get: () => 229 });
    return event;
  })()` });
  await input.waitForTimeout(100);
  report.checks.imeEscapeGuard = await input.evaluate(scope => ({
    stillRenaming: Boolean(document.querySelector(`${scope} .optimizer-layer-row input`)),
  }), section);
  assert.ok(report.checks.imeEscapeGuard.stillRenaming, "组合中的 Escape 泄漏为取消重命名");
  await input.screenshot({ path: resolve(output, "input-matrix-rename-1280.png") });
  report.screenshots.push("input-matrix-rename-1280.png");
  await input.close();
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  throw error;
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
  writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, report }, null, 2));
}
