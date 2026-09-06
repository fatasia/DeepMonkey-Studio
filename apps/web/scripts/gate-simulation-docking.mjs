import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";

// Candidate CSS preflight is explicitly separate from frozen-production acceptance.
const preflight = process.env.SIM_LAYOUT_CSS_PREFLIGHT === "1";
const candidateCss = preflight ? await readFile(new URL("../src/styles/sceneSimulationPanel.css", import.meta.url), "utf8") : undefined;
const gate = await createIsolatedStudioGate(preflight ? "simulation-docking-preflight" : "simulation-docking");
const report = { createdAt: new Date().toISOString(), mode: preflight ? "source-CSS-preflight-not-production" : "frozen-production", cases: [] };

async function fixture(label) {
  const project = await gate.json("POST", "/api/projects", { name: `停靠隔离验证 ${label}` });
  const now = new Date().toISOString();
  const scene = { id: randomUUID(), name: "仿真停靠工位", camera: { position: { x: 8, y: 6, z: 8 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" }, models: [],
    primitives: [{ modelId: "station", name: "装配工位", kind: "box", color: "#83a6ac", visible: true, opacity: 1, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } } }], measurements: [] };
  await gate.json("PUT", `/api/projects/${project.id}/scenes/${scene.id}`, { ...scene, schemaVersion: 1, projectId: project.id, createdAt: now, updatedAt: now });
  const application = await gate.json("POST", `/api/projects/${project.id}/applications`, {
    schemaVersion: 2, metadata: { id: randomUUID(), projectId: project.id, name: "布局验证", revision: 1, createdAt: now, updatedAt: now },
    pages: [{ id: "page", name: "概览", width: 1920, height: 1080, viewportFit: "contain", nodes: [] }], scenes: [scene], topologies: [], geo: { providerIds: [], layers: [] },
    data: { connectionIds: [], datasetIds: [], transforms: [], variables: [] }, interactions: [], scripts: [], assets: [], timelines: [], publicationProfiles: [],
  });
  return { project, scene, application };
}

async function dimensions(page) {
  await page.waitForFunction(() => {
    const viewport = document.querySelector(".viewport"), canvas = viewport?.querySelector("canvas");
    return canvas && Math.abs(canvas.clientWidth - viewport.clientWidth) <= 1 && viewport.clientWidth >= 280;
  });
  return page.locator(".workspace").evaluate(workspace => {
    const box = node => { const b = node.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
    return { workspace: box(workspace), canvas: box(workspace.querySelector("canvas")), panel: workspace.querySelector(".scene-simulation-panel") ? box(workspace.querySelector(".scene-simulation-panel")) : null,
      clientWidth: workspace.querySelector("canvas").clientWidth, documentWidth: document.documentElement.scrollWidth };
  });
}

async function inspectToolbar(page, screenshot) {
  const surface = await page.locator(".studio-scene-surface").boundingBox();
  const toolbar = page.getByRole("toolbar", { name: "场景编辑工具", exact: true });
  for (const button of await toolbar.locator(":scope > button, .scene-tool-task-trigger").all()) {
    const box = await button.boundingBox();
    assert.ok(box.x >= surface.x && box.x + box.width <= surface.x + surface.width + 1, "Every toolbar action must fit the actual rendering surface");
    if (await button.isEnabled()) assert.equal(await button.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); }), true, "Toolbar actions must not be covered");
  }
  for (const name of ["创建", "查看与分析", "仿真与开发"]) {
    await toolbar.getByRole("button", { name, exact: true }).click();
    const menu = toolbar.locator(".scene-tool-menu:visible"); await menu.waitFor();
    const box = await menu.boundingBox();
    assert.ok(box.x >= surface.x - 1 && box.x + box.width <= surface.x + surface.width + 1, `${name} menu must not be clipped`);
    if (name === "仿真与开发") {
      await screenshot(); await menu.getByRole("menuitem", { name: "工位与机器人", exact: true }).click();
      await toolbar.getByRole("button", { name, exact: true }).click();
      await toolbar.getByRole("menuitem", { name: "物流仿真", exact: true }).click();
    }
    else await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
  }
  // An open menu may intentionally cover navigation. Once closed, every standard view
  // must be reachable even when the editing toolbar wraps onto two rows.
  const viewButtons = await page.locator(".view-control button").all(); assert.equal(viewButtons.length, 6);
  for (const button of viewButtons) {
    const box = await button.boundingBox();
    assert.ok(box.x >= surface.x && box.x + box.width <= surface.x + surface.width + 1, "Standard views must stay inside the rendering surface");
    assert.equal(await button.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); }), true, "The compact toolbar must not cover any standard-view action");
  }
}

