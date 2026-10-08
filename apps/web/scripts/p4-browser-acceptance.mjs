/**
 * P4 浏览器域验收(H-C7-P4 四题:A4 快照往返 / B1 clearcoat / B2 颜色分级 / C2 撤销重做)。
 *
 * 用法:node apps/web/scripts/p4-browser-acceptance.mjs <round>   (round = 1|2)
 * 产物:test-output/p4-browser-20261002/round<N>/*.png + report-round<N>.json
 *
 * 基建复用 isolatedStudioGate(独立端口/独立数据目录/OBJECT_STORE=local/不触碰用户数据)。
 * 正式测试集与浏览器产品链分离:四题既有测试由 vitest 单独跑绿(见验收报告),
 * 本脚本只生产真实浏览器操作证据;1920×1080 深色,两轮独立。
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir as mkdirAsync } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";

const round = Number(process.argv[2] ?? "1");
assert.ok(round === 1 || round === 2, "用法:node p4-browser-acceptance.mjs <1|2>");
const c2Only = process.argv.includes("--c2-only");
const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const colorGate = process.argv.includes("--color-gate");
const outputDirectory = c2Only ? `test-output/three-migration-bench-20261002/${colorGate ? "c2-b2-color-browser" : "c2-browser"}/round${round}` : `test-output/p4-browser-20261002/round${round}`;
const outputRoot = resolve(repositoryRoot, outputDirectory);
await mkdirAsync(outputRoot, { recursive: true });

const report = { round, startedAt: new Date().toISOString(), steps: [], assertions: [], screenshots: [], failures: [] };
const step = (id, detail) => { report.steps.push({ id, ...(detail ? { detail } : {}) }); console.log(`  ✓ ${id}${detail ? ` — ${JSON.stringify(detail)}` : ""}`); };
const check = (id, ok, detail) => {
  report.assertions.push({ id, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  if (!ok) report.failures.push(id);
  console.log(`  ${ok ? "✓" : "✗"} assert ${id}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  assert.ok(ok, `断言失败: ${id}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};
const shot = async (page, name) => {
  await page.screenshot({ path: resolve(outputRoot, `${name}.png`) });
  report.screenshots.push(`${outputDirectory}/${name}.png`);
};

/* 两实例夹具:一根底盘(parent)带一根立柱(child),两套 PBR 材质,名字可断言。 */
function writeP4FixtureGltf(filePath) {
  const box = (cx, cy, cz, hx, hy, hz) => {
    const points = [];
    for (const dz of [-1, 1]) for (const dy of [-1, 1]) for (const dx of [-1, 1]) points.push([cx + dx * hx, cy + dy * hy, cz + dz * hz]);
    return points;
  };
  const face = [
    [0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1],
    [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3],
  ];
  const base = box(0, 0.15, 0, 0.9, 0.15, 0.9);
  const post = box(0, 0.8, 0, 0.18, 0.5, 0.18);
  const positions = new Float32Array([...base.flat(), ...post.flat()]);
  const normals = new Float32Array(positions.length);
  for (let index = 0; index < positions.length; index += 3) normals[index + 1] = 1;
  const indices = [];
  for (let boxIndex = 0; boxIndex < 2; boxIndex += 1) for (const [a, b, c] of face) indices.push(a + boxIndex * 8, b + boxIndex * 8, c + boxIndex * 8);
  const indexU16 = new Uint16Array(indices);
  const binary = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(normals.buffer), Buffer.from(indexU16.buffer)]);
  const document = {
    asset: { version: "2.0", generator: "DeepMonkey Studio p4 browser acceptance" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "P4-底盘", mesh: 0, children: [1] },
      { name: "P4-立柱", mesh: 1 },
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 4, material: 0 }] },
      { primitives: [{ attributes: { POSITION: 2, NORMAL: 3 }, indices: 4, material: 1 }] },
    ],
    materials: [
      { name: "P4-赤陶", pbrMetallicRoughness: { baseColorFactor: [0.78, 0.26, 0.18, 1], metallicFactor: 0.05, roughnessFactor: 0.42 } },
      { name: "P4-釉青", pbrMetallicRoughness: { baseColorFactor: [0.16, 0.62, 0.5, 1], metallicFactor: 0.55, roughnessFactor: 0.18 } },
    ],
    buffers: [{ byteLength: binary.length, uri: `data:application/octet-stream;base64,${binary.toString("base64")}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.buffer.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positions.buffer.byteLength, byteLength: normals.buffer.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positions.buffer.byteLength * 2, byteLength: indexU16.buffer.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", byteOffset: 0, min: [-0.9, 0, -0.9], max: [0.9, 0.3, 0.9] },
      { bufferView: 1, componentType: 5126, count: 8, type: "VEC3", byteOffset: 0 },
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", byteOffset: 96, min: [-0.18, 0.3, -0.18], max: [0.18, 1.3, 0.18] },
      { bufferView: 1, componentType: 5126, count: 8, type: "VEC3", byteOffset: 96 },
      { bufferView: 2, componentType: 5123, count: indices.length, type: "SCALAR" },
    ],
  };
  writeFileSync(filePath, `${JSON.stringify(document)}\n`, "utf8");
}

const CLEARCOAT_SOURCE = [
  "shader deep.material {",
  "  surface standard;",
  "  baseColor [0.12, 0.42, 0.9, 1];",
  "  metallic 0.65;",
  "  roughness 0.24;",
  "  clearcoatFactor 0.85;",
  "  clearcoatRoughness 0.08;",
  "  alpha opaque;",
  "  doubleSided false;",
  "  baseColorTexture off;",
  "}",
].join("\n");
const CLEARCOAT_INVALID = CLEARCOAT_SOURCE.replace("clearcoatFactor 0.85;", "clearcoatFactor 1.5;");
/* v2 合法 DeepSL(编辑器当前 ABI 可编译):用于作者态持久化链证据。 */
const V2_SHADER_SOURCE = [
  "shader deep.material {",
  "  surface standard;",
  "  baseColor [0.16, 0.38, 0.82, 1];",
  "  metallic 0.55;",
  "  roughness 0.3;",
  "  alpha opaque;",
  "  doubleSided false;",
  "  baseColorTexture off;",
  "}",
].join("\n");

const gate = await createIsolatedStudioGate("p4-browser-acceptance", process.env.BIM_P4_WEB_ROOT ? { webRoot: process.env.BIM_P4_WEB_ROOT } : {});
let page;
try {
  const context = await gate.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const consoleLogs = [];
  page.on("console", (entry) => { if (entry.type() === "error" || entry.type() === "warning") consoleLogs.push(`${entry.type()}: ${entry.text().slice(0, 220)}`); });
  page.on("dialog", (dialog) => void dialog.accept("P4-验收编组"));
  // 深色主题(默认即深色;显式锁定防环境漂移)。
  await page.route("**/api/public/branding", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), themeMode: "dark" } });
  });

  const setPanelControlsPassthrough = (on) => page.evaluate((value) => {
    for (const element of document.querySelectorAll(".workspace-panel-controls, .workspace-panel-controls *")) {
      element.style.pointerEvents = value ? "none" : "";
    }
  }, on);
  const canvasClick = async (x, y) => {
    await setPanelControlsPassthrough(true);
    try { await page.locator('.viewport canvas:not([aria-hidden="true"])').click({ position: { x, y } }); }
    finally { await setPanelControlsPassthrough(false); }
  };
  const setRange = async (locator, value) => {
    await locator.evaluate((element, next) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(element, String(next));
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  };
  const openAppearance = async () => {
    await page.getByRole("button", { name: "概览", exact: true }).click();
    const appearance = page.locator("details.inspector-appearance-settings").first();
    if ((await appearance.getAttribute("open")) === null) await page.locator("details.inspector-appearance-settings > summary").first().click();
    await page.locator(".material-editor").waitFor();
    return appearance;
  };
  const selectRow = async (index) => {
    await page.locator(".asset-row").filter({ hasText: "p4-fixture" }).nth(index).locator(".asset-main").click();
    await page.locator(".right-panel .inspector-context-tabs").waitFor();
  };
  const saveScene = async () => {
    // 「保存项目」走项目级保存链(可能 PUT /scenes/{id} 或项目端点),按非 GET 项目请求捕获。
    const response = page.waitForResponse((candidate) => {
      const method = candidate.request().method();
      return method !== "GET" && candidate.url().includes(`/api/projects/${project.id}`);
    }, { timeout: 120_000 });
    const saveButton = page.getByRole("button", { name: "保存项目" });
    await saveButton.click();
    let saved;
    try {
      saved = await response;
    } catch (error) {
      await shot(page, "diag-save-no-put");
      const toasts = await page.locator("[role=alert], .toast, .message, [class*=toast]").allInnerTexts().catch(() => []);
      console.log("  [diag] save NO PUT; toasts:", JSON.stringify(toasts));
      console.log("  [diag] pageErrors:", JSON.stringify(pageErrors.slice(-5)));
      throw error;
    }
    assert.ok(saved.ok(), `保存请求失败: ${saved.request().method()} ${saved.url()} → ${saved.status()}`);
    await page.waitForTimeout(800);
    return saved.status();
  };
  // 平铺对象列表可见(沿 showFlatSceneObjects 的既有开关语义)。
  const ensureFlatList = async () => {
    const organizationToggle = page.getByRole("button", { name: "场景图层与编组" });
    if (await organizationToggle.count() && (await organizationToggle.getAttribute("class"))?.includes("active")) await organizationToggle.click();
    const resourceToggle = page.getByRole("button", { name: "项目资源" });
    if (await resourceToggle.count() && (await resourceToggle.getAttribute("class"))?.includes("active")) await resourceToggle.click();
    await page.locator(".asset-list").waitFor({ state: "visible", timeout: 30_000 });
  };
  const reloadEditor = async () => {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor({ timeout: 90_000 });
    await page.waitForTimeout(1500);
    await ensureFlatList();
  };
  const readAdjustment = async (labelText) =>
    page.locator(".material-color-adjustment label").filter({ has: page.locator("span", { hasText: labelText }) }).locator("output")
      .evaluate((element) => element.textContent ?? "");

  /* ---------------- 场景准备 ---------------- */
  const project = await gate.json("POST", "/api/projects", { name: `P4 浏览器验收-轮${round}` });
  await gate.loginPage(page);
  await page.getByLabel("当前项目").selectOption(project.id);
  await page.getByRole("button", { name: "项目场景", exact: true }).click();
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("P4 浏览器验收场景");
  const application = await (async () => {
    const response = page.waitForResponse((candidate) =>
      candidate.url().includes(`/api/projects/${project.id}/applications`) && candidate.request().method() === "POST");
    await page.getByRole("button", { name: "创建并进入" }).click();
    return response.then((entry) => entry.json());
  })();
  const scene = application.scenes?.[0];
  check("scene-created", Boolean(scene?.id && application.metadata?.id), { projectId: project.id, sceneId: scene?.id });
  const sceneCreatedAt = scene.updatedAt ?? scene.createdAt;
  const sceneEditorUrl = `${gate.origin}/studio/${encodeURIComponent(project.id)}/applications/${encodeURIComponent(application.metadata.id)}/scenes/${encodeURIComponent(scene.id)}`;
  await page.goto(sceneEditorUrl, { waitUntil: "networkidle", timeout: 90_000 });
  await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor();
  const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  check("dark-theme", theme !== "light", { theme });
  await shot(page, "00-scene-editor-empty");
  step("scene-editor-ready");

  if (!c2Only) {
  /* ---------------- 对象素材:1 个 glTF 实例(内部层级+双材质)+ 2 个画布点放图元 ---------------- */
  const fixturePath = resolve(outputRoot, "p4-fixture.gltf");
  writeP4FixtureGltf(fixturePath);
  const waitUntilServer = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await predicate().catch(() => undefined);
      if (last) return last;
      await new Promise((done) => setTimeout(done, 1000));
    }
    throw new Error(`等待超时: ${label}`);
  };
  {
    const uploadResponse = page.waitForResponse((candidate) =>
      candidate.url().includes(`/api/projects/${project.id}/models?`) && candidate.request().method() === "POST");
    await page.locator('input[type="file"][accept*=".glb"]').setInputFiles(fixturePath);
    const uploaded = await uploadResponse.then((entry) => entry.json());
    await waitUntilServer(async () => {
      const body = await gate.json("GET", `/api/projects/${project.id}`);
      return body.models?.some((model) => model.id === uploaded.id && model.status === "ready");
    }, 60_000, "模型资源 ready");
    await page.getByRole("dialog").getByRole("button", { name: "直接插入" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 30_000 }).catch(() => undefined);
  }
  // 两个图元走真实产品入口:创建 → 插入基础元素 → 立方体 → 画布点击放置。
  const placePrimitive = async (x, y) => {
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("menuitem", { name: "立方体", exact: true }).click();
    await page.waitForTimeout(400);
    await canvasClick(x, y);
    await page.waitForTimeout(600);
  };
  await placePrimitive(800, 420);
  await placePrimitive(560, 620);
  await ensureFlatList();
  const fixtureRows = page.locator(".asset-row").filter({ hasText: "p4-fixture" });
  const primitiveRows = page.locator(".asset-row").filter({ hasText: "立方体" });
  await fixtureRows.first().waitFor({ timeout: 60_000 });
  await primitiveRows.nth(1).waitFor({ timeout: 60_000 });
  const rowNames = await page.locator(".asset-row").allInnerTexts();
  check("objects-inserted", (await fixtureRows.count()) === 1 && (await primitiveRows.count()) === 2,
    { rowNames });
  await shot(page, "01-a4-before-objects");

  // 图元 1 挪开并给出一个可对拍的变换基准(位置 X=3,经检查器真实输入)。
  await selectRow(0);
  await page.getByRole("button", { name: "概览", exact: true }).click();
  const positionFieldset = page.locator("fieldset.transform-fields").filter({ has: page.locator("legend", { hasText: "位置" }) });
  const positionX = positionFieldset.locator("label").filter({ has: page.locator("span", { hasText: "X" }) }).locator("input");
  await positionX.fill("3");
  await positionX.press("Enter");
  await page.waitForTimeout(700);
  await shot(page, "02-a4-before-viewport");

  /* ================= A4 场景快照往返 ================= */
  // 显式保存持久化"保存前"状态;服务端快照只由保存链写入。
  // glTF 实例在 models[],画布点放的基础元素在 primitives[](SceneSnapshot 两个集合)。
  await saveScene();
  const before = await gate.json("GET", `/api/projects/${project.id}/scenes/${scene.id}`);
  // 零调整恒等契约(studioUngradedColor 链):显式 0 ≡ 缺省,规范化后比较。
  const canonicalObjects = (snapshot) => JSON.stringify({ models: snapshot.models, primitives: snapshot.primitives },
    (key, value) => ((key === "hue" || key === "saturation" || key === "brightness" || key === "contrast") && value === 0 ? undefined : value));
  const beforeObjects = canonicalObjects(before);
  check("a4-before-has-models", before.models.length === 1 && before.primitives.length === 2,
    { models: before.models.length, primitives: before.primitives.length });
  const movedBefore = [...before.models, ...before.primitives].find((model) => Math.abs((model.transform?.position?.x ?? 0) - 3) < 1e-6);
  check("a4-before-transform-moved", Boolean(movedBefore), { x: movedBefore?.transform?.position?.x, name: movedBefore?.name });
  // 保存已被接受:models/primitives 已带变换持久化(上一断言);revision 语义由保存链 CAS 收据承担。
  step("a4-saved");

  await reloadEditor();
  await waitUntilServer(async () => {
    const body = await gate.json("GET", `/api/projects/${project.id}/scenes/${scene.id}`);
    return body.models?.length >= 1 && body.primitives?.length >= 2;
  }, 90_000, "重开后场景快照");
  await fixtureRows.first().waitFor({ timeout: 60_000 });
  await primitiveRows.nth(1).waitFor({ timeout: 60_000 });
  const afterRows = await page.locator(".asset-row").allInnerTexts();
  check("a4-after-objects-restored", afterRows.length === rowNames.length, { before: rowNames, after: afterRows });
  await shot(page, "03-a4-after-viewport");

  const after = await gate.json("GET", `/api/projects/${project.id}/scenes/${scene.id}`);
  const afterObjects = canonicalObjects(after);
  if (afterObjects !== beforeObjects) {
    let cursor = 0;
    while (cursor < Math.min(afterObjects.length, beforeObjects.length) && afterObjects[cursor] === beforeObjects[cursor]) cursor += 1;
    console.log("  [diag] roundtrip diff at", cursor,
      "\n  before:", beforeObjects.slice(Math.max(0, cursor - 120), cursor + 160),
      "\n  after :", afterObjects.slice(Math.max(0, cursor - 120), cursor + 160));
  }
  check("a4-roundtrip-models-identical", afterObjects === beforeObjects,
    { note: "models+primitives 规范化一致(零调整恒等契约;对象/名称/变换/材质/显隐)" });
  step("a4-roundtrip-verified");

  /* ================= 编组(场景层级,供 A4 往返与截图) ================= */
  // 平铺目录:Ctrl+多选图元 1 与 glTF 实例 → 选中栏「编组所选对象」。
  await primitiveRows.first().locator(".asset-main").click();
  await fixtureRows.first().locator(".asset-main").click({ modifiers: ["Control"] });
  const selectionBar = page.locator(".scene-tree-selection-bar");
  await selectionBar.waitFor({ timeout: 15_000 });
  const barCount = (await selectionBar.locator(".scene-selection-count strong").innerText()).trim();
  check("flat-two-selected", barCount === "2", { barCount });
  await selectionBar.getByRole("button", { name: "编组所选对象" }).click();
  await page.locator(".scene-layer-group").waitFor({ timeout: 15_000 });
  const groupName = (await page.locator(".scene-layer-group .scene-layer-group-name").first().innerText()).trim();
  await shot(page, "04-a4-group-created");
  check("group-created", Boolean(groupName), { groupName });

  await saveScene();
  await reloadEditor();
  await page.locator(".scene-layer-group").first().waitFor({ timeout: 30_000 });
  const afterGroupScene = await gate.json("GET", `/api/projects/${project.id}/scenes/${scene.id}`);
  const groupAfter = (afterGroupScene.selectionSets ?? []).find((item) => item.kind === "group");
  check("a4-group-roundtrip", Boolean(groupAfter) && groupAfter.objectIds.length === 2,
    { name: groupAfter?.name, members: groupAfter?.objectIds?.length });
  await shot(page, "05-a4-group-after-reload");
  step("a4-hierarchy-roundtrip-verified");

  /* ================= B1 材质升级 clearcoat(DeepSL→I23 分层参数) ================= */
  await page.locator(".asset-row").filter({ hasText: "p4-fixture" }).first().locator(".asset-main").click();
  await page.locator(".right-panel .inspector-context-tabs").waitFor();
  await openAppearance();
  const deepsl = page.locator("details.custom-shader-editor");
  if ((await deepsl.getAttribute("open")) === null) await deepsl.locator("summary").click();
  const source = page.locator("#custom-shader-source");
  // 证据 1:活动层参数 fail-closed —— clearcoatFactor 越界被精确拒绝,不静默丢失。
  await source.fill(CLEARCOAT_INVALID);
  await deepsl.getByRole("button", { name: "绑定到材质" }).click();
  await page.locator(".custom-shader-result").waitFor();
  const invalidText = await page.locator(".custom-shader-result").innerText();
  check("b1-failclosed-invalid-clearcoat", invalidText.includes("编译失败")
    && invalidText.includes("clearcoatFactor must be between 0 and 1"), { summary: invalidText.slice(0, 160) });
  check("b1-invalid-not-bound", (await deepsl.locator("summary small").innerText()).includes("未绑定"));
  await shot(page, "06-b1-failclosed-invalid");
  // 证据 2:clearcoat 扩展在当前编辑器 ABI(deep.pbr.mesh.v2)下 fail-closed,
  // 精确登记缺口:v3 运行时材质链未接,编辑器入口拒绝而非静默降级。
  await source.fill(CLEARCOAT_SOURCE);
  await deepsl.getByRole("button", { name: "绑定到材质" }).click();
  await page.waitForTimeout(600);
  const v3GateText = await page.locator(".custom-shader-result").innerText();
  check("b1-failclosed-v2-entry-rejects-clearcoat", v3GateText.includes("编译失败")
    && v3GateText.includes("deep.pbr.mesh.v3"), { summary: v3GateText.slice(0, 160) });
  check("b1-clearcoat-not-silently-dropped", (await deepsl.locator("summary small").innerText()).includes("未绑定"));
  await shot(page, "07-b1-clearcoat-v3-gap-registered");
  // 证据 3:DeepSL 作者态持久化链(v2 合法源):绑定 → 保存 → 重开 → 源码逐字节保持。
  await source.fill(V2_SHADER_SOURCE);
  let v2Bound = false;
  for (let attempt = 0; attempt < 3 && !v2Bound; attempt += 1) {
    await deepsl.getByRole("button", { name: "绑定到材质" }).click();
    try {
      await page.locator(".custom-shader-result", { hasText: "编译通过" }).waitFor({ timeout: 8000 });
      v2Bound = true;
    } catch {
      const dump = await page.locator(".custom-shader-result").innerText().catch(() => "(no result)");
      console.log(`  [diag] v2 bind attempt ${attempt + 1}:`, JSON.stringify(dump.slice(0, 200)));
      await source.fill("");
      await source.fill(V2_SHADER_SOURCE);
    }
  }
  check("b1-v2-source-compiles", v2Bound, {});
  check("b1-bound", (await deepsl.locator("summary small").innerText()).includes("已绑定"));
  await shot(page, "08-b1-deepsl-bound");

  await saveScene();
  const afterB1 = await gate.json("GET", `/api/projects/${project.id}/scenes/${scene.id}`);
  const boundModel = afterB1.models.find((model) => model.material?.customShader?.source === V2_SHADER_SOURCE);
  check("b1-persisted-customshader", Boolean(boundModel), { model: boundModel?.name });
  step("b1-saved");

  await reloadEditor();
  await page.locator(".asset-row").filter({ hasText: "p4-fixture" }).first().waitFor({ timeout: 90_000 });
  await selectRow(0);
  await openAppearance();
  const deepslAfter = page.locator("details.custom-shader-editor");
  await deepslAfter.locator("summary").waitFor();
  check("b1-reload-still-bound", (await deepslAfter.locator("summary small").innerText()).includes("已绑定"));
  const reopenedSource = await deepslAfter.locator("#custom-shader-source").inputValue();
  check("b1-reload-source-identical", reopenedSource === V2_SHADER_SOURCE);
  await shot(page, "09-b1-deepsl-after-reload");
  step("b1-roundtrip-verified");

  /* ================= B2 颜色分级(亮度/对比度 → studioUngradedColor+colorAdjustment 链) ================= */
  const adjustment = page.locator(".material-color-adjustment");
  if ((await adjustment.getAttribute("open")) === null) await adjustment.locator("summary").click();
  const brightnessRange = adjustment.locator("label").filter({ has: page.locator("span", { hasText: "亮度" }) }).locator("input[type=range]");
  const contrastRange = adjustment.locator("label").filter({ has: page.locator("span", { hasText: "对比度" }) }).locator("input[type=range]");
  check("b2-controls-present", (await brightnessRange.count()) === 1 && (await contrastRange.count()) === 1, {});
  await setRange(brightnessRange, 0.3);
  await setRange(contrastRange, -0.25);
  await page.waitForTimeout(500);
  const brightnessValue = await readAdjustment("亮度");
  const contrastValue = await readAdjustment("对比度");
  check("b2-adjusted", brightnessValue.startsWith("0.30") && contrastValue.startsWith("-0.25"), { brightnessValue, contrastValue });
  await shot(page, "10-b2-color-adjusted");
  step("b2-adjusted");

  await saveScene();
  const afterB2 = await gate.json("GET", `/api/projects/${project.id}/scenes/${scene.id}`);
  const gradedModel = afterB2.models.find((model) =>
    Math.abs((model.material?.brightness ?? 0) - 0.3) < 1e-6 && Math.abs((model.material?.contrast ?? 0) + 0.25) < 1e-6);
  check("b2-persisted-grading", Boolean(gradedModel), { model: gradedModel?.name, material: gradedModel?.material });
  step("b2-saved");

  await reloadEditor();
  await page.locator(".asset-row").filter({ hasText: "p4-fixture" }).first().waitFor({ timeout: 90_000 });
  await selectRow(0);
  await openAppearance();
  const adjustmentAfter = page.locator(".material-color-adjustment");
  if ((await adjustmentAfter.getAttribute("open")) === null) await adjustmentAfter.locator("summary").click();
  const brightnessAfter = await readAdjustment("亮度");
  const contrastAfter = await readAdjustment("对比度");
  check("b2-reload-grading-kept", brightnessAfter.startsWith("0.30") && contrastAfter.startsWith("-0.25"),
    { brightnessAfter, contrastAfter });
  await shot(page, "11-b2-after-reload");

  // zero 调整逐位恒等(产品入口:重置颜色调整)——浏览器侧复核 spec 的 zero 恒等门。
  await adjustmentAfter.getByRole("button", { name: "重置颜色调整" }).click();
  await page.waitForTimeout(400);
  const zeroBrightness = await readAdjustment("亮度");
  const zeroContrast = await readAdjustment("对比度");
  check("b2-reset-to-zero", zeroBrightness.startsWith("0.00") && zeroContrast.startsWith("0.00"),
    { zeroBrightness, zeroContrast });
  await setRange(brightnessRange, 0.3);
  await setRange(contrastRange, -0.25);
  await page.waitForTimeout(400);
  await shot(page, "12-b2-restored-values");
  step("b2-roundtrip-verified");

  }

  /* ================= C2:ten GUI edits → ten single-key undo → ten single-key redo ================= */
  // --c2-only skips previously verified tasks and preserves their old reports/screenshots.
  await page.getByRole("button", { name: "场景管理", exact: true }).click();
  await page.getByRole("button", { name: "项目场景", exact: true }).click();
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("P4 撤销重做链场景");
  const created = page.waitForResponse(response => response.url().includes(`/api/projects/${project.id}/applications`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "创建并进入" }).click();
  const application2 = await (await created).json();
  const scene2 = application2.scenes?.[0];
  check("c2-scene-created", Boolean(scene2?.id), { sceneId: scene2?.id });
  await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor();
  await ensureFlatList();
  const primitive = page.locator(".asset-row").filter({ hasText: "立方体" });
  const selectPrimitive = async () => {
    await primitive.first().locator(".asset-main").click();
    await page.locator(".right-panel .inspector-context-tabs").waitFor();
    await openAppearance();
  };
  const field = (legend, axis) => page.locator("fieldset.transform-fields")
    .filter({ has: page.locator("legend", { hasText: legend }) })
    .locator("label").filter({ has: page.locator("span", { hasText: axis }) }).locator("input");
  const adjustment = page.locator(".material-color-adjustment");
  const control = label => adjustment.locator("label")
    .filter({ has: page.locator("span", { hasText: label }) }).locator("input[type=range]");
  const readState = async () => {
    const count = await primitive.count();
    if (count === 0) return { count: 0 };
    await selectPrimitive();
    if ((await adjustment.getAttribute("open")) === null) await adjustment.locator("summary").click();
    return { count, position: await Promise.all(["X", "Y", "Z"].map(async axis => Number(await field("位置", axis).inputValue()))),
      rotation: await Promise.all(["X", "Y", "Z"].map(async axis => Number(await field("旋转", axis).inputValue()))),
      scale: await Promise.all(["X", "Y", "Z"].map(async axis => Number(await field("缩放", axis).inputValue()))),
      brightness: Number(await readAdjustment("亮度")), contrast: Number(await readAdjustment("对比度")),
      ...(colorGate ? { renderedColor: (await page.locator(".right-panel input[type=color]").first().inputValue()).toUpperCase() } : {}) };
  };
  const fillTransform = async (legend, axis, value) => { const input = field(legend, axis); await input.fill(String(value)); await input.press("Enter"); };
  const setGrading = async (label, value) => {
    // Real keyboard range interaction; no DOM assignment or synthetic input/change.
    const range = control(label);
    await range.focus(); await range.press("Home");
    const stepSize = Number(await range.getAttribute("step"));
    const min = Number(await range.getAttribute("min"));
    const moves = Math.round((value - min) / stepSize);
    for (let i = 0; i < moves; i++) await range.press("ArrowRight");
  };
  const actions = [
    ["create", async () => { await page.getByRole("button", { name: "创建", exact: true }).click();
      await page.getByRole("menuitem", { name: "立方体", exact: true }).click();
      await page.locator('.viewport canvas:not([aria-hidden="true"])').click({ position: { x: 700, y: 420 } }); await primitive.first().waitFor(); }],
    ["position-x", () => fillTransform("位置", "X", 2)],
    ["position-y", () => fillTransform("位置", "Y", 3)],
    ["position-z", () => fillTransform("位置", "Z", -1)],
    ["rotation-z", () => fillTransform("旋转", "Z", 45)],
    ["rotation-y", () => fillTransform("旋转", "Y", 30)],
    ["scale-x", () => fillTransform("缩放", "X", 1.5)],
    ["scale-y", () => fillTransform("缩放", "Y", 0.75)],
    ["brightness", () => setGrading("亮度", 0.35)],
    ["contrast", () => setGrading("对比度", -0.3)],
  ];
  const states = [await readState()];
  check("c2-baseline-empty", states[0].count === 0, states[0]);
  for (const [index, [label, action]] of actions.entries()) {
    await action();
    await page.waitForTimeout(300); // existing 220ms author-history debounce, not a restore retry
    const current = await readState();
    check(`c2-edit-${index + 1}-${label}`, JSON.stringify(current) !== JSON.stringify(states.at(-1)), current);
    states.push(current);
    await shot(page, `c2-edit-${String(index + 1).padStart(2, "0")}`);
  }
  const singleHistoryKey = async (key, expected, label) => {
    const button = page.locator(".scene-history-controls button").nth(key === "Control+z" ? 0 : 1);
    await button.waitFor();
    assert.equal(await button.isDisabled(), false, `${label}: history action must be available`);
    await page.locator(".scene-title-wrap > span").click();
    await page.keyboard.press(key); // exactly one key; never retry/pop to conceal a phantom
    await page.waitForTimeout(300);
    let actual;
    const deadline = Date.now() + 15000;
    do {
      actual = await readState();
      if (JSON.stringify(actual) === JSON.stringify(expected)) break;
      await page.waitForTimeout(200);
    } while (Date.now() < deadline);
    await shot(page, label);
    check(label, JSON.stringify(actual) === JSON.stringify(expected), { expected, actual });
  };
  for (let i = 9; i >= 0; i--) await singleHistoryKey("Control+z", states[i], `c2-undo-${10 - i}`);
  check("c2-undo-drains-ten", await page.locator(".scene-history-controls button").nth(0).isDisabled());
  for (let i = 1; i <= 10; i++) await singleHistoryKey("Control+y", states[i], `c2-redo-${i}`);
  check("c2-redo-drains-ten", await page.locator(".scene-history-controls button").nth(1).isDisabled());
  step("c2-ten-step-chain-verified", { edits: 10, undo: 10, redo: 10, retryKeys: 0 });

  if (colorGate) {
    const authored = states.at(-1);
    check("b2-nonzero-grading-positive-control", authored.renderedColor !== states[8].renderedColor
      && authored.brightness === 0.35 && authored.contrast === -0.3, { before: states[8], graded: authored });
    const saveRequest = page.waitForResponse(response => response.request().method() !== "GET" && response.url().includes(`/api/projects/${project.id}`));
    await page.getByRole("button", { name: "保存项目" }).click();
    const savedResponse = await saveRequest;
    check("b2-save-success", savedResponse.ok(), { status: savedResponse.status() });
    const persisted = await gate.json("GET", `/api/projects/${project.id}/scenes/${scene2.id}`);
    const material = persisted.primitives[0]?.material;
    check("b2-persisted-ungraded-authority", material?.color?.toUpperCase() === states[8].renderedColor
      && material.brightness === 0.35 && material.contrast === -0.3, { material, neutralColor: states[8].renderedColor });
    await shot(page, "b2-before-reload");
    await page.reload({ waitUntil: "networkidle" });
    await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor(); await ensureFlatList();
    const reloaded = await readState();
    check("b2-reloaded-color-and-controls-identical", JSON.stringify(reloaded) === JSON.stringify(authored), { expected: authored, actual: reloaded });
    await shot(page, "b2-after-reload");
    await adjustment.getByRole("button", { name: "重置颜色调整" }).click();
    const zero = await readState();
    check("b2-zero-color-identity", zero.brightness === 0 && zero.contrast === 0 && zero.renderedColor === states[8].renderedColor,
      { neutralColor: states[8].renderedColor, actual: zero });
    await shot(page, "b2-zero-restored");
  }

  /* ---------------- 收尾 ---------------- */
  report.pageErrors = pageErrors;
  report.consoleLogs = consoleLogs;
  check("no-page-errors", pageErrors.length === 0, { pageErrors: pageErrors.slice(0, 5) });
  report.passed = true;
  console.log(`\nP4 浏览器验收 轮${round}: ${report.assertions.filter((item) => item.ok).length}/${report.assertions.length} 断言通过,截图 ${report.screenshots.length} 张`);
  console.log(`产物目录: ${outputDirectory}`);
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) await shot(page, "failure-final").catch(() => undefined);
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(resolve(outputRoot, `report-round${round}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await gate.close();
}
