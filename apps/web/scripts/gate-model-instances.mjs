import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { sha256, visibleGripperPalette } from "./gateCameraFramingSupport.mjs";
import { createScene, ensureRows, instanceDialog, modelInstanceFixtures, observeDiagnostics, referenceState, saveScene, seedReferences, snapshotDifferences, themeContext, uploadModel } from "./gateModelInstancesSupport.mjs";

const gate = await createIsolatedStudioGate("model-instances");
const report = { createdAt: new Date().toISOString(), cases: [], boundaries: [
  "仅独立临时API/数据目录；原始已审核GLB只读，业务场景与数据库拓扑不改。",
  "模型ID是实例身份，assetModelId是素材身份；复制不复制业务绑定，替换保留既有引用。",
  "验证下载失败、结构不兼容和成功替换；不宣称register/apply提交阶段的任意异常具备原子回滚。",
  "IFC/Fragments替换未开放；LOD容器拓扑发生变化会拒绝，避免保存后构件路径漂移。",
  "匿名验证只覆盖发布bundle筛选与只读UI，不宣称增加了现有/assets二进制端点授权。",
] };
console.log(JSON.stringify({ output: gate.output }));
const assetId = model => model.assetModelId ?? model.modelId;
const authoredModel = model => { const { assetModelId: _asset, sourceName: _source, sourceFormat: _format, ...state } = model; return state; };

async function anonymousCheck(entry, application, appPath, projectId, scene) {
  const context = await themeContext(gate, entry.theme, entry.width); const page = await context.newPage();
  observeDiagnostics(page, entry); const writes = [];
  page.on("request", request => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.url()); });
  try {
    const response = await context.request.get(`${gate.origin}/api/public/applications/${application.metadata.id}/browse`);
    assert.equal(response.status(), 200); const bundle = await response.json();
    const published = bundle.publication.document.scenes.find(item => item.id === scene.id);
    assert.deepEqual(published.models, scene.models);
    assert.deepEqual(referenceState(published), { ...referenceState(scene), interactions: undefined });
    assert.deepEqual(bundle.project.models.map(item => item.id).sort(), [...new Set(scene.models.map(assetId))].sort());
    await page.goto(`${gate.origin}/apps/${application.metadata.id}`);
    const canvas = page.locator(".scene-viewport-preview.ready canvas"); await canvas.waitFor(); await page.waitForTimeout(1500);
    entry.publishedPalette = await visibleGripperPalette(await canvas.screenshot());
    for (const color of ["red", "green", "blue"]) assert.ok(entry.publishedPalette[color] > 25, `Published ${color} mechanical parts must render`);
    await page.screenshot({ path: resolve(gate.output, `${entry.theme}-${entry.width}-published.png`) });
    assert.deepEqual(writes, []); entry.anonymousReadOnly = true;
    const unchanged = await gate.json("GET", appPath);
    assert.deepEqual(unchanged.scenes.find(item => item.id === scene.id).models, scene.models);
    assert.equal((await gate.json("GET", `/api/projects/${projectId}`)).models.length, 3);
  } finally { await context.close(); }
}

