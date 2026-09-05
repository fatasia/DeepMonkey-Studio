import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";

const gate = await createIsolatedStudioGate("script-playback");
const report = { createdAt: new Date().toISOString(), cases: [] };
const widget = (id, title, x, y) => ({ id, name: id, kind: "data-widget", zIndex: 1, frame: { x, y, width: 360, height: 85 }, widget: { type: "text", title, key: "", unit: "", fontSize: 24, textColor: "#60c6bd", backgroundColor: "#11191d" } });
const script = (id, code, target = { kind: "component", id }) => ({ id, name: id, enabled: true, apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox", code, lifecycle: ["onStart", "onData", "onEvent", "onUpdate", "onStop", "onDispose"], capabilities: ["studio.runtime", "studio.component", "studio.object", "studio.data"], permissions: ["scene.read", "scene.write", "data.read", "data.write"], target });
try {
  for (const theme of ["dark", "light"]) for (const width of [1440, 980]) {
    const entry = { theme, width, passed: false, errors: [], driverWarnings: [], writes: [], workers: 0, closedWorkers: 0, steps: [] };
    report.cases.push(entry);
    const project = await gate.json("POST", "/api/projects", { name: `生命周期验收-${theme}-${width}` });
    const now = new Date().toISOString();
    const application = await gate.json("POST", `/api/projects/${project.id}/applications`, {
      schemaVersion: 2, metadata: { id: randomUUID(), projectId: project.id, name: "生命周期工作台", revision: 1, createdAt: now, updatedAt: now },
      pages: [
        { id: "one", name: "组件生命周期", width: 1000, height: 650, viewportFit: "contain", nodes: [widget("boot", "编辑草稿：启动", 80, 100), widget("data", "编辑草稿：数据", 80, 215), widget("tick", "编辑草稿：帧", 80, 330)] },
        { id: "two", name: "三维生命周期", width: 1000, height: 650, viewportFit: "contain", nodes: [{ id: "view", name: "模型视口", kind: "scene-viewport", zIndex: 1, frame: { x: 80, y: 80, width: 720, height: 460 }, sceneId: "scene", renderMode: "realtime", interactionPolicy: "full-navigation", overlaySlot: "page" }] },
      ],
      scenes: [{ id: "scene", name: "测试场景", camera: { position: { x: 5, y: 4, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" }, models: [], primitives: [{ modelId: "pump", name: "泵", kind: "box", color: "#ffffff", visible: true, opacity: 1, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } } }], measurements: [] }],
      topologies: [], geo: { providerIds: [], layers: [] }, data: { connectionIds: [], datasetIds: [], transforms: [], variables: [] }, interactions: [],
      scripts: [
        script("boot", `export function onStart(ctx) { ctx.state.starts = (ctx.state.starts || 0) + 1; ctx.self.update({widget:{title:"自动启动 " + ctx.state.starts}}); ctx.setData("temperature", 42); ctx.log("启动完成", {starts: ctx.state.starts}); }
export function onEvent(ctx) { if(ctx.event?.name === "component.click") { ctx.self.update({widget:{title:"点击事件已触发"}}); ctx.setData("temperature", 75); } }
export function onStop(ctx) { ctx.log("停止"); }
export function onDispose(ctx) { ctx.log("销毁"); }`),
        script("data", `function onData(ctx) { ctx.self.update({widget:{title:"实时数据 " + ctx.getData("temperature")}}); }`),
        script("tick", `function onUpdate(ctx) { const tick = Math.floor(ctx.elapsedMs / 200); if(tick === ctx.state.last) return; ctx.state.last=tick; ctx.self.update({widget:{title:"帧计数 " + tick}}); }`),
        script("pump-script", `export function onStart(ctx) { ctx.self.setColor("#3ec6c1"); ctx.log("对象已就绪", {sceneId:ctx.sceneId}); }`, { kind: "object", id: "pump" }),
        { ...script("disabled", `function onStart(ctx) { throw new Error("禁用脚本不应执行"); }`), enabled: false },
        script("fault", `export function onStart(ctx) { throw new Error("验收故障：仅此脚本停止"); }`, { kind: "component", id: "boot" }),
      ], assets: [], timelines: [], publicationProfiles: [{ id: "browser", name: "浏览器", target: "browser-preview", entryPageId: "one", renderer: "auto" }],
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
      // Exact previously recorded ANGLE compiler diagnostic, retained in report;
      // do not downgrade shader failures or arbitrary WebGL/product warnings.
      if (message.type() === "warning" && /^THREE\.WebGLProgram: Program Info Log:/.test(text) && /warning X4122: sum of/.test(text) && !/error/i.test(text)) entry.driverWarnings.push(text);
      else entry.errors.push(text);
    });
    page.on("request", request => { if (request.url().endsWith(appPath) && request.method() === "PUT") entry.writes.push("PUT application"); });
    page.on("worker", worker => { if (worker.url().includes("sceneBehavior.worker")) { entry.workers++; worker.on("close", () => { entry.closedWorkers++; }); } });
    const shot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`) });
    try {
      await gate.loginPage(page);
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/one`);
      await page.getByText("编辑草稿：启动", { exact: true }).waitFor(); await shot("author");
      await page.getByRole("button", { name: "浏览", exact: true }).click();
      await page.getByText("自动启动 1", { exact: true }).waitFor();
      await page.getByText("实时数据 42", { exact: true }).waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll(".dashboard-text-widget")].some(node => /帧计数 [1-9]/.test(node.textContent)));
      entry.steps.push("no-manual-run-auto-onStart-onData-onUpdate");
      await page.getByRole("button", { name: "运行日志", exact: true }).click();
      await page.getByText(/验收故障：仅此脚本停止/).waitFor();
      assert.match(await page.locator(".playback-console").innerText(), /starts.*1/);
      await shot("automatic-with-diagnostics");
      await page.getByRole("button", { name: "关闭运行日志", exact: true }).click();
      await page.getByRole("button", { name: "暂停生命周期", exact: true }).click();
      const counter = page.locator(".dashboard-text-widget").filter({ hasText: /^帧计数/ });
      // Bounded settling time permits the invocation already in flight to finish.
      await page.waitForTimeout(250); const paused = await counter.innerText(); await page.waitForTimeout(400);
      assert.equal(await counter.innerText(), paused);
      await page.getByRole("button", { name: "继续生命周期", exact: true }).click();
      await page.waitForFunction(value => [...document.querySelectorAll(".dashboard-text-widget")].some(node => /^帧计数/.test(node.textContent) && node.textContent !== value), paused);
      await page.getByText("自动启动 1", { exact: true }).click();
      await page.getByText("点击事件已触发", { exact: true }).waitFor(); await page.getByText("实时数据 75", { exact: true }).waitFor();
      entry.steps.push("fault-isolation-structured-log", "pause-resume-and-real-click-data-event");
      await page.getByRole("button", { name: "项目控制", exact: true }).click();
      await page.getByRole("button", { name: "三维生命周期", exact: true }).click();
      await page.locator(".scene-viewport-preview.ready canvas").waitFor();
      await page.getByRole("button", { name: "运行日志", exact: true }).click();
      await page.getByText(/对象已就绪/).waitFor(); await shot("scene-auto-mount");
      await page.getByRole("button", { name: "关闭运行日志", exact: true }).click();
      await page.getByRole("button", { name: "组件生命周期", exact: true }).click();
      await page.getByText("自动启动 1", { exact: true }).waitFor();
      await page.getByRole("button", { name: "返回编辑", exact: true }).first().click();
      await page.getByText("编辑草稿：启动", { exact: true }).waitFor(); await shot("restored-author");
      await page.waitForTimeout(100);
      assert.equal(entry.closedWorkers, entry.workers);
      assert.deepEqual(entry.writes, []); assert.deepEqual(await gate.json("GET", appPath), before);
      entry.steps.push("scene-ready-before-object-onStart", "page-switch-disposes-old-mounts", "exit-terminates-workers-and-does-not-save-author");
      await page.getByRole("button", { name: "浏览", exact: true }).click(); await page.getByText("自动启动 1", { exact: true }).waitFor();
      await page.getByRole("button", { name: "返回编辑", exact: true }).first().click();
      await page.reload(); await page.getByText("编辑草稿：启动", { exact: true }).waitFor();
      entry.steps.push("fresh-session-on-reopen-author-persists-after-reload");
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack ?? String(error); await shot("failed"); }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
    if (!entry.passed) throw new Error(entry.failure);
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ ...report, output: gate.output }, null, 2));
assert.ok(report.cases.length === 4 && report.cases.every(entry => entry.passed), "Lifecycle browser gate failed");
