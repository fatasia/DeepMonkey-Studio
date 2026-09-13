import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createScene, modelInstanceFixtures, uploadModel, themeContext, saveScene } from "./gateModelInstancesSupport.mjs";

const gate = await createIsolatedStudioGate("resource-director-refinement");
const report = { cases: [] };
const { bytes } = await modelInstanceFixtures();
const picture = await sharp({ create: { width: 800, height: 400, channels: 3, background: { r: 76, g: 155, b: 185 } } }).composite([{ input: await sharp({ create: { width: 200, height: 400, channels: 3, background: { r: 220, g: 175, b: 75 } } }).png().toBuffer(), left: 0, top: 0 }]).png().toBuffer();
console.log(JSON.stringify({ output: gate.output }));
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const entry = { round, theme, width, passed: false, errors: [], consoleMessages: [] }; report.cases.push(entry);
    const context = await themeContext(gate, theme, width);
    const page = await context.newPage(); page.setDefaultTimeout(25000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => { if (["error", "warning"].includes(message.type())) entry.consoleMessages.push({ type: message.type(), text: message.text() }); });
    const shot = name => page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${width}-${name}.png`) });
    try {
      const project = await gate.json("POST", "/api/projects", { name: `资源导演台-${round}-${theme}` });
      const { application, appPath, scenePath } = await createScene(gate, page, project.id);
      const source = await uploadModel(gate, project.id, page, "验证模型.glb", bytes);
      const assetsUrl = `${gate.origin}/manager?project=${project.id}&tab=assets&scope=project`;
      await page.goto(assetsUrl);
      const card = page.locator(`.project-resource-card[data-model-id="${source.id}"]`);
      await card.waitFor(); await card.locator(".project-resource-thumbnail img.is-ready").waitFor();
      assert.equal(await page.getByText("模型、二维资源、看板模板与工业预制体,统一浏览、搜索并插入项目").count(), 0);
      const bounds = await card.boundingBox(); assert.ok(bounds.width >= 220 && bounds.height > bounds.width);
      await shot("project-cards");
      await card.locator(".project-resource-thumbnail").click();
      const dialog = page.locator(".resource-preview-dialog");
      const capture = dialog.getByRole("button", { name: "截取预览", exact: true });
      await capture.waitFor();
      await page.waitForFunction(() => { const b = [...document.querySelectorAll(".resource-thumbnail-editor button")].find(el => el.textContent.includes("截取")); return b && !b.disabled; });
      await capture.click(); await dialog.locator(".resource-thumbnail-crop canvas").waitFor();
      const file = dialog.getByLabel("选择缩略图文件");
      await file.setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: picture });
      await dialog.getByRole("slider").first().fill("1.6");
      const route = `**/api/projects/${project.id}/models/${source.id}/thumbnail`;
      await page.route(route, request => request.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "测试：存储暂不可用" }) }));
      await dialog.getByRole("button", { name: "保存缩略图", exact: true }).click();
      await dialog.getByRole("alert").filter({ hasText: "503" }).waitFor();
      assert.equal((await gate.json("GET", `/api/projects/${project.id}`)).models[0].thumbnailUrl, undefined);
      await page.unroute(route);
      const saved = page.waitForResponse(response => response.url().endsWith(`/models/${source.id}/thumbnail`) && response.request().method() === "POST");
      await dialog.getByRole("button", { name: "保存缩略图", exact: true }).click();
      assert.equal((await saved).status(), 200);
      await dialog.getByText("缩略图已保存", { exact: true }).waitFor(); await shot("thumbnail-saved");
      await dialog.getByRole("button", { name: "关闭资源浏览", exact: true }).click();
      await page.reload(); await card.locator(".project-resource-thumbnail img.is-ready").waitFor();
      entry.thumbnailUrl = (await gate.json("GET", `/api/projects/${project.id}`)).models[0].thumbnailUrl;
      assert.ok(entry.thumbnailUrl?.endsWith(".webp"));
      assert.equal(await card.locator(".project-resource-thumbnail img").getAttribute("src"), entry.thumbnailUrl);

      await page.goto(`${gate.origin}/optimizer?project=${project.id}&model=${source.id}&returnScene=${application.scenes[0].id}&returnApplication=${application.metadata.id}`);
      await page.getByRole("button", { name: "开始优化", exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector(".optimizer-preview-toolbar")?.textContent.includes("模型已载入"));
      await page.getByRole("button", { name: "开始优化", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".optimizer-preview-toolbar")?.textContent.includes("优化完成"), { timeout: 60000 });
      const ack = page.locator(".model-quality-ack input"); if (await ack.count()) await ack.check();
      const insert = page.getByRole("button", { name: "插入并返回场景", exact: true });
      assert.equal(await insert.isEnabled(), true); await shot("optimizer-return-enabled");
      await insert.click(); await page.waitForURL(url => url.pathname.includes(`/scenes/${application.scenes[0].id}`), { timeout: 60000 });
      const outputs = (await gate.json("GET", `/api/projects/${project.id}`)).models.filter(model => model.id !== source.id);
      assert.equal(outputs.length, 1); entry.output = outputs[0].id;
      await page.locator(`.model-tree-item[data-model-id="${outputs[0].id}"]`).waitFor();
      entry.panelAnchors = [];
      for (const nextWidth of [1440, 980, 1200]) {
        await page.setViewportSize({ width: nextWidth, height: 1000 });
        const toggle = page.locator(".app-shell > .workspace-panel-controls > .panel-toggle-right");
        for (const collapsed of [true, false]) {
          if ((await toggle.getAttribute("aria-pressed") === "false") !== collapsed) await toggle.click();
          const position = await toggle.evaluate(button => { const b = button.getBoundingClientRect(), p = document.querySelector(".app-shell > .right-panel").getBoundingClientRect(); return { center: (b.left + b.right) / 2, left: b.left, right: b.right, top: b.top, panelLeft: p.left, screen: innerWidth }; });
          assert.ok(position.left >= 0 && position.right <= nextWidth, JSON.stringify(position));
          if (!collapsed) assert.ok(Math.abs(position.center - position.panelLeft) <= 1, JSON.stringify(position));
          entry.panelAnchors.push({ width: nextWidth, collapsed, ...position });
        }
      }
      await page.setViewportSize({ width, height: 1000 });
      await saveScene(page, appPath);
      await page.goto(`${scenePath}?addModel=${source.id}`);
      const rows = page.locator(".scene-layer-interaction[data-object-id]");
      await page.waitForFunction(() => document.querySelectorAll(".scene-layer-interaction[data-object-id]").length === 2);
      await rows.nth(0).locator(".asset-main").click();
      await rows.nth(1).locator(".asset-main").click({ modifiers: ["Control"] });
      await rows.nth(1).click({ button: "right" });
      await page.locator("details.scene-row-menu[open]").getByRole("button", { name: "编组", exact: true }).click();
      await page.locator(".scene-layer-group").waitFor();
      await rows.nth(0).locator(".asset-main").click();
      await rows.nth(0).dragTo(page.locator(".scene-layer-root-drop"));
      assert.equal(await page.locator(".scene-layer-group .scene-layer-interaction[data-object-id]").count(), 1);
      await page.locator(".scene-layer-group-row").click({ button: "right" });
      await page.locator("details.scene-row-menu[open]").getByRole("button", { name: "取消编组", exact: true }).click();
      assert.equal(await page.locator(".scene-layer-group").count(), 0);
      await page.getByRole("button", { name: "查看与分析", exact: true }).click();
      await page.getByRole("menuitem", { name: "场景导演台", exact: true }).click();
      const rail = page.locator(".timeline-track-rail").first();
      await rail.dblclick({ position: { x: 100, y: 14 } });
      await page.locator(".timeline-frame-inspector").waitFor();
      assert.equal(await page.locator(".timeline-marker").count(), 1);
      const vector = page.locator(".timeline-frame-vector input").first();
      const before = await vector.inputValue();
      const canvas = page.locator(".viewport canvas").first(); const rect = await canvas.boundingBox();
      await page.mouse.move(rect.x + rect.width * .45, rect.y + 110); await page.mouse.down();
      await page.mouse.move(rect.x + rect.width * .58, rect.y + 160, { steps: 12 }); await page.mouse.up();
      await page.waitForFunction(value => document.querySelector(".timeline-frame-vector input")?.value !== value, before);
      entry.recordedCameraX = await vector.inputValue();
      const captureFrame = page.getByRole("button", { name: "更新为当前视角", exact: true });
      await captureFrame.click();
      entry.captureButton = await captureFrame.evaluate(button => { const style = getComputedStyle(button); return { radius: style.borderRadius, height: button.getBoundingClientRect().height, background: style.backgroundColor }; });
      assert.ok(parseFloat(entry.captureButton.radius) >= 4 && entry.captureButton.height >= 28);
      for (const value of await page.locator(".timeline-frame-inspector input[type=number]").evaluateAll(nodes => nodes.map(n => n.value))) assert.ok(!value.includes(".") || value.split(".")[1].length <= 4, value);
      await page.getByLabel("到下一帧的过渡方式", { exact: true }).selectOption("step");
      await rail.dblclick({ position: { x: 220, y: 14 } });
      assert.equal(await page.locator(".timeline-marker").count(), 2);
      const snapshot = await saveScene(page, appPath);
      assert.equal(snapshot.animation.camera.length, 2); assert.equal(snapshot.animation.camera[0].transition, "step");
      await shot("director");
      await page.goto(scenePath); await page.getByRole("button", { name: "查看与分析", exact: true }).click(); await page.getByRole("menuitem", { name: "场景导演台", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".timeline-marker").length === 2);
      entry.cube = await page.locator(".view-orientation-cube").evaluate(cube => { const toolbar = cube.querySelector(".cube-actions"), box = cube.querySelector(".cube-viewport"); const a = toolbar.getBoundingClientRect(), b = box.getBoundingClientRect(); const buttons = [...toolbar.querySelectorAll("button")].map(button => button.getBoundingClientRect()); return { gap: b.top - a.bottom, leftPadding: buttons[0].left - a.left, rightPadding: a.right - buttons.at(-1).right }; });
      assert.ok(entry.cube.gap >= 22); assert.ok(Math.abs(entry.cube.leftPadding - entry.cube.rightPadding) < 1);
      const cubeButton = page.getByRole("button", { name: "适应整个场景", exact: true });
      await cubeButton.click();
      assert.equal(await cubeButton.evaluate(button => { const rect = button.getBoundingClientRect(); return button.contains(document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)); }), true);

      await page.goto(`${gate.origin}/manager?project=${project.id}`);
      await page.getByRole("button", { name: "视觉中心", exact: true }).click();
      await page.locator(".vision-sample-content .ai-sample-runner").waitFor();
      entry.vision = await page.evaluate(() => { const sample = document.querySelector(".vision-sample-content .ai-sample-runner").getBoundingClientRect(); const panel = document.querySelector(".vision-panel").getBoundingClientRect(); return { left: sample.left, panelLeft: panel.left, right: sample.right, width: innerWidth, overflow: document.documentElement.scrollWidth }; });
      assert.ok(Math.abs(entry.vision.left - entry.vision.panelLeft) < 1); assert.ok(entry.vision.right <= width && entry.vision.overflow <= width);
      await shot("vision-aligned");
      await page.goto(`${gate.origin}/manager?project=${project.id}`);
      await page.getByRole("button", { name: "AI 助手", exact: true }).click();
      await page.locator(".ai-assistant-experience").waitFor();
      for (const label of ["执行任务", "问答与生成"]) { const button = page.getByRole("tab", { name: label, exact: true }); await button.click(); assert.equal(await button.getAttribute("aria-selected"), "true"); }
      entry.ai = await page.locator(".ai-assistant-experience").evaluate(element => [...element.querySelectorAll("button")].map(button => { const rect = button.getBoundingClientRect(), icon = button.querySelector("svg").getBoundingClientRect(); return { vertical: Math.abs((rect.top + rect.bottom) / 2 - (icon.top + icon.bottom) / 2), height: rect.height }; }));
      assert.ok(entry.ai.every(button => button.vertical < 1)); await shot("ai-centered");
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack; entry.url = page.url(); entry.runtime = await page.evaluate(() => { const root = document.querySelector(".app-shell"); if (!root) return null; let fiber = root[Object.keys(root).find(key => key.startsWith("__reactFiber"))]; while (fiber) { const bindings = fiber.memoizedProps?.controller?.bindings ?? fiber.memoizedProps?.bindings; if (bindings?.state?.engine) { const s = bindings.state; return { route: s.route, busy: s.busy, active: { id: s.activeScene?.id, project: s.activeScene?.projectId }, project: s.project?.id, models: s.project?.models.map(m => ({ id: m.id, status: m.status })), ready: s.engine.isSceneSnapshotReady(s.activeScene?.id), loaded: s.engine.listModels().map(m => m.id) }; } fiber = fiber.return; } return "bindings unavailable"; }); await shot("failed"); await writeFile(resolve(gate.output, "failed.html"), await page.content()); throw error; }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
