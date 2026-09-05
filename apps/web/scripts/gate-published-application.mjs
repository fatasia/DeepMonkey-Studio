import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";

const gate = await createIsolatedStudioGate("published-application");
const report = { createdAt: new Date().toISOString(), cases: [] };
const widget = (id, title, x, y, extra = {}) => ({ id, name: id, kind: "data-widget", zIndex: 1, frame: { x, y, width: 350, height: 100 }, widget: { type: "text", title, key: id, unit: "", fontSize: 22, textColor: "#60c6bd", backgroundColor: "#11191d", ...extra } });
const script = (id, code, target) => ({ id, name: id, enabled: true, apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox", code, lifecycle: ["onStart", "onEvent"], capabilities: ["studio.runtime", "studio.component", "studio.object", "studio.data"], permissions: ["scene.read", "scene.write", "data.read", "data.write"], target });
try {
  for (const theme of ["dark", "light"]) for (const width of [1440, 980]) {
    const entry = { theme, width, passed: false, errors: [], expectedHttpErrors: [], driverWarnings: [], privateRequests: [], writes: [], workers: 0, closedWorkers: 0, steps: [] };
    report.cases.push(entry);
    const project = await gate.json("POST", "/api/projects", { name: `发布验收-${theme}-${width}` });
    const upload = await gate.client.post(`/api/projects/${project.id}/script-dependencies/upload?specifier=runtime-math`, { multipart: { file: { name: "math.mjs", mimeType: "text/javascript", buffer: Buffer.from("export const answer = 42;") } } });
    assert.equal(upload.status(), 201, await upload.text());
    const dependency = await upload.json();
    const now = new Date().toISOString();
    const app = await gate.json("POST", `/api/projects/${project.id}/applications`, {
      schemaVersion: 2, metadata: { id: randomUUID(), projectId: project.id, name: "正式发布 · 生命周期应用", revision: 1, createdAt: now, updatedAt: now },
      pages: [
        { id: "one", name: "运行概览", width: 1000, height: 650, viewportFit: "contain", nodes: [widget("boot", "编辑草稿", 70, 100), widget("next", "进入三维页面 →", 70, 240), widget("private", "受保护的数据", 500, 100, { type: "value", datasetId: "protected-dataset" }), widget("filter", "区域筛选", 500, 240, { type: "filter", options: ["全部", "华东", "华南"] })] },
        { id: "two", name: "三维场景", width: 1000, height: 650, viewportFit: "contain", nodes: [{ id: "view", name: "发布视口", kind: "scene-viewport", zIndex: 1, frame: { x: 70, y: 70, width: 860, height: 510 }, sceneId: "scene", renderMode: "realtime", interactionPolicy: "full-navigation", overlaySlot: "page" }] },
      ],
      scenes: [{ id: "scene", name: "发布场景", camera: { position: { x: 5, y: 4, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" }, models: [], primitives: [{ modelId: "pump", name: "泵", kind: "box", color: "#ffffff", visible: true, opacity: 1, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } } }], measurements: [] }],
      topologies: [], geo: { providerIds: [], layers: [] }, data: { connectionIds: [], datasetIds: [], transforms: [], variables: [] },
      interactions: [{ id: "next", name: "进入三维", enabled: true, source: { kind: "widget", id: "next" }, trigger: "click", actions: [{ id: "go", enabled: true, type: "dashboard", dashboardPageId: "two" }] }],
      scripts: [script("boot", 'import { answer } from "runtime-math"; export function onStart(ctx) { ctx.self.update({widget:{title:"发布自动启动 " + answer}}); ctx.log("发布依赖已加载"); } export function onEvent(ctx) { if(ctx.event?.name === "component.click") ctx.self.update({widget:{title:"发布点击有效"}}); }', { kind: "component", id: "boot" }), script("pump-script", 'export function onStart(ctx) { ctx.self.setColor("#3ec6c1"); ctx.log("发布对象已就绪"); }', { kind: "object", id: "pump" })],
      scriptDependencies: [dependency], assets: [], timelines: [], publicationProfiles: [{ id: "browser", name: "浏览器", target: "browser-preview", entryPageId: "one", renderer: "auto" }],
    });
    const appPath = `/api/projects/${project.id}/applications/${app.metadata.id}`;
    // The initial publish goes through the real editor button, not a mocked route.
    const author = await gate.browser.newContext();
    const editor = await author.newPage(); editor.setDefaultTimeout(25000);
    await gate.loginPage(editor);
    await editor.goto(`${gate.origin}/studio/${project.id}/applications/${app.metadata.id}/pages/one`);
    await editor.getByText("编辑草稿", { exact: true }).waitFor();
    const publishResponse = editor.waitForResponse(response => response.url().endsWith(`${appPath}/publish`) && response.request().method() === "POST");
    await editor.getByRole("button", { name: "发布", exact: true }).click();
    assert.equal((await publishResponse).status(), 201);
    await author.close();
    const before = await gate.json("GET", appPath);
    const context = await gate.browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } }); });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    let faultPhase = false;
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["error", "warning"].includes(message.type())) return;
      const text = message.text();
      if (faultPhase && /^Failed to load resource: the server responded with a status of (404|503)/.test(text)) entry.expectedHttpErrors.push(text);
      else if (message.type() === "warning" && /^THREE\.WebGLProgram: Program Info Log:/.test(text) && /warning X4122: sum of/.test(text) && !/error/i.test(text)) entry.driverWarnings.push(text);
      else entry.errors.push(text);
    });
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (/^\/api\/(projects|auth|data|capabilities|ai)(\/|$)/.test(path)) entry.privateRequests.push(`${request.method()} ${path}`);
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) entry.writes.push(`${request.method()} ${path}`);
    });
    page.on("worker", worker => { if (worker.url().includes("sceneBehavior.worker")) { entry.workers++; worker.on("close", () => { entry.closedWorkers++; }); } });
    const shot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`) });
    try {
      const url = `${gate.origin}/apps/${app.metadata.id}`;
      await page.goto(url);
      await page.getByText("发布自动启动 42", { exact: true }).waitFor();
      await page.getByText(/受保护数据尚未开放/).waitFor();
      await page.getByRole("button", { name: "刷新发布版本", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "返回编辑", exact: true }).count(), 0);
      await page.getByText("发布自动启动 42", { exact: true }).click();
      await page.getByText("发布点击有效", { exact: true }).waitFor();
      await page.getByLabel("区域筛选").selectOption("华南");
      await page.waitForFunction(() => document.querySelector(".dashboard-runtime-artboard select")?.value === "华南");
      await shot("anonymous-runtime");
      await page.getByRole("button", { name: "进入三维页面 →", exact: true }).press("Enter");
      await page.locator(".scene-viewport-preview.ready canvas").waitFor();
      await page.getByRole("button", { name: "运行日志", exact: true }).click();
      await page.locator(".playback-console p").filter({ hasText: "发布对象已就绪" }).waitFor();
      await shot("3d-auto-lifecycle");
      await page.getByRole("button", { name: "关闭运行日志", exact: true }).click();
      await page.getByRole("button", { name: "项目控制", exact: true }).click();
      assert.equal(await page.getByRole("button", { name: "发布更新", exact: true }).count(), 0);
      await page.getByRole("button", { name: "运行概览", exact: true }).click();
      await page.getByText("发布自动启动 42", { exact: true }).waitFor();
      entry.contrast = await page.locator("body").evaluate(collectTextContrast, ".published-application-header strong, .published-application-header small, .playback-status span, .dashboard-runtime-controller-panel header small, .dashboard-runtime-controller-panel nav button, .dashboard-runtime-controller-trigger");
      assert.deepEqual(entry.contrast.filter(item => item.text && item.contrast < 4.5), [], "Published chrome text contrast below 4.5:1");
      assert.equal(await page.getByLabel("区域筛选").inputValue(), "华南");
      await context.grantPermissions([], { origin: gate.origin });
      await page.getByRole("button", { name: "复制发布链接", exact: true }).click();
      await page.getByRole("status").filter({ hasText: /无法访问剪贴板/ }).waitFor();
      assert.equal(await page.getByRole("textbox", { name: "发布链接", exact: true }).inputValue(), url);
      await shot("clipboard-denied-manual-url");
      entry.steps.push("real-editor-publish", "anonymous-auto-dependency-lifecycle-click", "filter-and-keyboard-flow-page-navigation", "3d-ready-before-object-script", "read-only-controls-and-copy-feedback");
      assert.deepEqual(await gate.json("GET", appPath), before);
      const changed = structuredClone(before); changed.scripts[0].code = changed.scripts[0].code.replace("发布自动启动", "新版本自动启动");
      await gate.json("PUT", appPath, changed);
      await page.reload(); await page.getByText("发布自动启动 42", { exact: true }).waitFor();
      await gate.json("POST", `${appPath}/publish`);
      await page.getByRole("button", { name: "刷新发布版本", exact: true }).click();
      await page.getByText("新版本自动启动 42", { exact: true }).waitFor();
      await shot("new-publication");
      entry.steps.push("draft-changes-do-not-leak-after-reload", "refresh-switches-to-new-publication");
      faultPhase = true;
      await page.route("**/browse", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"isolated fault"}' }));
      await page.reload(); await page.getByRole("alert").filter({ hasText: /503/ }).waitFor(); await shot("service-unavailable");
      await page.unroute("**/browse"); await page.getByRole("button", { name: "重新加载", exact: true }).click();
      await page.getByText("新版本自动启动 42", { exact: true }).waitFor();
      await gate.json("DELETE", `${appPath}/publish`);
      await page.getByRole("button", { name: "刷新发布版本", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: /已撤回/ }).waitFor(); await shot("withdrawn");
      await page.goto(`${gate.origin}/apps/%25`); await page.getByRole("alert").filter({ hasText: /链接无效/ }).waitFor();
      await page.waitForTimeout(150);
      assert.equal(entry.closedWorkers, entry.workers);
      assert.deepEqual(entry.privateRequests, []); assert.deepEqual(entry.writes, []); assert.deepEqual(entry.errors, []);
      entry.steps.push("503-visible-and-retry-recovers", "withdrawn-and-invalid-links-visible", "all-workers-released-zero-anonymous-writes-or-protected-requests");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false); entry.passed = true;
    } catch (error) { entry.failure = error.stack ?? String(error); await shot("failed"); }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
    if (!entry.passed) throw new Error(entry.failure);
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ ...report, output: gate.output }, null, 2));
assert.ok(report.cases.length === 4 && report.cases.every(entry => entry.passed), "Public application gate failed");
