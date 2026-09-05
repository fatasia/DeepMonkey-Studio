import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";

const gate = await createIsolatedStudioGate("scene-plant-flow");
const report = { createdAt: new Date().toISOString(), cases: [] };
try {
  for (const theme of ["dark", "light"]) for (const width of [1440, 980]) {
    const entry = { theme, width, passed: false, errors: [], driverWarnings: [], steps: [] }; report.cases.push(entry);
    const project = await gate.json("POST", "/api/projects", { name: `场景物流闭环-${theme}-${width}` });
    const now = new Date().toISOString();
    const roles = ["source", "queue-buffer", "station", "sink"];
    const scene = { id: randomUUID(), name: "物流闭环验收", camera: { position: { x: 10, y: 10, z: 15 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" }, models: [],
      primitives: roles.map((role, index) => ({ modelId: role, name: ["到料点", "缓存区", "装配工位", "出料点"][index], kind: "box", color: ["#3cb8ba", "#d5a949", "#649ddd", "#58ab78"][index], visible: true, opacity: 1, transform: { position: { x: index * 3 - 4.5, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1.5, y: 1.5, z: 1.5 } } })), measurements: [] };
    await gate.json("PUT", `/api/projects/${project.id}/scenes/${scene.id}`, { ...scene, schemaVersion: 1, projectId: project.id, createdAt: now, updatedAt: now });
    const application = await gate.json("POST", `/api/projects/${project.id}/applications`, {
      schemaVersion: 2, metadata: { id: randomUUID(), projectId: project.id, name: "场景物流验收", revision: 1, createdAt: now, updatedAt: now },
      pages: [{ id: "one", name: "概览", width: 720, height: 650, viewportFit: "contain", nodes: [] }], scenes: [scene], topologies: [], geo: { providerIds: [], layers: [] },
      data: { connectionIds: [], datasetIds: [], transforms: [], variables: [] }, interactions: [], scripts: [], assets: [], timelines: [], publicationProfiles: [{ id: "browser", name: "浏览器", target: "browser-preview", entryPageId: "one", renderer: "auto" }],
    });
    const appPath = `/api/projects/${project.id}/applications/${application.metadata.id}`;
    const studyPath = `/api/projects/${project.id}/operations/logistics/des-studies`;
    const context = await gate.browser.newContext({ viewport: { width, height: 1000 } });
    await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } }); });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["warning", "error"].includes(message.type())) return;
      const text = message.text();
      if (message.type() === "warning" && /^THREE\.WebGLProgram: Program Info Log:/.test(text) && /warning X4122: sum of/.test(text) && !/error/i.test(text)) entry.driverWarnings.push(text);
      else entry.errors.push(text);
    });
    const shot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`) });
    const open = async () => { await page.getByRole("button", { name: "仿真与开发", exact: true }).click(); await page.getByRole("menuitem", { name: "物流仿真", exact: true }).click(); await page.getByRole("region", { name: "场景物流建模" }).waitFor(); };
    const panel = page.getByRole("complementary", { name: "场景仿真插件" });
    const flow = page.getByRole("region", { name: "场景物流建模" });
    try {
      await gate.loginPage(page);
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/scenes/${scene.id}`);
      await page.locator(".viewport canvas").waitFor(); await open();
      for (const role of roles) {
        await flow.getByLabel("物流场景对象").selectOption(role); await flow.getByLabel("物流角色", { exact: true }).selectOption(role);
        await flow.getByRole("button", { name: "绑定", exact: true }).click();
      }
      assert.equal(await flow.locator(".scene-plant-node").count(), 4);
      assert.equal(await flow.getByRole("button", { name: "运行场景物流", exact: true }).isDisabled(), true);
      for (let i = 0; i < roles.length - 1; i++) {
        await flow.getByLabel("物流连线起点").selectOption(roles[i]); await flow.getByLabel("物流连线终点").selectOption(roles[i + 1]);
        await flow.getByRole("button", { name: "连接", exact: true }).click();
      }
      await flow.locator(".scene-plant-node").nth(1).locator("summary").click(); await flow.getByLabel("队列容量", { exact: true }).fill("12");
      await flow.getByLabel("队列容量", { exact: true }).scrollIntoViewIfNeeded(); await shot("queue-parameters");
      await flow.locator(".scene-plant-node").nth(1).locator("summary").click();
      assert.equal(await flow.getByRole("button", { name: "运行场景物流", exact: true }).isEnabled(), true);
      entry.steps.push("four-real-object-bindings", "explicit-edges-required", "queue-parameters");
      entry.contrast = await page.locator("body").evaluate(collectTextContrast, ".scene-plant-quick header strong, .scene-plant-quick header p, .scene-plant-quick legend, .scene-plant-quick label > span");
      assert.deepEqual(entry.contrast.filter(item => item.text && item.contrast < 4.5), []);
      const bounds = await panel.boundingBox();
      for (const element of await flow.locator("input,select,button").all()) { const box = await element.boundingBox(); assert.ok(!box || box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width + 1, "Horizontal clipping"); }
      await shot("configured");
      await page.getByRole("button", { name: "收起仿真面板", exact: true }).click();
      const saveResponse = page.waitForResponse(response => response.url().includes(appPath) && response.request().method() === "PUT");
      await page.getByRole("button", { name: "保存项目", exact: true }).click(); await saveResponse;
      const saved = await gate.json("GET", appPath); const savedScene = saved.scenes.find(item => item.id === scene.id);
      assert.equal(savedScene.simulationEntities.length, 7);
      await page.reload(); await page.locator(".viewport canvas").waitFor(); await open();
      assert.equal(await flow.locator(".scene-plant-node").count(), 4); assert.equal(await flow.locator(".scene-plant-links li").count(), 3);
      entry.steps.push("configuration-save-reload");
      const responsePromise = page.waitForResponse(response => response.url().endsWith(studyPath) && response.request().method() === "POST");
      await flow.getByRole("button", { name: "运行场景物流", exact: true }).click(); const response = await responsePromise;
      assert.equal(response.status(), 200); const study = await response.json(); entry.studyId = study.id;
      assert.equal(study.model.sceneBinding.sceneId, scene.id); assert.equal(study.outcome.status, "completed");
      assert.ok(study.trace.events.some(event => event.type === "item-complete"));
      const timeline = page.getByRole("region", { name: "场景仿真时间线", exact: true }); await timeline.waitFor();
      assert.equal(await page.locator(".plant-playback:visible").count(), 1);
      await timeline.getByRole("button", { name: "播放回放", exact: true }).click();
      await page.waitForFunction(() => Number(document.querySelector('[aria-label="仿真时间轴"]')?.value) > 5);
      await timeline.getByRole("button", { name: "暂停回放", exact: true }).click();
      const clock = await timeline.getByLabel("仿真时间轴").inputValue(); await page.waitForTimeout(250); assert.equal(await timeline.getByLabel("仿真时间轴").inputValue(), clock);
      assert.match(await page.locator(".scene-simulation-live-status").innerText(), /DES 轨迹样本/);
      entry.playbackContrast = await page.locator("body").evaluate(collectTextContrast, ".scene-simulation-timeline .timeline-heading strong, .scene-simulation-timeline .timeline-heading small, .scene-simulation-timeline .timeline-heading-summary button:first-child, .scene-simulation-timeline .plant-playback header strong, .scene-simulation-timeline .plant-playback header small, .scene-simulation-timeline .plant-playback-status");
      assert.deepEqual(entry.playbackContrast.filter(item => item.text && item.contrast < 4.5), []);
      const trackHeader = await timeline.locator(".timeline-heading").boundingBox(), trackActions = await timeline.locator(".timeline-heading-summary").boundingBox();
      assert.ok(trackActions.x + trackActions.width <= trackHeader.x + trackHeader.width + 1, "Timeline actions clipped");
      await shot("single-timeline-playback"); entry.steps.push("real-DES-Study", "single-playback-clock", "pause-stable", "scene-event-overlay");
      await timeline.getByRole("button", { name: "关闭时间线", exact: true }).click(); await page.locator(".scene-simulation-live-status").waitFor({ state: "detached" });
      await page.getByRole("button", { name: "展开仿真面板", exact: true }).click();
      const reproduceResponse = page.waitForResponse(response => response.url().endsWith(`${studyPath}/${study.id}/reproduce`));
      await flow.getByRole("button", { name: "按原快照复现", exact: true }).click(); const repeated = await (await reproduceResponse).json();
      assert.equal(repeated.inputFingerprint, study.inputFingerprint); assert.deepEqual(repeated.trace, study.trace); assert.deepEqual(repeated.outcome, study.outcome);
      await timeline.waitFor(); await page.getByRole("button", { name: "关闭仿真面板", exact: true }).click(); await timeline.waitFor({ state: "detached" });
      const after = await gate.json("GET", appPath); assert.deepEqual(after.scenes.find(item => item.id === scene.id).primitives.map(item => item.transform), savedScene.primitives.map(item => item.transform));
      assert.equal(JSON.stringify(after).includes("simulation-playback"), false);
      entry.steps.push("exact-snapshot-reproduction", "close-cleans-timeline", "no-overlay-or-transform-persistence");
      assert.deepEqual(entry.errors, []); entry.passed = true; console.log(JSON.stringify(entry));
    } catch (error) { entry.failure = String(error); await shot("failure"); throw error; }
    finally { await context.close(); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); console.log(gate.output); }
