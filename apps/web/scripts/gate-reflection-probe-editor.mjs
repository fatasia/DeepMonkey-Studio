import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { saveScene } from "./gateModelInstancesSupport.mjs";

const gate = await createIsolatedStudioGate("reflection-probe-editor");
const report = { createdAt: new Date().toISOString(), scope: "actual-probe-editor-persistence", cases: [] };
console.log(JSON.stringify({ output: gate.output }));
try {
  for (const round of [1, 2]) {
    const entry = { round, theme: "dark", width: 1920, height: 1080, passed: false, errors: [], bundles: {} };
    report.cases.push(entry);
    const context = await gate.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await context.route("**/api/public/branding", async route => {
      const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: "dark" } });
    });
    await context.route("**/*.js", async route => {
      const response = await route.fetch(), body = await response.text();
      if (body.includes("局部反射探针") || body.includes("setRendererSwitching:")) entry.bundles[new URL(route.request().url()).pathname]
        = createHash("sha256").update(body).digest("hex");
      await route.fulfill({ response, body });
    });
    const page = await context.newPage(); page.setDefaultTimeout(25000);
    page.on("pageerror", error => entry.errors.push(error.message));
    const shot = name => page.screenshot({ path: resolve(gate.output, `r${round}-${name}.png`) });
    try {
      const project = await gate.json("POST", "/api/projects", { name: `Probe editor ${round}` });
      await gate.loginPage(page); await page.goto(`${gate.origin}/manager?project=${project.id}`);
      await page.getByRole("button", { name: "新建场景", exact: true }).click();
      await page.getByLabel("场景名称").fill("房间反射配置");
      const creating = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}/applications`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "创建并进入", exact: true }).click();
      const created = await creating; assert.equal(created.status(), 201); const application = await created.json();
      const appPath = `/api/projects/${project.id}/applications/${application.metadata.id}`;
      const documentScene = application.scenes[0], now = new Date().toISOString();
      assert.ok(documentScene, "Actual author workspace must contain a scene");
      const scene = { ...structuredClone(documentScene), schemaVersion: 1, projectId: project.id, createdAt: now, updatedAt: now };
      scene.primitives = [{ modelId: "probe-room", name: "房间设备", kind: "box", color: "#3ec6c1", visible: true, opacity: 1,
        material: { color: "#3ec6c1", metalness: .05, roughness: .72, emissive: "#000000", emissiveIntensity: 1,
          ior: 1.5, normalScale: 1, doubleSided: false, wireframe: false, hue: 0, saturation: 0, brightness: 0, contrast: 0 },
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } } }];
      scene.camera = { position: { x: 5, y: 4, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" };
      documentScene.primitives = scene.primitives; documentScene.camera = scene.camera;
      await gate.json("PUT", `${appPath}/workspace`, { application, scene });
      const url = `${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/scenes/${scene.id}?renderer=webgl`;
      await page.goto(url); await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor();
      await page.waitForFunction(() => !document.querySelector('[aria-label="进入播放模式"]')?.disabled);
      const autoSave = page.getByLabel("自动保存"); if (await autoSave.isChecked()) await autoSave.uncheck();
      const open = async () => {
        await page.getByRole("button", { name: "查看与分析", exact: true }).click();
        await page.getByRole("menuitem", { name: "环境与灯光", exact: true }).click();
        await page.locator(".reflection-probe-editor summary").click();
      };
      await open(); const editor = page.locator(".reflection-probe-editor"), add = editor.getByRole("button", { name: "添加反射探针", exact: true });
      await add.click();
      await page.getByLabel("探针 1 中心 X (m)", { exact: true }).fill("-3.5");
      await page.getByLabel("探针 1 半尺寸 X (m)", { exact: true }).fill("2.5");
      await page.getByLabel("探针 1 混合距离 (m)", { exact: true }).fill("0.8");
      await page.getByLabel("探针 1 影响外扩 (m)", { exact: true }).fill("1.5");
      await add.click(); assert.ok(await add.isDisabled(), "Two-probe budget must be visible");
      await editor.getByRole("checkbox", { name: "探针 2", exact: true }).uncheck();
      await shot("configured");
      const valid = await saveScene(page, appPath);
      assert.equal(valid.environment.reflectionProbes.length, 2);
      const [first, second] = valid.environment.reflectionProbes;
      assert.equal(first.center.x, -3.5); assert.equal(first.halfExtents.x, 2.5); assert.equal(first.blendDistance, .8);
      assert.equal(first.influenceRadius, 1.5); assert.equal(second.enabled, false);
      await page.reload(); await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor();
      await page.waitForFunction(() => !document.querySelector('[aria-label="进入播放模式"]')?.disabled);
      await open(); assert.equal(await page.getByLabel("探针 1 中心 X (m)", { exact: true }).inputValue(), "-3.5");
      assert.equal(await editor.getByRole("checkbox", { name: "探针 2", exact: true }).isChecked(), false);
      const half = page.getByLabel("探针 1 半尺寸 X (m)", { exact: true }); await half.fill("0");
      assert.equal(await half.inputValue(), "2.5", "Zero half extent must preserve the valid author value");
      const savedAfterInvalid = await saveScene(page, appPath);
      assert.deepEqual(savedAfterInvalid.environment.reflectionProbes, valid.environment.reflectionProbes);
      const center = page.getByLabel("探针 1 中心 X (m)", { exact: true }); await center.fill("1000000000000");
      assert.equal(await center.inputValue(), "-3.5", "Out-of-contract world coordinates must preserve the valid author value");
      await shot("reloaded-disabled-validated");
      entry.persisted = valid.environment.reflectionProbes; entry.invalidInputRetainedPrevious = true;
      entry.bounds = await editor.boundingBox(); assert.ok(entry.bounds && entry.bounds.x >= 0 && entry.bounds.x + entry.bounds.width <= 1920);
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack ?? String(error); entry.body = await page.locator("body").innerText(); await shot("failed"); }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
    if (!entry.passed) throw new Error(entry.failure);
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }

