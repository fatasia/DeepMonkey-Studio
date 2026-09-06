import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { assertUsefulFraming, changedModelPixels, importGripper, prepareReviewedGripper, projectionOccupancy, sha256, visibleGripperPalette } from "./gateCameraFramingSupport.mjs";

const baseline = process.argv.includes("--baseline");
const gate = await createIsolatedStudioGate(baseline ? "camera-framing-baseline" : "camera-framing");
const report = { baseline, createdAt: new Date().toISOString(), cases: [], boundary: "真实已审核机械夹爪；独立临时项目；通过真实UI暂停模型动画，避免对比期间姿态漂移。静态源包围盒投影仅供参考，实际取景由显示/隐藏像素差断言；截图再人工核对。固定50°透视镜头，与编辑器默认一致。不覆盖所有动画姿态包络。" };
console.log(JSON.stringify({ output: gate.output, baseline }));

function observeDiagnostics(page, entry) {
  page.on("pageerror", error => entry.errors.push(error.message));
  page.on("console", message => {
    if (!["warning", "error"].includes(message.type())) return;
    if (/^THREE\.WebGLProgram: Program Info Log:/.test(message.text()) && /warning X4122: sum of/.test(message.text()) && !/error/i.test(message.text())) entry.driverWarnings.push(message.text());
    else entry.errors.push(message.text());
  });
}

async function saveScene(page, appPath) {
  const response = page.waitForResponse(item => item.url().endsWith(`${appPath}/workspace`) && item.request().method() === "PUT");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  const saved = await response; assert.equal(saved.status(), 200);
  return (await saved.json()).scene;
}

async function createScene(page, projectId) {
  await gate.loginPage(page); await page.goto(`${gate.origin}/manager?project=${projectId}`);
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("真实机械夹爪相机验收");
  const created = page.waitForResponse(response => response.url().endsWith(`/api/projects/${projectId}/applications`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "创建并进入", exact: true }).click();
  const response = await created; assert.equal(response.status(), 201);
  const application = await response.json();
  const appPath = `/api/projects/${projectId}/applications/${application.metadata.id}`;
  const scenePath = `${gate.origin}/studio/${projectId}/applications/${application.metadata.id}/scenes/${application.scenes[0].id}`;
  await page.goto(scenePath); await page.locator(".viewport canvas").waitFor();
  const autoSave = page.getByLabel("自动保存"); if (await autoSave.isChecked()) await autoSave.uncheck();
  return { application, appPath, scenePath };
}

async function publishAndVerify(page, entry, application, appPath, scene, source) {
  await page.goto(`${gate.origin}/studio/${source.projectId}/applications/${application.metadata.id}/pages/${application.pages[0].id}`);
  const publishing = page.waitForResponse(response => response.url().endsWith(`${appPath}/publish`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "发布", exact: true }).click();
  assert.equal((await publishing).status(), 201);
  const context = await gate.browser.newContext({ viewport: { width: entry.width, height: 1000 } });
  await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: entry.theme } }); });
  const viewer = await context.newPage(); const writes = [];
  viewer.on("request", request => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.url()); });
  observeDiagnostics(viewer, entry);
  try {
    const response = await context.request.get(`${gate.origin}/api/public/applications/${application.metadata.id}/browse`);
    assert.equal(response.status(), 200); const bundle = await response.json();
    const published = bundle.publication.document.scenes.find(item => item.id === scene.id);
    assert.deepEqual(published.camera, scene.camera, "Publishing must preserve the explicitly saved camera");
    assert.deepEqual(published.models, scene.models, "Publication may not change source scale or visibility");
    await viewer.goto(`${gate.origin}/apps/${application.metadata.id}`);
    const canvas = viewer.locator(".scene-viewport-preview.ready canvas"); await canvas.waitFor(); await viewer.waitForTimeout(1800);
    const viewport = await canvas.boundingBox(); assert.ok(viewport);
    entry.published = projectionOccupancy(report.source.bounds, published, source.id, viewport);
    entry.published.palette = await visibleGripperPalette(await canvas.screenshot());
    entry.published.boundary = "公开页保持作者镜头，不隐式适配全部；跨宽高比保持构图需显式策略，尚属待办。";
    await viewer.screenshot({ path: resolve(gate.output, `${entry.theme}-${entry.width}-published.png`) });
    if (!baseline) {
      assert.ok(entry.published.contained, "The published camera must keep the original model bounds visible");
      for (const part of ["red", "green", "blue"]) assert.ok(entry.published.palette[part] >= 25,
        `Anonymous view must actually render this fixture's ${part} parts, not just a canvas`);
    }
    assert.deepEqual(writes, []);
  } finally { await context.close(); }
}

