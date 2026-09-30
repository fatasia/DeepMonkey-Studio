import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { saveScene } from "./gateModelInstancesSupport.mjs";

// Fault injection changes the fetched test bundle only; production has no test globals.
const gate = await createIsolatedStudioGate("play-incremental-restore");
const report = { createdAt: new Date().toISOString(), scope: "production-dom-play-restore", cases: [] };
console.log(JSON.stringify({ output: gate.output }));
try {
  for (const round of [1, 2]) {
    const entry = { round, theme: "dark", width: 1920, height: 1080,
      initialRenderer: process.env.C25_GATE_RENDERER === "preferences" || process.argv.includes("--default-renderer")
        ? "preferences" : "explicit-webgl", errors: [], receipts: [], passed: false };
    report.cases.push(entry);
    const context = await gate.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await context.route("**/api/public/branding", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), themeMode: "dark" } });
    });
    let injectedIncremental = 0, injectedFull = 0;
    const incrementalSites = new Set(), fullSites = new Set();
    await context.route("**/*.js", async route => {
      const response = await route.fetch(); let body = await response.text();
      if (body.includes("WebGL 已启用")) {
        entry.bundle = { url: route.request().url(), sha256: createHash("sha256").update(body).digest("hex") };
      }
      if (process.env.C25_GATE_DIAGNOSTICS === "1" && body.includes("WebGL 已启用")) {
        const setter = [...body.slice(0, body.indexOf("WebGL 已启用")).matchAll(/setRendererSwitching:(\w+)/g)].at(-1)?.[1];
        if (setter) for (const flag of ["!0", "!1"]) body = body.split(`${setter}(${flag})`).join(`((globalThis.__playInitTrace??=[]).push({value:${flag},stack:new Error().stack}),${setter}(${flag}))`);
      }
      body = body.replace(/\b(\w+)\.applyIncremental\((\w+)\)/g, (match, deps, scene, offset) => {
        incrementalSites.add(`${new URL(route.request().url()).pathname}:${offset}`); injectedIncremental = incrementalSites.size;
        return `(()=>{if(globalThis.__playRestoreGateFault==="incremental"){globalThis.__playRestoreGateFault="";return Promise.reject(new Error("C25 gate incremental rejected"))}return ${deps}.applyIncremental(${scene})})()`;
      });
      body = body.replace(/\b(\w+)\.applyFull\((\w+)\)/g, (match, deps, scene, offset) => {
        fullSites.add(`${new URL(route.request().url()).pathname}:${offset}`); injectedFull = fullSites.size;
        return `(()=>{if(globalThis.__playRestoreGateFault==="full"){globalThis.__playRestoreGateFault="";return Promise.reject(new Error("C25 gate full rejected"))}return ${deps}.applyFull(${scene})})()`;
      });
      await route.fulfill({ response, body });
    });
    const page = await context.newPage(); page.setDefaultTimeout(25000);
    page.on("pageerror", error => entry.errors.push(error.message));
    const shot = name => page.screenshot({ path: resolve(gate.output, `r${round}-${name}.png`) });
    const enter = page.getByRole("button", { name: "进入播放模式", exact: true });
    const exit = page.getByRole("button", { name: "退出播放模式并恢复场景", exact: true });
    const receipt = () => page.evaluate(() => {
      const entries = performance.getEntriesByName("deep-studio:play-restore", "measure");
      if (entries.length !== 1) throw new Error(`Expected one bounded restore measure, got ${entries.length}`);
      return { detail: entries[0].detail, durationMs: entries[0].duration };
    });
    try {
      const project = await gate.json("POST", "/api/projects", { name: `Play restore ${round}` });
      await gate.loginPage(page); await page.goto(`${gate.origin}/manager?project=${project.id}`);
      await page.getByRole("button", { name: "新建场景", exact: true }).click();
      await page.getByLabel("场景名称").fill("Play 恢复验证");
      const creating = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}/applications`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "创建并进入", exact: true }).click();
      const created = await creating; assert.equal(created.status(), 201); const application = await created.json();
      const appPath = `/api/projects/${project.id}/applications/${application.metadata.id}`;
      const documentScene = application.scenes[0]; assert.ok(documentScene, "Created workspace must contain a scene");
      const now = new Date().toISOString();
      const scene = { ...structuredClone(documentScene), schemaVersion: 1, projectId: project.id, createdAt: now, updatedAt: now };
      scene.primitives = [{ modelId: "play-restore-device", name: "恢复验证设备", kind: "box", color: "#3ec6c1", visible: true, opacity: 1,
        material: { color: "#3ec6c1", metalness: .05, roughness: .72, emissive: "#000000", emissiveIntensity: 1,
          ior: 1.5, normalScale: 1, doubleSided: false, wireframe: false, hue: 0, saturation: 0, brightness: 0, contrast: 0 },
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } } }];
      scene.camera = { position: { x: 5, y: 4, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" };
      documentScene.primitives = scene.primitives; documentScene.camera = scene.camera;
      await gate.json("PUT", `${appPath}/workspace`, { application, scene });
      const rendererQuery = entry.initialRenderer === "preferences" ? "" : "?renderer=webgl";
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/scenes/${scene.id}${rendererQuery}`);
      await page.locator(".viewport canvas").waitFor();
      const autoSave = page.getByLabel("自动保存"); if (await autoSave.isChecked()) await autoSave.uncheck();
      await enter.waitFor({ state: "visible" });
      await page.waitForFunction(() => !document.querySelector('[aria-label="进入播放模式"]')?.disabled);
      const before = await saveScene(page, appPath);
      assert.equal(before.primitives.length, 1); assert.equal(before.primitives[0].modelId, "play-restore-device");
      assert.equal(await page.evaluate(() => performance.getEntriesByName("deep-studio:play-restore").length), 0);
      await enter.click(); await exit.waitFor(); await shot("playing");
      assert.ok(await page.getByRole("button", { name: "保存项目", exact: true }).isDisabled());
      const canvas = page.locator(".viewport canvas");
      const canvasHash = async () => createHash("sha256").update(await canvas.screenshot()).digest("hex");
      const initialView = await canvasHash();
      const canvasBounds = await canvas.boundingBox(); assert.ok(canvasBounds);
      await page.mouse.move(canvasBounds.x + canvasBounds.width / 2, canvasBounds.y + canvasBounds.height / 2);
      await page.mouse.wheel(0, 450); await page.waitForTimeout(500);
      const runtimeView = await canvasHash(); assert.notEqual(runtimeView, initialView, "Play camera interaction must change the rendered object view");
      entry.runtimeMutation = { objectId: before.primitives[0].modelId, initialView, runtimeView, cameraInteraction: "actual DOM wheel" };
      await exit.click(); await enter.waitFor();
      entry.receipts.push(await receipt());
      assert.equal(entry.receipts[0].detail.path, "incremental");
      assert.equal(entry.receipts[0].detail.status, "passed");
      assert.ok(entry.receipts[0].detail.stages["apply-incremental"] >= 0);
      await shot("incremental-restored");

      assert.equal(injectedIncremental, 1, "Test bundle must have exactly one production incremental application site");
      assert.equal(injectedFull, 2, "Test bundle must expose both production full branches");
      await enter.click(); await exit.waitFor();
      await page.evaluate(() => { globalThis.__playRestoreGateFault = "incremental"; });
      await exit.click();
      await page.waitForFunction(() => performance.getEntriesByName("deep-studio:play-restore")[0]?.detail.status === "failed");
      assert.ok(await exit.isVisible()); entry.receipts.push(await receipt());
      assert.equal(entry.receipts[1].detail.failedStage, "apply-incremental");
      assert.equal(entry.receipts[1].detail.degraded, true); await shot("incremental-failed-retry-visible");
      await page.evaluate(() => { globalThis.__playRestoreGateFault = "full"; });
      await exit.click();
      await page.waitForFunction(() => performance.getEntriesByName("deep-studio:play-restore")[0]?.detail.failedStage === "apply-full");
      assert.ok(await exit.isVisible()); entry.receipts.push(await receipt()); await shot("full-failed-retry-visible");
      await exit.click(); await enter.waitFor(); entry.receipts.push(await receipt());
      assert.equal(entry.receipts[3].detail.path, "full"); assert.equal(entry.receipts[3].detail.status, "passed");
      assert.equal(await page.getByText("播放已停止受限脚本，但场景恢复未完成；请再次点击退出播放重试。", { exact: true }).count(), 0,
        "Successful retry must clear the previous restore error");
      const after = await saveScene(page, appPath);
      for (const key of ["models", "primitives", "measurements", "camera", "physics", "animation"]) assert.deepEqual(after[key], before[key], `Restore ${key}`);
      entry.runtimeMutation.cameraRestored = true; entry.runtimeMutation.authoredObjectRestored = true;
      for (const item of entry.receipts) assert.ok(Number.isFinite(item.durationMs) && item.durationMs >= 0);
      await shot("full-retry-restored"); assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack ?? String(error); entry.body = await page.locator("body").innerText(); entry.initTrace = await page.evaluate(() => globalThis.__playInitTrace); await shot("failed"); }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
    if (!entry.passed) throw new Error(entry.failure);
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
assert.ok(report.cases.length === 2 && report.cases.every(entry => entry.passed));
