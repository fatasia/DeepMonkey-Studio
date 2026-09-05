import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";
import sharp from "sharp";

const gate = await createIsolatedStudioGate("author-script-runtime");
const report = { createdAt: new Date().toISOString(), cases: [] };
const code = label => `function onStart(ctx) { ctx.state.frame = 0; ctx.setData("testOnly", 42); ctx.log("${label}"); }
function onUpdate(ctx) { ctx.state.frame += 1; ctx.self.update({widget:{title:"${label} " + ctx.state.frame}}); }`;
const script = (id, target, source) => ({ id, name: id, enabled: true, apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox", code: source, lifecycle: ["onStart", "onUpdate"], capabilities: ["studio.runtime", "studio.component", "studio.data"], permissions: ["scene.read", "scene.write", "data.write"], target: { kind: "component", id: target } });
const widget = (id, y) => ({ id, name: id, kind: "data-widget", zIndex: 1, frame: { x: 40, y, width: 620, height: 180 }, widget: { type: "text", title: `草稿 ${id}`, key: "", unit: "", fontSize: 30, textColor: "#ffffff", backgroundColor: "#11191d" } });
try {
  for (const theme of ["dark", "light"]) for (const width of [1440, 980]) {
    const entry = { theme, width, passed: false, errors: [], driverWarnings: [], writes: 0, workers: 0, closedWorkers: 0, steps: [] };
    report.cases.push(entry);
    const project = await gate.json("POST", "/api/projects", { name: `作者运行隔离-${theme}-${width}` });
    const now = new Date().toISOString();
    const application = await gate.json("POST", `/api/projects/${project.id}/applications`, {
      schemaVersion: 2, metadata: { id: randomUUID(), projectId: project.id, name: "作者隔离工作台", revision: 1, createdAt: now, updatedAt: now },
      pages: [{ id: "one", name: "运行页", width: 720, height: 650, viewportFit: "contain", nodes: [widget("one", 50), widget("two", 280)] },
        { id: "private", name: "私有跳转页", width: 720, height: 650, viewportFit: "contain", nodes: [widget("private", 50)] }],
      scenes: [{ id: "scene", name: "试运行场景", camera: { position: { x: 5, y: 4, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" }, models: [], primitives: [{ modelId: "pump", name: "泵", kind: "box", color: "#ffffff", visible: true, opacity: 1, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } } }], measurements: [] }],
      topologies: [], geo: { providerIds: [], layers: [] }, data: { connectionIds: [], datasetIds: [], transforms: [], variables: [] },
      interactions: [{ id: "private-page", name: "私有页面跳转", source: { kind: "widget", id: "one" }, trigger: "click", enabled: true, actions: [{ id: "page", type: "dashboard", dashboardPageId: "private", enabled: true }] },
        { id: "external", name: "外链", source: { kind: "widget", id: "private" }, trigger: "click", enabled: true, actions: [{ id: "external", type: "openUrl", url: "https://example.test/author-test", enabled: true }] }],
      scripts: [script("main", "one", code("ORIGINAL")), script("other", "two", "function onStart(ctx) { ctx.self.update({widget:{title:'OTHER ACTIVE'}}); }"),
        { ...script("object-test", "pump", "function onStart(ctx) { ctx.self.setColor('#3ec6c1'); ctx.log('OBJECT READY'); }"), target: { kind: "object", id: "pump" }, capabilities: ["studio.runtime", "studio.object", "studio.data"] }],
      assets: [], timelines: [], publicationProfiles: [{ id: "browser", name: "浏览器", target: "browser-preview", entryPageId: "one", renderer: "auto" }],
    });
    const appPath = `/api/projects/${project.id}/applications/${application.metadata.id}`;
    const before = await gate.json("GET", appPath);
    const context = await gate.browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } }); });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["error", "warning"].includes(message.type())) return;
      const text = message.text();
      if (message.type() === "warning" && /^THREE\.WebGLProgram: Program Info Log:/.test(text) && /warning X4122: sum of/.test(text) && !/error/i.test(text)) entry.driverWarnings.push(text);
      else entry.errors.push(text);
    });
    page.on("request", request => { if (request.url().endsWith(appPath) && request.method() === "PUT") entry.writes++; });
    page.on("worker", worker => { if (worker.url().includes("sceneBehavior.worker")) { entry.workers++; worker.on("close", () => { entry.closedWorkers++; }); } });
    const shot = async name => {
      if (await page.locator(".monaco-editor").count()) { await page.locator(".monaco-editor").click({ position: { x: 160, y: 40 } }); await page.keyboard.press("Control+Home"); }
      await page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`) });
    };
    const replace = async text => {
      await page.locator(".monaco-editor").click({ position: { x: 180, y: 80 } });
      await page.keyboard.press("Control+A"); await page.keyboard.press("Backspace");
      await page.keyboard.insertText(text);
      await page.waitForTimeout(200);
      const visible = (await page.locator(".monaco-editor .view-lines").innerText()).replace(/\s/g, "");
      if (visible === text.replace(/\s/g, "") + "}") { await page.keyboard.press("Control+End"); await page.keyboard.press("Backspace"); }
      assert.equal((await page.locator(".monaco-editor .view-lines").innerText()).replace(/\s/g, ""), text.replace(/\s/g, ""), "Actual keyboard input must match the fixture source");
    };
    try {
      await gate.loginPage(page);
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/one`);
      await page.getByRole("button", { name: "脚本", exact: true }).click();
      await page.locator(".monaco-editor .view-lines").waitFor();
      await shot("before");
      await replace(code("LATEST")); await page.keyboard.press("Control+Enter");
      const preview = page.getByRole("region", { name: "脚本隔离预览", exact: true });
      const counter = preview.locator(".dashboard-text-widget").filter({ hasText: /^LATEST/ });
      await counter.waitFor();
      assert.equal(await preview.getByText("OTHER ACTIVE", { exact: true }).count(), 0);
      await preview.getByText("草稿 two", { exact: true }).waitFor();
      await page.getByRole("button", { name: "暂停运行", exact: true }).click();
      const step = page.getByRole("button", { name: "推进一帧（1/60 秒，非源码单步）", exact: true });
      await step.waitFor(); await page.waitForTimeout(200);
      const paused = Number((await counter.innerText()).match(/\d+$/)[0]);
      await page.waitForTimeout(300); assert.equal(Number((await counter.innerText()).match(/\d+$/)[0]), paused);
      await step.click();
      await page.waitForFunction(expected => [...document.querySelectorAll(".author-behavior-preview .dashboard-text-widget")].some(node => node.textContent === `LATEST ${expected}`), paused + 1);
      await page.waitForTimeout(250); assert.equal(Number((await counter.innerText()).match(/\d+$/)[0]), paused + 1);
      await step.focus(); await page.keyboard.press("Enter");
      await page.waitForFunction(expected => [...document.querySelectorAll(".author-behavior-preview .dashboard-text-widget")].some(node => node.textContent === `LATEST ${expected}`), paused + 2);
      entry.steps.push("latest-current-draft-only", "pause-stable-one-frame-keyboard-and-no-auto-resume");
      const panel = await page.locator(".behavior-panel-header").boundingBox();
      for (const element of await page.locator(".behavior-panel-actions > :is(button,select,details)").all()) {
        const box = await element.boundingBox(); assert.ok(!box || box.x >= panel.x && box.x + box.width <= panel.x + panel.width + 1, "Runtime controls clipped");
      }
      const previewBox = await preview.boundingBox(), editorBox = await page.locator(".behavior-panel").boundingBox();
      assert.ok(previewBox.x >= editorBox.x + editorBox.width - 1, "Runtime preview must not cover code");
      entry.contrast = await page.locator("body").evaluate(collectTextContrast, ".author-behavior-preview > header strong, .author-behavior-preview > header small, .behavior-run-scope, .behavior-run-action");
      assert.deepEqual(entry.contrast.filter(item => item.text && item.contrast < 4.5), []);
      await shot("paused-one-frame");
      await page.getByRole("button", { name: "停止运行", exact: true }).click();
      await preview.waitFor({ state: "detached" });
      await page.getByText("草稿 one", { exact: true }).waitFor();
      assert.match(await page.locator(".monaco-editor .view-lines").innerText(), /LATEST/);
      await page.waitForTimeout(1800);
      assert.equal(entry.writes, 0, "Test run must not trigger autosave");
      assert.deepEqual(await gate.json("GET", appPath), before);
      await page.getByRole("combobox", { name: "试运行范围", exact: true }).selectOption("enabled");
      await page.getByRole("button", { name: "试运行已启用脚本", exact: true }).click();
      await preview.getByText("OTHER ACTIVE", { exact: true }).waitFor();
      await counter.waitFor();
      await shot("all-enabled");
      const authorUrl = page.url();
      await counter.click();
      await preview.getByText("草稿 private", { exact: true }).waitFor();
      assert.equal(page.url(), authorUrl);
      await preview.getByText("草稿 private", { exact: true }).click();
      await preview.getByText("试运行已拦截外部跳转；请在正式浏览中验证该链接。", { exact: true }).waitFor();
      assert.equal(context.pages().length, 1);
      await shot("private-navigation");
      entry.steps.push("navigation-remains-in-private-preview-external-jump-reported-not-executed");
      await page.getByRole("button", { name: "停止并返回编辑", exact: true }).click();
      await preview.waitFor({ state: "detached" });
      await page.getByRole("combobox", { name: "试运行范围", exact: true }).selectOption("current");
      await page.locator(".behavior-enabled").click();
      assert.equal(await page.getByRole("checkbox", { name: "启用脚本", exact: true }).isChecked(), false);
      await page.getByRole("button", { name: "试运行当前脚本", exact: true }).click();
      await page.getByText("脚本已禁用", { exact: true }).waitFor();
      assert.equal(await preview.count(), 0);
      await page.getByRole("checkbox", { name: "启用脚本", exact: true }).focus(); await page.keyboard.press("Space");
      await replace("function onStart(ctx) { throw new Error('ISOLATED FAULT'); }");
      await page.keyboard.press("Control+Enter");
      await page.locator(".behavior-console").getByText(/ISOLATED FAULT/).first().waitFor();
      await page.getByRole("button", { name: "停止运行", exact: true }).click();
      await replace("function onStart(ctx) { while (true) {} }");
      await page.keyboard.press("Control+Enter");
      await page.locator(".behavior-console").getByText(/超过 25 ms/).first().waitFor();
      await page.getByRole("button", { name: "停止运行", exact: true }).click();
      await replace(code("SAVED"));
      await page.keyboard.press("Control+S");
      await page.getByText("脚本已保存", { exact: true }).waitFor();
      const saved = await gate.json("GET", appPath);
      assert.deepEqual(saved.pages, before.pages); assert.deepEqual(saved.data, before.data);
      assert.match(saved.scripts[0].code, /SAVED/);
      assert.equal(entry.writes, 1);
      await page.reload(); await page.getByText("草稿 one", { exact: true }).waitFor();
      await page.getByRole("button", { name: "脚本", exact: true }).click();
      await page.locator(".monaco-editor .view-lines").waitFor();
      assert.match(await page.locator(".monaco-editor .view-lines").innerText(), /SAVED/);
      await shot("saved-draft-restored");
      await page.locator(".behavior-script-list > button").filter({ hasText: "object-test" }).click();
      await page.getByRole("button", { name: "试运行当前脚本", exact: true }).click();
      await preview.locator(".scene-viewport-preview.ready canvas").waitFor();
      await page.locator(".behavior-console").getByText(/OBJECT READY/).first().waitFor();
      await page.waitForTimeout(300);
      assert.doesNotMatch(await page.locator(".behavior-console").innerText(), /未声明能力|没有.*权限|不存在|超过|失败/);
      const canvas = await preview.locator(".scene-viewport-preview.ready canvas").screenshot();
      const { data: pixels, info } = await sharp(canvas).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let tealPixels = 0;
      for (let index = 0; index < pixels.length; index += info.channels) {
        const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
        if (g > 120 && b > 120 && r < g * 0.8 && r < b * 0.8) tealPixels++;
      }
      entry.tealRatio = tealPixels / (info.width * info.height);
      assert.ok(entry.tealRatio > 0.01, "The real viewport must show the script's teal object, not the original white model");
      await shot("object-only-private-viewport");
      await page.getByRole("button", { name: "停止运行", exact: true }).click();
      await preview.waitFor({ state: "detached" });
      assert.deepEqual((await gate.json("GET", appPath)).scenes, before.scenes);
      assert.equal(entry.writes, 1);
      entry.steps.push("object-only-synthetic-runtime-page-real-viewer-original-scene-unchanged");
      await page.waitForTimeout(100);
      assert.equal(entry.closedWorkers, entry.workers); assert.deepEqual(entry.errors, []);
      entry.steps.push("enabled-scope", "stop-restores-author-and-retains-code", "disabled-current-rejected", "runtime-error-and-bounded-infinite-loop", "explicit-save-only-persists-code-not-runtime-data", "all-workers-closed");
      entry.passed = true;
    } catch (error) { entry.failure = error.stack ?? String(error); entry.visibleCode = await page.locator(".monaco-editor .view-lines").innerText().catch(() => ""); entry.visibleRuntime = await page.locator(".author-behavior-preview").innerText().catch(() => ""); entry.visiblePanel = await page.locator(".behavior-panel").innerText().catch(() => ""); await shot("failed"); }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
    if (!entry.passed) throw new Error(entry.failure);
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, report }, null, 2));
assert.equal(report.cases.filter(entry => entry.passed).length, 4);
