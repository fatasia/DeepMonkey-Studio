import assert from "node:assert/strict";
import { resolve } from "node:path";
import { collectTextContrast } from "./browserTextContrast.mjs";

/** Continue from a real optimizer result; fixtures and writes stay in the isolated project. */
export async function gateOptimizerPublication(gate, page, entry, projectId, model, source) {
  await gate.json("PATCH", `/api/projects/${projectId}/models/${model.id}`, { name: "已优化机械夹爪" });
  await page.goto(`${gate.origin}/manager?project=${projectId}`);
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("优化模型交付场景");
  const created = page.waitForResponse(response => response.url().endsWith(`/api/projects/${projectId}/applications`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "创建并进入", exact: true }).click();
  const response = await created; assert.equal(response.status(), 201);
  const application = await response.json(); const scene = application.scenes[0];
  const appPath = `/api/projects/${projectId}/applications/${application.metadata.id}`;
  const scenePath = `${gate.origin}/studio/${projectId}/applications/${application.metadata.id}/scenes/${scene.id}`;
  await page.goto(scenePath);
  await page.locator(".viewport canvas").waitFor();
  const autoSave = page.getByLabel("自动保存");
  if (await autoSave.isChecked()) await autoSave.uncheck();
  if (!await page.locator(".asset-row").count()) await page.getByRole("button", { name: "场景图层与编组", exact: true }).click();
  const row = page.locator(".asset-row").filter({ hasText: "已优化机械夹爪" });
  await row.locator(".asset-main").click(); await row.locator(".mini-button").first().waitFor();
  await row.locator(".asset-main").dblclick();
  await page.waitForTimeout(1000); // The real focus transition must settle before saving its camera.
  const savedResponse = page.waitForResponse(response => response.url().endsWith(`${appPath}/workspace`) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  const saved = await savedResponse; assert.equal(saved.status(), 200);
  const workspace = await saved.json();
  assert.deepEqual(workspace.scene.models.map(model => model.modelId), [model.id], "Only the chosen derivative belongs in this scene");
  await page.reload(); await page.locator(".viewport canvas").waitFor();
  await page.screenshot({ path: resolve(gate.output, `${entry.theme}-${entry.width}-optimized-in-scene.png`) });
  const persisted = await gate.json("GET", appPath);
  assert.deepEqual(persisted.scenes.find(item => item.id === scene.id).models.map(model => model.modelId), [model.id]);
  // Reuse the actual 2D publish action rather than manufacturing a publication.
  await page.goto(`${gate.origin}/studio/${projectId}/applications/${application.metadata.id}/pages/${persisted.pages[0].id}`);
  const publicationResponse = page.waitForResponse(response => response.url().endsWith(`${appPath}/publish`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "发布", exact: true }).click();
  assert.equal((await publicationResponse).status(), 201);
  const publicScene = { ...workspace.scene, publicationToolbarVisible: false };
  await gate.json("PUT", `/api/projects/${projectId}/scenes/${scene.id}`, publicScene);
  await gate.json("POST", `/api/projects/${projectId}/scenes/${scene.id}/publish`);

  const anonymous = await gate.browser.newContext({ viewport: { width: entry.width, height: 1000 } });
  await anonymous.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: entry.theme } }); });
  const viewer = await anonymous.newPage(); viewer.setDefaultTimeout(30000);
  const writes = []; const errors = [];
  let authenticating = false;
  viewer.on("request", request => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method())
    && !(authenticating && new URL(request.url()).pathname === "/api/auth/login")) writes.push(request.url()); });
  viewer.on("pageerror", error => errors.push(error.message));
  try {
    const result = await anonymous.request.get(`${gate.origin}/api/public/applications/${application.metadata.id}/browse`);
    assert.equal(result.status(), 200);
    const bundle = await result.json(); assert.deepEqual(bundle.project.models.map(item => item.id), [model.id]);
    assert.deepEqual(bundle.project.models[0].optimization.libraryOrigin, source.libraryOrigin);
    for (const [kind, url, canvas] of [
      ["application", `${gate.origin}/apps/${application.metadata.id}`, ".scene-viewport-preview.ready canvas"],
      ["scene", `${gate.origin}/published/${scene.id}`, ".viewport canvas"],
    ]) {
      // The legacy single-scene shell still requires login; do not widen its auth policy for a credit test.
      if (kind === "scene") {
        assert.deepEqual(writes, [], "Anonymous application must not write");
        authenticating = true; await gate.loginPage(viewer); authenticating = false;
      }
      await viewer.goto(url); await viewer.locator(canvas).waitFor();
      await viewer.waitForTimeout(1800);
      const credits = viewer.locator(".published-model-credits");
      await credits.locator(":scope > summary").press("Enter");
      await credits.locator(".asset-attribution summary").press("Enter");
      assert.match(await credits.innerText(), /trinityscsp/);
      assert.match(await credits.innerText(), /经模型优化处理/);
      assert.equal(await credits.getByRole("link", { name: "许可条款", exact: true }).getAttribute("href"), source.libraryOrigin.attribution.licenseUrl);
      const contrast = await credits.evaluate(collectTextContrast, "summary, strong, small, p, a");
      assert.deepEqual(contrast.filter(item => item.text && item.contrast < 4.5), []);
      await viewer.screenshot({ path: resolve(gate.output, `${entry.theme}-${entry.width}-published-${kind}-credits.png`) });
      await credits.locator(".asset-attribution summary").press("Escape");
      assert.equal(await credits.getAttribute("open"), null);
    }
    assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    entry.steps.push("real-scene-create-load-save-reload / real-application-publish / anonymous-application-credits / authenticated-hidden-toolbar-scene-credits / zero-business-writes");
  } catch (error) {
    entry.publicationFailureUrl = viewer.url(); entry.publicationFailureText = await viewer.locator("body").innerText();
    await viewer.screenshot({ path: resolve(gate.output, `${entry.theme}-${entry.width}-publication-failure.png`) });
    throw error;
  } finally { await anonymous.close(); }
}
