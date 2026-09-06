import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { changedModelPixels, sha256 } from "./gateCameraFramingSupport.mjs";
import { createScene, ensureRows, instanceDialog, observeDiagnostics, saveScene, themeContext } from "./gateModelInstancesSupport.mjs";
import { URDF_GATE_NAME, URDF_GATE_SOURCE } from "./urdfGateFixture.mjs";
import { urdfPackageGateFixture } from "./urdfPackageGateFixture.mjs";

const gate = await createIsolatedStudioGate("urdf-models");
const report = { createdAt: new Date().toISOString(), cases: [], boundaries: [
  "隔离API/本地自制URDF夹具；原场景、凭据、数据库与用户模型不改。",
  "真实UI导入原URDF与多入口ZIP、关节SI姿态、独立实例、保存刷新、2D节点、公开读取。",
  "此门禁不连接ROS或设备，不证明物理仿真、IK、动力学或控制器执行。",
] };
console.log(JSON.stringify({ output: gate.output }));

async function waitModel(projectId, id, page) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const model = (await gate.json("GET", `/api/projects/${projectId}`)).models.find(model => model.id === id);
    assert.notEqual(model?.status, "failed", model?.message);
    if (model?.status === "ready") return model;
    await page.waitForTimeout(100);
  }
  throw new Error("Robot model conversion timed out");
}
async function uploadThroughUi(page, projectId, name, bytes, chooseEntry, shot) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === `/api/projects/${projectId}/models` && response.request().method() === "POST");
  void response.catch(() => undefined);
  await page.locator('.app-shell:not(.app-shell-hidden) ~ input[type="file"][accept*=".urdf"]').setInputFiles({ name, mimeType: name.endsWith("zip") ? "application/zip" : "application/xml", buffer: bytes });
  if (chooseEntry) {
    const dialog = page.getByRole("dialog", { name: "选择机器人", exact: true }); await dialog.waitFor();
    assert.equal(await dialog.getByRole("button", { name: "导入", exact: true }).isDisabled(), true);
    await dialog.getByRole("combobox").selectOption(chooseEntry); await shot("package-entry");
    await dialog.getByRole("button", { name: "导入", exact: true }).click(); await dialog.waitFor({ state: "detached" });
  }
  const uploaded = await response; assert.equal(uploaded.status(), 202, await uploaded.text()); const body = await uploaded.json();
  const model = await waitModel(projectId, body.model?.id ?? body.id, page);
  assert.equal(model.manifest.viewerKind, "urdf"); assert.ok(model.manifest.robot);
  const row = await ensureRows(page, model.id);
  await page.waitForFunction(id => !document.querySelector(`.app-shell:not(.app-shell-hidden) .model-tree-item[data-model-id="${id}"] button[aria-label^="保存并优化"]`)?.disabled, model.id);
  if (!await row.getByRole("button", { name: "隐藏", exact: true }).count()) await row.locator(".asset-main").click();
  await row.getByRole("button", { name: "隐藏", exact: true }).waitFor(); await row.locator(".asset-main").click();
  await page.locator(".robot-joint-preview").waitFor();
  return model;
}
async function warmPixels(buffer) {
  const { data } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0; for (let index = 0; index < data.length; index += 3) if (data[index] > 45 && data[index + 1] > 25 && data[index] > data[index + 2] * 1.8 && data[index + 1] > data[index + 2] * 1.2) count++;
  return count;
}
const poseOf = (scene, id) => scene.models.find(item => item.modelId === id)?.robotPose;