async function runCase(theme, width) {
  const entry = { theme, width, passed: false, errors: [], driverWarnings: [], framing: [] }; report.cases.push(entry);
  const context = await gate.browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
  await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } }); });
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  observeDiagnostics(page, entry);
  const shot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`) });
  try {
    const project = await gate.json("POST", "/api/projects", { name: `真实模型取景-${theme}-${width}` });
    const source = await importGripper(gate, project.id, page);
    assert.equal(sha256(await (await gate.client.get(source.sourceUrl)).body()), report.source.hash);
    const { application, appPath, scenePath } = await createScene(page, project.id);
    if (!await page.locator(".model-tree-item").count()) await page.getByRole("button", { name: "场景图层与编组", exact: true }).click();
    const tree = page.locator(`.app-shell:not(.app-shell-hidden) .model-tree-item[data-model-id="${source.id}"]`);
    await tree.locator(".asset-main").click(); await tree.getByRole("button", { name: "隐藏", exact: true }).waitFor();
    await tree.getByRole("button", { name: "暂停模型动画", exact: true }).click();
    await tree.getByRole("button", { name: "播放模型动画", exact: true }).waitFor();
    entry.animationPausedThroughUi = true;
    const measure = async (step, view = "focus") => {
      // The Select toolbar changes navigation mode; only the hierarchy's explicit clear action deselects.
      await page.getByRole("button", { name: "场景图层与编组", exact: true }).click();
      const clear = page.getByRole("button", { name: "清除选择", exact: true });
      if (await clear.count() && await clear.isEnabled()) await clear.click();
      await page.getByRole("button", { name: "场景图层与编组", exact: true }).click();
      await page.waitForTimeout(1500);
      const scene = await saveScene(page, appPath);
      const viewport = await page.locator(".viewport canvas").boundingBox(); assert.ok(viewport);
      const framing = { step, ...projectionOccupancy(report.source.bounds, scene, source.id, viewport, view) }; entry.framing.push(framing);
      await shot(step);
      const canvas = page.locator(".viewport canvas"); const visible = await canvas.screenshot();
      await tree.getByRole("button", { name: "隐藏", exact: true }).click(); await page.waitForTimeout(400);
      framing.actualPixels = await changedModelPixels(visible, await canvas.screenshot());
      await tree.getByRole("button", { name: "显示", exact: true }).click(); await page.waitForTimeout(400);
      console.log(JSON.stringify({ theme, width, step, longestSide: framing.actualPixels.longestSide, restPoseReference: framing.longestSide, distance: framing.distance }));
      if (!baseline) {
        assertUsefulFraming(framing.actualPixels, step);
        assert.ok(framing.actualPixels.ratio > 0.005, "Actual model pixels must contribute, not only a canvas or grid");
      }
      // Visibility toggles create real draft edits; persist the restored state before reload.
      const restored = await saveScene(page, appPath);
      assert.deepEqual(restored.camera, scene.camera, "Visibility inspection must not move the camera");
      assert.deepEqual(restored.models, scene.models, "Pixel inspection must restore the saved model state");
      return restored;
    };
    await measure("explicit-load");
    await tree.locator(".asset-main").dblclick(); await measure("double-click-focus");
    await page.getByRole("button", { name: "适应全部", exact: true }).click(); await measure("fit-all");
    for (const [label, view] of [["上", "top"], ["下", "bottom"], ["左", "left"], ["右", "right"], ["前", "front"], ["后", "back"]]) {
      await page.locator(".view-control").getByRole("button", { name: label, exact: true }).click(); await measure(`standard-${view}`, view);
    }
    await tree.locator(".asset-main").dblclick(); const saved = await measure("saved-focus");
    await page.reload(); await page.locator(".viewport canvas").waitFor();
    // This tab is intentionally local UI state: refresh restores the default object hierarchy.
    if (!await tree.isVisible()) await page.getByRole("button", { name: "场景图层与编组", exact: true }).click();
    await tree.getByRole("button", { name: "隐藏", exact: true }).waitFor();
    await page.waitForTimeout(1800);
    const reloaded = await measure("reload-camera");
    const drift = Math.hypot(...["x", "y", "z"].map(axis => reloaded.camera.position[axis] - saved.camera.position[axis]));
    assert.ok(drift < 0.00001, `Silent model restore changed camera by ${drift}m`); entry.reloadDrift = drift;
    const canvas = page.locator(".viewport canvas"); const visible = await canvas.screenshot();
    await tree.getByRole("button", { name: "隐藏", exact: true }).click(); await page.waitForTimeout(500);
    const hidden = await canvas.screenshot(); entry.modelPixels = await changedModelPixels(visible, hidden);
    if (!baseline) assert.ok(entry.modelPixels.ratio > 0.005, "Actual model pixels must visibly contribute, not only a canvas or grid");
    await tree.getByRole("button", { name: "显示", exact: true }).click(); await saveScene(page, appPath);
    assert.equal(page.url(), scenePath);
    await publishAndVerify(page, entry, application, appPath, reloaded, source);
    assert.equal(sha256(await (await gate.client.get(source.sourceUrl)).body()), report.source.hash);
    assert.deepEqual(entry.errors, []); entry.passed = true;
  } catch (error) { entry.failure = error.stack; entry.failureText = await page.locator("body").innerText(); await shot("failed"); throw error; }
  finally { await context.close(); console.log(JSON.stringify(entry)); }
}

try {
  report.source = await prepareReviewedGripper(gate);
  for (const [theme, width] of [["dark", 1440], ["light", 980]]) await runCase(theme, width);
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, baseline, passed: report.cases.every(item => item.passed) }));