try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const entry = { round, theme, width, passed: false, errors: [], driverWarnings: [], writes: [], measurements: [] }; report.cases.push(entry);
    const data = await fixture(`${round}-${theme}`);
    const appPath = `/api/projects/${data.project.id}/applications/${data.application.metadata.id}`;
    const context = await gate.browser.newContext({ viewport: { width, height: 1000 } });
    await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } }); });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["warning", "error"].includes(message.type())) return;
      const text = message.text();
      if (/^THREE\.WebGLProgram: Program Info Log:/.test(text) && /warning X4122: sum of/.test(text) && !/error/i.test(text)) entry.driverWarnings.push(text);
      else entry.errors.push(text);
    });
    const shot = name => page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${width}-${name}.png`) });
    const panel = page.getByRole("complementary", { name: "场景仿真插件", exact: true });
    const seed = page.getByLabel("场景仿真种子", { exact: true });
    const duration = page.getByLabel("场景仿真时长", { exact: true });
    const open = async () => { await page.getByRole("button", { name: "仿真与开发", exact: true }).click(); await page.getByRole("menuitem", { name: "物流仿真", exact: true }).click(); await seed.waitFor(); };
    try {
      await gate.loginPage(page);
      await page.goto(`${gate.origin}/studio/${data.project.id}/applications/${data.application.metadata.id}/scenes/${data.scene.id}`);
      await page.locator(".viewport canvas").waitFor();
      if (candidateCss) await page.addStyleTag({ content: candidateCss });
      // Establish a real author snapshot before the zero-write layout phase. The deliberately
      // sparse API fixture otherwise differs from renderer defaults during recovery comparison.
      const normalizing = page.waitForResponse(response => response.url().endsWith(`${appPath}/workspace`) && response.request().method() === "PUT");
      const save = page.getByRole("button", { name: "保存项目", exact: true });
      await save.click(); assert.equal((await normalizing).status(), 200);
      await save.locator(":scope:not(:disabled)").waitFor();
      const baseline = await gate.json("GET", appPath);
      const authoredObjects = scene => scene.primitives.map(({ modelId, name, color, visible, transform }) => ({ modelId, name, color, visible, transform }));
      assert.deepEqual(authoredObjects(baseline.scenes[0]), authoredObjects(data.scene), "Setup may normalize defaults but not alter author objects");
      await context.route("**/api/**", async route => {
        if (["GET", "HEAD", "OPTIONS"].includes(route.request().method())) return route.fallback();
        entry.writes.push(route.request().url()); await route.fulfill({ status: 409, json: { message: "Unexpected layout-test write blocked" } });
      });
      const originalCanvas = await page.locator(".viewport canvas").elementHandle();
      const original = await dimensions(page); entry.measurements.push({ name: "original", ...original });
      const sameCanvas = async () => {
        assert.equal(await originalCanvas.evaluate(canvas => canvas.isConnected), true, "Docking must not detach the renderer canvas");
        assert.equal(await page.locator(".viewport canvas").evaluate((canvas, original) => canvas === original, originalCanvas), true, "Keep the original rendering surface");
      };
      await open(); await seed.fill("keep-through-docking"); await duration.fill("173");
      const originalSeed = await seed.elementHandle();
      const sameForm = async () => assert.equal(await seed.evaluate((input, original) => input === original, originalSeed), true, "Keep the mounted form, not a reconstructed copy of its values");
      const beforeDrag = (await dimensions(page)).panel;
      const moveHeader = await panel.locator(".scene-simulation-title").boundingBox();
      await page.mouse.move(moveHeader.x + 10, moveHeader.y + 10); await page.mouse.down();
      await page.mouse.move(moveHeader.x + 30, moveHeader.y + 30, { steps: 5 }); await page.mouse.up();
      const resize = page.getByRole("button", { name: "调整仿真面板大小", exact: true });
      await resize.focus(); await resize.press("ArrowLeft");
      const floating = (await dimensions(page)).panel;
      assert.ok(Math.abs(floating.top - beforeDrag.top - 20) <= 1, "Floating header drag must move the actual panel");
      await shot("floating-start");

      for (const [placement, label] of [["left", "仿真面板停靠左侧"], ["right", "仿真面板停靠右侧"]]) {
        const button = page.getByRole("button", { name: label, exact: true }); await button.focus(); await button.press("Enter");
        await page.waitForFunction(placement => document.querySelector(".workspace").dataset.simulationDock === placement && document.querySelector(".scene-simulation-panel").clientWidth >= 360, placement);
        const layout = await dimensions(page); entry.measurements.push({ name: placement, ...layout });
        assert.ok(layout.canvas.width <= layout.workspace.width - layout.panel.width + 1);
        assert.ok(placement === "left" ? layout.canvas.left >= layout.panel.right - 1 : layout.canvas.right <= layout.panel.left + 1);
        assert.ok(layout.documentWidth <= width + 1); assert.equal(await seed.inputValue(), "keep-through-docking"); assert.equal(await duration.inputValue(), "173");
        await sameCanvas(); await sameForm(); await shot(`${placement}-reserved-canvas`);
        await inspectToolbar(page, () => shot(`${placement}-menu-accessible`));
        assert.equal(await seed.inputValue(), "keep-through-docking");
      }
      const beforeResize = await dimensions(page); await resize.focus(); await resize.press("ArrowLeft");
      const afterResize = await dimensions(page);
      assert.ok(Math.abs(afterResize.panel.width - beforeResize.panel.width - 24) <= 1);
      assert.ok(Math.abs(afterResize.canvas.width - beforeResize.canvas.width + 24) <= 1);
      await seed.focus(); await page.keyboard.press("Escape");
      const collapsed = await dimensions(page); entry.measurements.push({ name: "collapsed", ...collapsed });
      assert.ok(collapsed.panel.width <= 45 && collapsed.canvas.width > afterResize.canvas.width + 300);
      assert.equal(await page.getByRole("button", { name: "展开仿真面板", exact: true }).evaluate(button => button === document.activeElement), true);
      await shot("right-rail-retained"); await page.getByRole("button", { name: "展开仿真面板", exact: true }).press("Enter");
      assert.equal(await seed.inputValue(), "keep-through-docking");
      await panel.locator(".scene-simulation-tabs button").nth(1).click(); await panel.locator(".scene-simulation-tabs button").first().click();
      assert.equal(await seed.inputValue(), "keep-through-docking"); assert.equal(await duration.inputValue(), "173");
      await sameForm();
      entry.contrast = await panel.evaluate(collectTextContrast, ".scene-simulation-title strong, .scene-simulation-title small, .scene-simulation-title > span, .scene-simulation-tabs button, .scene-simulation-footer button");
      assert.deepEqual(entry.contrast.filter(item => item.contrast < 4.5), []);
      await resize.focus(); for (let count = 0; count < 8; count++) await resize.press("ArrowLeft");
      const smallest = await dimensions(page); entry.measurements.push({ name: "narrowest-canvas", ...smallest });
      assert.ok(smallest.clientWidth >= 280 && smallest.clientWidth <= 380);
      assert.ok((await resize.boundingBox()).width <= 7, "The dock splitter must not inherit the generic 28 px button width");
      await resize.hover(); await shot("narrow-canvas-splitter-hover");
      await inspectToolbar(page, () => shot("narrow-canvas-menu-accessible")); await sameCanvas(); await sameForm();
      await page.mouse.move(4, 4); await shot("narrow-canvas-controls-clear");
      assert.equal(await seed.inputValue(), "keep-through-docking");
      await page.getByRole("button", { name: "恢复仿真面板浮动", exact: true }).click();
      const restored = await dimensions(page); entry.measurements.push({ name: "float-restored", ...restored });
      assert.ok(Math.abs(restored.canvas.width - original.canvas.width) <= 1);
      for (const key of ["left", "top", "width", "height"]) assert.ok(Math.abs(restored.panel[key] - floating[key]) <= 1, `Floating ${key} must restore`);
      await sameCanvas(); await shot("floating-restored");
      await page.getByRole("button", { name: "仿真面板停靠右侧", exact: true }).click();
      await page.getByRole("button", { name: "关闭仿真面板", exact: true }).click(); await panel.waitFor({ state: "detached" });
      assert.ok(Math.abs((await dimensions(page)).canvas.width - original.canvas.width) <= 1); await sameCanvas();
      await open(); assert.equal(await panel.getAttribute("data-placement"), "right"); assert.equal(await seed.inputValue(), "scene-1");
      await page.reload(); await page.locator(".viewport canvas").waitFor();
      if (candidateCss) await page.addStyleTag({ content: candidateCss });
      assert.equal(await page.getByRole("dialog", { name: "恢复未保存工作", exact: true }).isVisible(), false, "A saved layout-only flow must not need recovery");
      await open();
      assert.equal(await panel.getAttribute("data-placement"), "right"); assert.equal(await seed.inputValue(), "scene-1");
      await dimensions(page); await shot("reopened-layout-only");
      assert.deepEqual((await gate.json("GET", appPath)).scenes, baseline.scenes, "Layout actions must not save scene inputs, models or a Study");
      assert.deepEqual(entry.writes, []); assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) {
      entry.failure = error.stack ?? String(error); await shot("failure");
      const recovery = page.getByRole("dialog", { name: "恢复未保存工作", exact: true });
      if (await recovery.isVisible()) {
        const downloading = page.waitForEvent("download"); await recovery.getByRole("button", { name: "导出副本", exact: true }).click();
        const file = resolve(gate.output, `r${round}-${theme}-${width}-recovery-diagnostic.json`); await (await downloading).saveAs(file);
        const draft = JSON.parse(await readFile(file, "utf8"));
        const saved = await gate.json("GET", `/api/projects/${data.project.id}/scenes/${data.scene.id}`);
        entry.recoveryDifference = [...new Set([...Object.keys(draft.scene), ...Object.keys(saved)])]
          .filter(key => JSON.stringify(draft.scene[key]) !== JSON.stringify(saved[key])).map(key => ({ key, draft: draft.scene[key], server: saved[key] }));
      }
    }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
    if (!entry.passed) throw new Error(entry.failure);
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); console.log(gate.output); }