async function runCase(fixtures, theme, width) {
  const entry = { theme, width, passed: false, errors: [], driverWarnings: [], expectedNetworkErrors: [] }; report.cases.push(entry);
  const context = await themeContext(gate, theme, width); const page = await context.newPage(); page.setDefaultTimeout(30000);
  observeDiagnostics(page, entry); const shot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`) });
  try {
    const project = await gate.json("POST", "/api/projects", { name: `模型实例-${theme}-${width}` });
    const source = await uploadModel(gate, project.id, page, "机械夹爪.glb", fixtures.bytes);
    const compatible = await uploadModel(gate, project.id, page, "同结构替换.glb", fixtures.bytes);
    const incompatible = await uploadModel(gate, project.id, page, "异结构素材.glb", fixtures.incompatible);
    entry.resources = { source: source.id, compatible: compatible.id, incompatible: incompatible.id };
    const { application, appPath, scenePath } = await createScene(gate, page, project.id);
    let originalRow = await ensureRows(page, source.id);
    await originalRow.locator(".asset-main").click(); await originalRow.getByRole("button", { name: "隐藏", exact: true }).waitFor();
    const pause = originalRow.getByRole("button", { name: "暂停模型动画", exact: true }); if (await pause.count()) await pause.click();
    const initial = await saveScene(page, appPath); assert.equal(initial.models.length, 1);
    let dialog = await instanceDialog(page, originalRow); await shot("dialog");
    const bounds = await dialog.boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 1000);
    await dialog.getByRole("button", { name: "新增副本", exact: true }).click(); await dialog.waitFor({ state: "detached" });
    const duplicated = await saveScene(page, appPath); assert.equal(duplicated.models.length, 2);
    const copy = duplicated.models.find(model => model.modelId !== source.id); assert.ok(copy);
    assert.equal(assetId(copy), source.id); assert.notEqual(copy.modelId, source.id);
    assert.deepEqual(duplicated.models.find(model => model.modelId === source.id), initial.models[0]);
    assert.deepEqual(duplicated.camera, initial.camera, "Duplicate must not reframe camera");
    entry.instanceId = copy.modelId;
    const seeded = await seedReferences(gate, appPath, duplicated, copy.modelId);
    await page.reload(); await page.locator(".viewport canvas").waitFor();
    let copyRow = await ensureRows(page, copy.modelId); await copyRow.getByRole("button", { name: "隐藏", exact: true }).waitFor();
    originalRow = await ensureRows(page, source.id);
    await copyRow.locator(".asset-main").click();
    const positionX = page.getByLabel("位置 · Y↑ X (m)", { exact: true }); await positionX.fill("0.14"); await positionX.press("Enter");
    await page.getByRole("button", { name: "适应全部", exact: true }).click(); await page.waitForTimeout(1200);
    const movedReferences = referenceState(seeded); movedReferences.annotations[0].position.x += 0.14;
    const before = await saveScene(page, appPath); assert.deepEqual(referenceState(before), movedReferences);
    assert.equal(before.models.find(model => model.modelId === copy.modelId).transform.position.x, 0.14);
    assert.equal(before.models.find(model => model.modelId === source.id).transform.position.x, 0);
    entry.independentTransformThroughUi = true;
    await copyRow.getByRole("button", { name: "隐藏", exact: true }).click();
    const hidden = await saveScene(page, appPath);
    assert.equal(hidden.models.find(model => model.modelId === copy.modelId).visible, false);
    assert.equal(hidden.models.find(model => model.modelId === source.id).visible, true);
    await copyRow.getByRole("button", { name: "显示", exact: true }).click();
    await saveScene(page, appPath); await shot("independent-instances");

    dialog = await instanceDialog(page, copyRow);
    await dialog.getByLabel("替换为项目素材").selectOption(compatible.id);
    const geometryPath = new URL(compatible.manifest.geometryUrl, gate.origin).pathname;
    let failedRequests = 0; entry.injectingFailure = true;
    const failAsset = async route => { failedRequests++; await route.fulfill({ status: 503, contentType: "text/plain", body: "isolated model replacement failure" }); };
    await page.route(`**${geometryPath}`, failAsset);
    await dialog.getByRole("button", { name: "替换素材", exact: true }).click(); await dialog.getByRole("alert").waitFor();
    assert.ok(failedRequests > 0); entry.networkFailureText = await dialog.getByRole("alert").innerText();
    await shot("network-failure-preserved"); await page.unroute(`**${geometryPath}`, failAsset);
    await dialog.getByRole("button", { name: "取消", exact: true }).click(); await page.waitForTimeout(200); entry.injectingFailure = false;
    const failed = await saveScene(page, appPath); assert.deepEqual(failed.models, before.models); assert.deepEqual(referenceState(failed), referenceState(before));
    assert.deepEqual(failed.camera, before.camera);

    dialog = await instanceDialog(page, copyRow); await dialog.getByLabel("替换为项目素材").selectOption(incompatible.id);
    await dialog.getByRole("button", { name: "替换素材", exact: true }).click(); await dialog.getByRole("alert").waitFor();
    assert.match(await dialog.getByRole("alert").innerText(), /结构不兼容/); await shot("incompatible-preserved");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.deepEqual((await saveScene(page, appPath)).models, before.models);

    dialog = await instanceDialog(page, copyRow); await dialog.getByLabel("替换为项目素材").selectOption(compatible.id);
    await dialog.getByRole("button", { name: "替换素材", exact: true }).click(); await dialog.waitFor({ state: "detached" });
    const replaceCompleteAt = Date.now();
    const replaced = await saveScene(page, appPath); const replacement = replaced.models.find(model => model.modelId === copy.modelId);
    assert.equal(assetId(replacement), compatible.id);
    assert.deepEqual(authoredModel(replacement), authoredModel(before.models.find(model => model.modelId === copy.modelId)));
    assert.deepEqual(replaced.models.find(model => model.modelId === source.id), before.models.find(model => model.modelId === source.id));
    assert.deepEqual(referenceState(replaced), referenceState(before)); assert.deepEqual(replaced.camera, before.camera); await shot("replaced");
    const savedApplication = await gate.json("GET", appPath);
    assert.equal(savedApplication.interactions.find(flow => flow.id === "gate-script").source.modelId, copy.modelId);
    entry.referencesPreserved = true;

    entry.historyLabels = { replaced: await page.getByRole("button", { name: /^撤销：/ }).getAttribute("aria-label") };
    await copyRow.hover(); await copyRow.getByRole("button", { name: "移除实例", exact: true }).click();
    entry.replaceToRemoveMs = Date.now() - replaceCompleteAt;
    await copyRow.waitFor({ state: "detached" }); entry.historyLabels.removed = await page.getByRole("button", { name: /^撤销：/ }).getAttribute("aria-label");
    const removed = await saveScene(page, appPath); entry.historyLabels.saved = await page.getByRole("button", { name: /^撤销：/ }).getAttribute("aria-label");
    assert.equal(removed.models.length, 1); assert.deepEqual(referenceState(removed), referenceState(replaced));
    assert.equal((await gate.json("GET", `/api/projects/${project.id}`)).models.length, 3);
    await page.getByRole("button", { name: /^撤销：/ }).click();
    await page.getByText("已撤销三维编辑", { exact: true }).waitFor();
    entry.historyLabels.afterUndo = await page.getByRole("button", { name: /^撤销：/ }).getAttribute("aria-label");
    const restored = await saveScene(page, appPath); entry.undoChanges = snapshotDifferences(removed, restored); entry.undoRestoreDifferences = snapshotDifferences(replaced, restored);
    assert.deepEqual(restored.models, replaced.models); assert.deepEqual(referenceState(restored), referenceState(replaced));
    copyRow = await ensureRows(page, copy.modelId); await copyRow.getByRole("button", { name: "隐藏", exact: true }).waitFor();
    entry.removalReversibleWithoutDeletingAssets = true;
    await page.reload(); await page.locator(".viewport canvas").waitFor();
    copyRow = await ensureRows(page, copy.modelId); await copyRow.getByRole("button", { name: "隐藏", exact: true }).waitFor();
    const reloaded = await saveScene(page, appPath); assert.deepEqual(reloaded.models, replaced.models); assert.deepEqual(referenceState(reloaded), referenceState(replaced));
    assert.deepEqual(reloaded.camera, replaced.camera); await shot("saved-reloaded"); entry.reloadPreserved = true;

    const pagePath = `${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${encodeURIComponent(application.pages[0].id)}`;
    await page.goto(pagePath);
    await page.locator(".dashboard-workspace").waitFor(); await page.locator(".scene-viewport-preview.ready canvas").waitFor(); await shot("2d-scene-node");
    const publishing = page.waitForResponse(response => response.url().endsWith(`${appPath}/publish`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "发布", exact: true }).click(); assert.equal((await publishing).status(), 201);
    await anonymousCheck(entry, application, appPath, project.id, reloaded);
    for (const model of [source, compatible]) assert.equal(sha256(await (await gate.client.get(model.sourceUrl)).body()), fixtures.hash);
    assert.equal(page.url(), pagePath);
    assert.deepEqual(entry.errors, []); entry.passed = true;
  } catch (error) { entry.failure = error.stack; entry.failureText = await page.locator("body").innerText(); await shot("failed"); throw error; }
  finally { await context.close(); console.log(JSON.stringify(entry)); }
}

try {
  const fixtures = await modelInstanceFixtures(); report.sourceHash = fixtures.hash;
  const matrix = [["dark", 1440], ["dark", 980], ["light", 1440], ["light", 980]];
  for (const [theme, width] of matrix) if (!process.env.MODEL_INSTANCE_CASE || process.env.MODEL_INSTANCE_CASE === `${theme}-${width}`) await runCase(fixtures, theme, width);
  assert.ok(report.cases.length, "MODEL_INSTANCE_CASE must match a theme-width case");
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, passed: report.cases.every(item => item.passed) }));