async function runCase(theme, width, packaged) {
  const entry = { theme, width, passed: false, errors: [], driverWarnings: [], expectedNetworkErrors: [] }; report.cases.push(entry);
  const context = await themeContext(gate, theme, width), page = await context.newPage(); page.setDefaultTimeout(30000); observeDiagnostics(page, entry);
  const shot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`) });
  try {
    const project = await gate.json("POST", "/api/projects", { name: `URDF-${theme}-${width}` });
    const { application, appPath, scenePath } = await createScene(gate, page, project.id);
    const source = await uploadThroughUi(page, project.id, URDF_GATE_NAME, Buffer.from(URDF_GATE_SOURCE), undefined, shot);
    assert.equal(source.manifest.robot.joints.length, 6); assert.equal(source.manifest.robot.links.length, 7);
    assert.ok(source.manifest.robot.links.find(link => link.name === "base").inertial); entry.sourceModelId = source.id;
    await page.getByRole("button", { name: "适应全部", exact: true }).click(); await page.waitForTimeout(1200);
    const canvas = page.locator(".viewport canvas"), neutral = await canvas.screenshot();
    const shoulder = page.getByRole("spinbutton", { name: "shoulder_pitch (°)", exact: true });
    await shoulder.fill("30"); await shoulder.press("Enter");
    await page.getByRole("spinbutton", { name: "gripper_open (m)", exact: true }).fill("0.04");
    await page.waitForTimeout(500); entry.jointMotionPixels = await changedModelPixels(neutral, await canvas.screenshot());
    assert.ok(entry.jointMotionPixels.changed > 100, "Actual articulated geometry must move"); await shot("joint-pose");
    const original = await saveScene(page, appPath);
    assert.ok(Math.abs(poseOf(original, source.id).shoulder_pitch - Math.PI / 6) < 1e-9);
    assert.equal(poseOf(original, source.id).gripper_open, .04);
    assert.equal(poseOf(original, source.id).gripper_mimic, undefined, "Passive joints are derived, not authored drives");
    let row = await ensureRows(page, source.id), dialog = await instanceDialog(page, row);
    await dialog.getByRole("button", { name: "新增副本", exact: true }).click(); await dialog.waitFor({ state: "detached" });
    const copied = await saveScene(page, appPath), copy = copied.models.find(model => model.modelId !== source.id); assert.ok(copy);
    assert.equal(copy.assetModelId, source.id); assert.deepEqual(copy.robotPose, poseOf(original, source.id)); entry.instanceId = copy.modelId;
    row = await ensureRows(page, copy.modelId); await row.locator(".asset-main").click();
    await page.getByRole("spinbutton", { name: "shoulder_pitch (°)", exact: true }).fill("60");
    const position = page.getByLabel("位置 · Y↑ X (m)", { exact: true }); await position.fill("1.1"); await position.press("Enter");
    await page.getByRole("button", { name: "适应全部", exact: true }).click(); await page.waitForTimeout(1200);
    const independent = await saveScene(page, appPath); assert.deepEqual(poseOf(independent, source.id), poseOf(original, source.id));
    assert.ok(Math.abs(poseOf(independent, copy.modelId).shoulder_pitch - Math.PI / 3) < 1e-9); await shot("independent-poses");

    const zip = await uploadThroughUi(page, project.id, "机器人原始包.zip", packaged.bytes, packaged.entryPath, shot);
    assert.equal(zip.manifest.robot.entryPath, packaged.entryPath); assert.equal(zip.manifest.robot.resources.length, 3);
    entry.packageModelId = zip.id;
    await page.getByRole("spinbutton", { name: "elbow_pitch (°)", exact: true }).fill("-25");
    const zipPosition = page.getByLabel("位置 · Y↑ X (m)", { exact: true }); await zipPosition.fill("-1.1"); await zipPosition.press("Enter");
    await page.getByRole("button", { name: "适应全部", exact: true }).click(); await page.waitForTimeout(1200);
    const saved = await saveScene(page, appPath); assert.equal(saved.models.length, 3);
    assert.deepEqual(poseOf(saved, source.id), poseOf(original, source.id)); assert.deepEqual(poseOf(saved, copy.modelId), poseOf(independent, copy.modelId));
    await shot("package-loaded");
    await page.reload(); await page.locator(".viewport canvas").waitFor();
    row = await ensureRows(page, copy.modelId); await row.getByRole("button", { name: "隐藏", exact: true }).waitFor(); await row.locator(".asset-main").click();
    await page.locator(".robot-joint-preview").waitFor(); assert.equal(Number(await page.getByRole("spinbutton", { name: "shoulder_pitch (°)", exact: true }).inputValue()), 60);
    const reloaded = await saveScene(page, appPath); assert.deepEqual(reloaded.models, saved.models); assert.deepEqual(reloaded.camera, saved.camera); await shot("saved-reloaded");

    await page.goto(`${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${encodeURIComponent(application.pages[0].id)}`);
    await page.locator(".scene-viewport-preview.ready canvas").waitFor(); await shot("2d-scene-node");
    const publish = page.waitForResponse(response => response.url().endsWith(`${appPath}/publish`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "发布", exact: true }).click(); assert.equal((await publish).status(), 201);
    const anonymous = await themeContext(gate, theme, width), publicPage = await anonymous.newPage(), writes = []; observeDiagnostics(publicPage, entry);
    publicPage.on("request", request => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.url()); });
    try {
      const response = await anonymous.request.get(`${gate.origin}/api/public/applications/${application.metadata.id}/browse`); assert.equal(response.status(), 200);
      const bundle = await response.json(); assert.deepEqual(bundle.publication.document.scenes[0].models, saved.models);
      assert.deepEqual(bundle.project.models.map(model => model.id).sort(), [source.id, zip.id].sort());
      await publicPage.goto(`${gate.origin}/apps/${application.metadata.id}`); const visible = publicPage.locator(".scene-viewport-preview.ready canvas"); await visible.waitFor(); await publicPage.waitForTimeout(1000);
      entry.publicRobotPixels = await warmPixels(await visible.screenshot()); assert.ok(entry.publicRobotPixels > 100, "Published robot arm meshes must be visible");
      await publicPage.screenshot({ path: resolve(gate.output, `${theme}-${width}-published.png`) }); assert.deepEqual(writes, []);
    } finally { await anonymous.close(); }
    assert.equal(sha256(await (await gate.client.get(source.sourceUrl)).body()), sha256(Buffer.from(URDF_GATE_SOURCE)));
    assert.equal(sha256(await (await gate.client.get(zip.sourceUrl)).body()), sha256(packaged.bytes));
    assert.deepEqual((await gate.json("GET", appPath)).scenes[0].models, saved.models);
    assert.deepEqual(entry.errors, []); entry.passed = true; entry.scenePath = scenePath;
  } catch (error) { entry.failure = error.stack; entry.failureText = await page.locator("body").innerText(); await shot("failed"); throw error; }
  finally { await context.close(); console.log(JSON.stringify(entry)); }
}

try {
  const packaged = await urdfPackageGateFixture(); report.sourceHash = sha256(Buffer.from(URDF_GATE_SOURCE)); report.packageHash = sha256(packaged.bytes);
  for (const [theme, width] of [["dark", 1440], ["dark", 980], ["light", 1440], ["light", 980]]) if (!process.env.URDF_GATE_CASE || process.env.URDF_GATE_CASE === `${theme}-${width}`) await runCase(theme, width, packaged);
  assert.ok(report.cases.length, "URDF_GATE_CASE must match a case");
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, passed: report.cases.every(entry => entry.passed) }));
