import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";

const gate = await createIsolatedStudioGate("sdk-examples");
const diagnostic = process.argv.includes("--diagnostic");
const bundlePath = new URL("../dist/index.html", import.meta.url);
const bundleFingerprint = async () => createHash("sha256").update(await readFile(bundlePath)).digest("hex");
const report = { createdAt: new Date().toISOString(), diagnostic, bundleFingerprint: await bundleFingerprint(), cases: [] };
const starter = 'function onStart() { studio.log("ORIGINAL"); }';
const modified = 'function onStart() { studio.log("RETAINED-DRAFT"); }';
const samples = [
  { title: "认识脚本生命周期", file: "sdk-lifecycle.js", log: "SDK 样例已启动" },
  { title: "读取应用变量", file: "sdk-read-variable.js", log: "变量尚无数据" },
  { title: "观察场景点击事件", file: "sdk-scene-events.js", log: "正在等待场景事件" },
];
try {
  for (const theme of ["dark", "light"]) for (const width of [1280, 980]) {
    const entry = { theme, width, passed: false, errors: [], errorDetails: [], driverWarnings: [], writes: [], workers: 0, closedWorkers: 0, steps: [] };
    report.cases.push(entry);
    const project = await gate.json("POST", "/api/projects", { name: `SDK 样例验收-${theme}-${width}` });
    const now = new Date().toISOString();
    const sceneId = randomUUID();
    const app = await gate.json("POST", `/api/projects/${project.id}/applications`, {
      schemaVersion: 2, metadata: { id: randomUUID(), projectId: project.id, name: "SDK 可运行样例", revision: 1, createdAt: now, updatedAt: now },
      pages: [{ id: "one", name: "样例试运行", width: 1000, height: 650, viewportFit: "contain", nodes: [{
        id: "view", name: "样例视口", kind: "scene-viewport", zIndex: 1, frame: { x: 70, y: 70, width: 860, height: 510 }, sceneId, renderMode: "realtime", interactionPolicy: "full-navigation", overlaySlot: "page",
      }] }],
      scenes: [{ id: sceneId, name: "样例场景", camera: { position: { x: 5, y: 4, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" }, models: [], primitives: [{
        modelId: "box", name: "验收对象", kind: "box", color: "#b5c7cc", visible: true, opacity: 1,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } },
      }], measurements: [] }],
      topologies: [], geo: { providerIds: [], layers: [] }, data: { connectionIds: [], datasetIds: [], transforms: [], variables: [] }, interactions: [],
      scripts: [{ id: "original", name: "original.js", code: starter, enabled: true, apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox", lifecycle: ["onStart"], capabilities: ["studio.runtime"], permissions: [], target: { kind: "scene" } }],
      assets: [], timelines: [], publicationProfiles: [{ id: "browser", name: "浏览器", target: "browser-preview", entryPageId: "one", renderer: "auto" }],
    });
    await gate.json("PUT", `/api/projects/${project.id}/scenes/${sceneId}`, { ...app.scenes[0], schemaVersion: 1, projectId: project.id, createdAt: now, updatedAt: now });
    const appPath = `/api/projects/${project.id}/applications/${app.metadata.id}`;
    const context = await gate.browser.newContext({ viewport: { width, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
    await context.route("**/api/public/branding", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), themeMode: theme, primaryColor: "#d6aa4d" } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(25000);
    page.on("worker", worker => { if (!worker.url().includes("sceneBehavior.worker")) return; entry.workers++; worker.on("close", () => entry.closedWorkers++); });
    page.on("request", request => { if (/^(POST|PUT|PATCH|DELETE)$/.test(request.method()) && request.url().includes("/api/") && !request.url().includes("/auth/")) entry.writes.push({ method: request.method(), url: request.url() }); });
    page.on("pageerror", error => { entry.errors.push(error.message); entry.errorDetails.push({ stack: error.stack, phase: entry.phase }); });
    page.on("console", message => {
      if (!["error", "warning"].includes(message.type())) return;
      const text = message.text();
      if (message.type() === "warning" && /THREE.WebGLProgram: Program Info Log:/.test(text) && /warning X4122/.test(text)) entry.driverWarnings.push(text);
      else { entry.errors.push(text); entry.errorDetails.push({ message: text, location: message.location(), phase: entry.phase }); }
    });
    const shot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`) });
    const docs = async () => {
      await page.getByRole("button", { name: "文档", exact: true }).click();
      await page.getByRole("navigation", { name: "文档目录", exact: true }).getByRole("button", { name: "SDK 可运行样例", exact: true }).click();
      await page.getByRole("region", { name: "可运行样例", exact: true }).waitFor();
    };
    const selectExample = sample => page.getByRole("navigation", { name: "选择 SDK 样例", exact: true }).getByRole("button", { name: new RegExp(sample.title) }).click();
    const add = async sample => {
      entry.phase = `insert-${sample.file}`;
      await selectExample(sample);
      await page.getByRole("button", { name: "在脚本编辑器中新增", exact: true }).click();
      await page.getByRole("button", { name: "确认新增", exact: true }).dblclick();
      await page.getByLabel("脚本名称", { exact: true }).waitFor();
      if (diagnostic) {
        await page.locator(".behavior-script-list > button").filter({ hasText: sample.file }).click();
        entry.steps.push("diagnostic-manual-file-selection-not-acceptance");
      }
      await page.waitForFunction(name => document.querySelector('input[aria-label="脚本名称"]')?.value === name, sample.file);
      entry.phase = `inserted-${sample.file}`;
    };
    const replace = async code => {
      await page.locator(".monaco-editor").click({ position: { x: 150, y: 65 } });
      await page.keyboard.press("Control+A"); await page.keyboard.press("Backspace");
      await page.keyboard.insertText(code.endsWith("}") ? code.slice(0, -1) : code);
      await page.getByText("有未应用的修改", { exact: true }).waitFor();
    };
    try {
      await gate.loginPage(page);
      await page.goto(`${gate.origin}/docs/sdk-examples`);
      assert.equal(await page.getByRole("button", { name: "在脚本编辑器中新增", exact: true }).isDisabled(), true);
      entry.steps.push("signed-in-without-editor-cannot-insert");
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${app.metadata.id}/pages/one`);
      await page.getByRole("checkbox", { name: "自动保存", exact: true }).uncheck();
      await page.getByRole("button", { name: "脚本", exact: true }).click();
      await page.locator(".monaco-editor .view-lines").waitFor();
      await page.getByLabel("脚本名称", { exact: true }).fill("");
      await page.getByRole("button", { name: "文档", exact: true }).click();
      assert.equal(await page.locator(".docs-center-page").count(), 0);
      assert.equal(await page.getByLabel("脚本名称", { exact: true }).inputValue(), "");
      await page.getByLabel("脚本名称", { exact: true }).fill("original.js");
      await replace(modified);
      await docs();
      await page.getByRole("button", { name: "在脚本编辑器中新增", exact: true }).click();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      assert.equal(await page.getByRole("group", { name: "确认新增脚本" }).count(), 0);
      await page.getByRole("button", { name: "在脚本编辑器中新增", exact: true }).click();
      await page.keyboard.press("Escape");
      assert.equal(await page.getByRole("group", { name: "确认新增脚本" }).count(), 0);
      assert.equal(entry.workers, 0, "Opening or canceling an example must not start a behavior Worker");
      assert.equal(entry.writes.length, 0);
      entry.steps.push("unnamed-draft-blocks-docs-named-draft-preserved", "cancel-and-Escape-have-no-write-or-run");
      for (const size of [1920, width, 480]) {
        await page.setViewportSize({ width: size, height: 900 });
        if (size === 480) {
          await page.getByRole("button", { name: "文档目录", exact: true }).click();
          assert.equal(await page.getByRole("navigation", { name: "文档目录", exact: true }).isVisible(), true);
          await page.keyboard.press("Escape");
          assert.equal(await page.getByRole("navigation", { name: "文档目录", exact: true }).isVisible(), false);
        }
        await page.locator(".docs-article").evaluate(node => node.scrollTo(0, 0));
        await shot(`docs-${size}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Documentation must not overflow the viewport");
      }
      await page.setViewportSize({ width, height: 900 });
      entry.buttonStyles = await page.locator(".docs-sdk-primary").evaluate(node => {
        const result = [];
        for (let parent = node; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          result.push({ tag: parent.tagName, className: parent.className, color: style.color, background: style.backgroundColor });
        }
        return result;
      });
      entry.contrast = await page.locator("body").evaluate(collectTextContrast, ".docs-sdk-example-list strong,.docs-sdk-example-list small,.docs-sdk-example-number,.docs-sdk-example-facts dt,.docs-sdk-example-facts dd,.docs-sdk-example-detail h2,.docs-sdk-primary,.docs-markdown > p,.docs-center-brand strong");
      entry.lowContrast = entry.contrast.filter(item => item.text && item.contrast < 4.5);
      if (!diagnostic) assert.deepEqual(entry.lowContrast, [], "SDK documentation text contrast below 4.5:1");
      const insertionButton = page.getByRole("button", { name: "在脚本编辑器中新增", exact: true });
      await insertionButton.hover();
      entry.buttonHoverContrast = await page.locator("body").evaluate(collectTextContrast, ".docs-sdk-primary");
      assert.ok(entry.buttonHoverContrast.every(item => item.contrast >= 4.5));
      await insertionButton.focus();
      entry.buttonFocusOutline = await insertionButton.evaluate(node => getComputedStyle(node).outlineColor);
      await shot("insert-focused");
      for (const [index, sample] of samples.entries()) {
        if (index) await docs();
        await selectExample(sample);
        await page.locator(".docs-sdk-examples").getByRole("button", { name: /^复制代码/ }).click();
        assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes("studio."));
        const workersBefore = entry.workers;
        await add(sample);
        assert.equal(entry.workers, workersBefore, "Insert must not run the file");
        assert.equal(await page.locator(".behavior-script-list > button").count(), index + 2);
        await page.locator(".behavior-run-action").click();
        await page.locator(".behavior-console p").filter({ hasText: sample.log }).first().waitFor();
        if (sample.file === "sdk-scene-events.js") {
          const canvas = page.locator(".author-behavior-preview canvas").first();
          await canvas.waitFor();
          await canvas.click();
          await page.locator(".behavior-console p").filter({ hasText: "收到场景事件" }).first().waitFor();
        }
        await shot(`running-${sample.file}`);
        await page.getByRole("button", { name: "停止运行", exact: true }).click();
        entry.steps.push(`real-worker-${sample.file}`);
      }
      await docs();
      await add({ ...samples[0], file: "sdk-lifecycle-2.js" });
      assert.equal(await page.locator(".behavior-script-list > button").count(), 5);
      await page.locator(".behavior-script-list > button").filter({ hasText: "original.js" }).click();
      assert.match(await page.locator(".monaco-editor .view-lines").innerText(), /RETAINED-DRAFT/);
      assert.equal(entry.writes.length, 0);
      assert.equal((await gate.json("GET", appPath)).scripts.length, 1);
      assert.equal((await gate.json("GET", appPath)).scripts[0].code, starter);
      await page.getByRole("button", { name: "保存脚本", exact: true }).click();
      await page.getByText("脚本已保存", { exact: true }).waitFor();
      const saved = await gate.json("GET", appPath);
      assert.equal(saved.scripts.length, 5);
      assert.equal(saved.scripts.find(script => script.id === "original").code.replace(/\s/g, ""), modified.replace(/\s/g, ""));
      assert.equal(new Set(saved.scripts.map(script => script.id)).size, 5);
      assert.equal(new Set(saved.scripts.map(script => script.name)).size, 5);
      await page.reload();
      await page.getByRole("button", { name: "脚本", exact: true }).click();
      await page.getByLabel("脚本名称", { exact: true }).waitFor();
      assert.equal(await page.locator(".behavior-script-list > button").count(), 5);
      entry.steps.push("duplicate-numbered-existing-draft-retained", "manual-save-refresh-restores-five-independent-files");
      await page.getByRole("checkbox", { name: "自动保存", exact: true }).check();
      await docs();
      const workersBeforeAutoSave = entry.workers;
      const automaticSave = page.waitForResponse(response => response.url().endsWith(appPath) && response.request().method() === "PUT");
      await add({ ...samples[0], file: "sdk-lifecycle-3.js" });
      assert.equal((await automaticSave).status(), 200);
      assert.equal((await gate.json("GET", appPath)).scripts.length, 6);
      assert.equal(entry.workers, workersBeforeAutoSave, "Existing auto-save must not execute inserted examples");
      entry.steps.push("existing-auto-save-persists-only-new-file-without-running");
      if (width === 1280) {
        await page.goto(`${gate.origin}/studio/${project.id}/applications/${app.metadata.id}/scenes/${sceneId}`);
        const viewport = page.locator(".viewport canvas");
        await viewport.waitFor();
        await page.locator(".topbar-auto-save input").uncheck();
        await viewport.hover(); await page.mouse.wheel(0, -200);
        await page.getByRole("button", { name: "脚本", exact: true }).click();
        await page.locator(".monaco-editor .view-lines").waitFor();
        const writesBeforeReturn = entry.writes.length;
        await docs(); await add({ ...samples[0], file: "sdk-lifecycle-4.js" });
        await viewport.waitFor();
        assert.equal(entry.writes.length, writesBeforeReturn, "3D documentation return must retain camera edits without saving");
        const workspaceSave = page.waitForResponse(response => response.url().endsWith(`${appPath}/workspace`) && response.request().method() === "PUT");
        await page.getByRole("button", { name: "保存项目", exact: true }).click();
        const response = await workspaceSave; assert.equal(response.status(), 200);
        const savedWorkspace = await response.json();
        assert.equal(savedWorkspace.application.scripts.length, 7);
        assert.equal(savedWorkspace.scene.primitives.length, 1);
        assert.notDeepEqual(savedWorkspace.scene.camera.position, app.scenes[0].camera.position, "The changed camera must survive docs return");
        await shot("three-dimensional-return");
        entry.steps.push("3D-docs-return-keeps-unsaved-camera-and-adds-independent-file");
      }
      assert.equal(entry.writes.filter(write => !(write.url.endsWith(appPath) || write.url.endsWith(`${appPath}/workspace`)) || write.method !== "PUT").length, 0);
      assert.deepEqual(entry.errors, []);
      entry.passed = !diagnostic && entry.lowContrast.length === 0;
    } catch (error) { entry.failure = error.stack; await shot("failure").catch(() => {}); throw error; }
    finally { await context.close(); }
  }
  const anonymous = await gate.browser.newContext({ viewport: { width: 480, height: 900 } });
  try {
    const page = await anonymous.newPage();
    await page.goto(`${gate.origin}/docs/sdk-examples`);
    await page.getByText("请先登录并打开项目，再从编辑器进入文档新增样例。", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "在脚本编辑器中新增", exact: true }).isDisabled(), true);
    await page.screenshot({ path: resolve(gate.output, "anonymous-480.png") });
    report.anonymous = "readable-and-insertion-disabled";
  } finally { await anonymous.close(); }
} finally {
  try {
    report.finalBundleFingerprint = await bundleFingerprint();
    await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output: gate.output, passed: report.cases.every(entry => entry.passed), cases: report.cases.length }));
  } finally { await gate.close(); }
}
assert.equal(report.finalBundleFingerprint, report.bundleFingerprint, "The frozen product bundle changed during this gate");
