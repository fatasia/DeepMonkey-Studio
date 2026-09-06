import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { migrateSceneSnapshotV1 } from "../../../packages/contracts/dist/index.js";
import { gripperUid, sha256 } from "./gateCameraFramingSupport.mjs";

/** The reviewed original is read-only; the incompatible derivative exists only in the isolated gate. */
export async function modelInstanceFixtures() {
  const root = resolve(import.meta.dirname, "../../../data/external-assets/source-b");
  const bytes = await readFile(resolve(root, "models", `${gripperUid}.glb`));
  const audit = JSON.parse(await readFile(resolve(root, "audit.json"), "utf8"));
  const reviewed = audit.items.find(item => item.uid === gripperUid);
  assert.equal(reviewed?.status, "approved"); assert.equal(sha256(bytes), reviewed.contentHash);
  const io = new NodeIO(); const doc = await io.readBinary(bytes);
  const node = doc.getRoot().listNodes().find(item => item.getMesh());
  assert.ok(node); node.setName("gate-incompatible-component");
  return { bytes, incompatible: Buffer.from(await io.writeBinary(doc)), hash: sha256(bytes) };
}

export async function uploadModel(gate, projectId, page, name, bytes) {
  const uploaded = await gate.client.post(`/api/projects/${projectId}/models`, {
    multipart: { file: { name, mimeType: "model/gltf-binary", buffer: bytes } },
  });
  assert.equal(uploaded.status(), 202); const initial = await uploaded.json();
  const modelId = initial.model?.id ?? initial.id;
  assert.ok(modelId);
  for (let attempt = 0; attempt < 100; attempt++) {
    const project = await gate.json("GET", `/api/projects/${projectId}`);
    const model = project.models.find(item => item.id === modelId);
    if (model?.status === "ready") return model;
    assert.notEqual(model?.status, "failed", model?.message);
    await page.waitForTimeout(150);
  }
  throw new Error(`Fixture conversion timed out: ${name}`);
}

export async function createScene(gate, page, projectId) {
  await gate.loginPage(page); await page.goto(`${gate.origin}/manager?project=${projectId}`);
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("独立机械夹爪实例");
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

export async function saveScene(page, appPath) {
  const pending = page.waitForResponse(response => response.url().endsWith(`${appPath}/workspace`) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  const response = await pending; assert.equal(response.status(), 200, await response.text());
  return (await response.json()).scene;
}

export function referenceState(scene) {
  return Object.fromEntries(["annotations", "selectionSets", "interactions", "simulationEntities"].map(key => [key, scene[key]]));
}

export function snapshotDifferences(before, after, path = "scene") {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === "object" && typeof after === "object") {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => snapshotDifferences(before[key], after[key], `${path}.${key}`));
  }
  const brief = value => typeof value === "string" && value.length > 160 ? `${value.length} characters; sha256=${sha256(value)}` : value;
  return [{ path, before: brief(before), after: brief(after) }];
}

/** Seed meaningful authored references via the isolated workspace API, then test UI mutations against them. */
export async function seedReferences(gate, appPath, snapshot, instanceId) {
  const scene = structuredClone(snapshot);
  scene.annotations = [{ id: "gate-annotation", name: "夹爪实例标签", description: "", size: 1, position: { x: 0, y: 0.2, z: 0 }, color: "#d9a441", visible: true, locked: false, modelId: instanceId }];
  scene.selectionSets = [{ id: "gate-selection", name: "夹爪作业对象", objectIds: [instanceId] }];
  scene.interactions = [{ id: "gate-script", name: "实例脚本引用", target: { kind: "object", modelId: instanceId }, trigger: "click", enabled: false, actions: [], code: "console.info('isolated instance fixture');" }];
  scene.simulationEntities = [{ id: "gate-path", kind: "path", name: "夹爪路径", targetModelId: instanceId, points: [[0, 0, 0], [0.1, 0, 0]], speed: 0.01, loopMode: "once" }];
  const application = await gate.json("GET", appPath); const migrated = migrateSceneSnapshotV1(scene);
  application.scenes = application.scenes.map(item => item.id === scene.id ? migrated.scenes[0] : item);
  application.interactions = migrated.interactions; application.scripts = migrated.scripts;
  application.metadata.source = { ...application.metadata.source, hadInteractions: true };
  const saved = await gate.json("PUT", `${appPath}/workspace`, { application, scene });
  return saved.scene;
}

export function observeDiagnostics(page, entry) {
  page.on("pageerror", error => entry.errors.push(error.message));
  page.on("console", message => {
    if (!["warning", "error"].includes(message.type())) return;
    const text = message.text();
    if (/^THREE\.WebGLProgram: Program Info Log:/.test(text) && /warning X4122: sum of/.test(text) && !/error/i.test(text)) entry.driverWarnings.push(text);
    else if (entry.injectingFailure && /Failed to load resource:.*503/.test(text)) entry.expectedNetworkErrors.push(text);
    else entry.errors.push(text);
  });
}

export async function themeContext(gate, theme, width) {
  const context = await gate.browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
  await context.route("**/api/public/branding", async route => {
    const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } });
  });
  return context;
}

export async function ensureRows(page, id) {
  const row = page.locator(`.app-shell:not(.app-shell-hidden) .model-tree-item[data-model-id="${id}"]`);
  const layers = page.getByRole("button", { name: "场景图层与编组", exact: true });
  if ((await layers.getAttribute("class"))?.split(/\s+/).includes("active")) await layers.click();
  await row.waitFor(); return row;
}

export async function instanceDialog(page, row) {
  await row.hover();
  await row.getByRole("button", { name: /^管理模型实例 / }).click();
  const dialog = page.getByRole("dialog", { name: "模型实例", exact: true }); await dialog.waitFor();
  return dialog;
}
