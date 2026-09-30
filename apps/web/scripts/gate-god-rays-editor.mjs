import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createScene, saveScene } from "./gateModelInstancesSupport.mjs";

const gate = await createIsolatedStudioGate("god-rays-editor");
const report = { createdAt: new Date().toISOString(), scope: "actual-god-rays-author-persistence", cases: [] };
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
      if (body.includes("体积光强度")) entry.bundles[new URL(route.request().url()).pathname] = createHash("sha256").update(body).digest("hex");
      await route.fulfill({ response, body });
    });
    const page = await context.newPage(); page.setDefaultTimeout(25000);
    page.on("pageerror", error => entry.errors.push(error.message));
    const shot = name => page.screenshot({ path: resolve(gate.output, `r${round}-${name}.png`) });
    try {
      const project = await gate.json("POST", "/api/projects", { name: `Light shafts ${round}` });
      const { application, appPath, scenePath } = await createScene(gate, page, project.id);
      const documentScene = application.scenes[0], now = new Date().toISOString();
      const scene = { ...structuredClone(documentScene), schemaVersion: 1, projectId: project.id, createdAt: now, updatedAt: now };
      scene.primitives = [{ modelId: "god-rays-device", name: "体积光设备", kind: "box", color: "#3ec6c1", visible: true, opacity: 1,
        material: { color: "#3ec6c1", metalness: .05, roughness: .72, emissive: "#000000", emissiveIntensity: 1,
          ior: 1.5, normalScale: 1, doubleSided: false, wireframe: false, hue: 0, saturation: 0, brightness: 0, contrast: 0 },
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } } }];
      scene.camera = { position: { x: 5, y: 4, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" };
      Object.assign(documentScene, { primitives: scene.primitives, camera: scene.camera });
      await gate.json("PUT", `${appPath}/workspace`, { application, scene });
      await page.goto(`${scenePath}?renderer=webgpu`); await page.locator(".viewport canvas").waitFor();
      const ready = () => page.waitForFunction(() => !document.querySelector('[aria-label="进入播放模式"]')?.disabled);
      await ready(); const autoSave = page.getByLabel("自动保存"); if (await autoSave.isChecked()) await autoSave.uncheck();
      const open = async () => {
        await page.getByRole("button", { name: "查看与分析", exact: true }).click();
        await page.getByRole("menuitem", { name: "环境与灯光", exact: true }).click();
      };
      await open(); const editor = page.locator(".post-processing-control");
      const fog = editor.getByRole("button", { name: "体积雾", exact: true }); await fog.click();
      const shafts = editor.getByRole("button", { name: "体积光", exact: true }); await shafts.click();
      const strength = editor.getByRole("slider", { name: /^体积光强度/ });
      await strength.focus(); await strength.press("Home"); assert.equal(await strength.inputValue(), "0");
      const zero = await saveScene(page, appPath); assert.equal(zero.postProcessing.volumetricGodRaysStrength, 0);
      for (let i = 0; i < 7; i++) await strength.press("ArrowRight");
      const valid = await saveScene(page, appPath);
      assert.equal(valid.postProcessing.volumetricGodRays, true); assert.equal(valid.postProcessing.volumetricFog, true);
      assert.equal(valid.postProcessing.volumetricGodRaysStrength, .7); await shot("configured");
      entry.strengthBounds = await strength.boundingBox();
      assert.ok(entry.strengthBounds && entry.strengthBounds.x >= 0 && entry.strengthBounds.x + entry.strengthBounds.width <= 1920);
      await page.reload(); await page.locator(".viewport canvas").waitFor(); await ready(); await open();
      assert.equal(await strength.inputValue(), "0.7"); assert.equal(await shafts.getAttribute("aria-pressed"), "true");
      await strength.focus(); await strength.press("End"); await strength.press("ArrowRight"); assert.equal(await strength.inputValue(), "8");
      await strength.press("Home"); await strength.press("ArrowLeft"); assert.equal(await strength.inputValue(), "0");
      await shafts.click(); assert.equal(await strength.count(), 0);
      const disabled = await saveScene(page, appPath); assert.equal(disabled.postProcessing.volumetricGodRays, false);
      assert.equal(disabled.postProcessing.volumetricGodRaysStrength, 0); assert.equal(disabled.postProcessing.volumetricFog, true);
      await page.reload(); await page.locator(".viewport canvas").waitFor(); await ready(); await open();
      assert.equal(await shafts.getAttribute("aria-pressed"), "false"); await shafts.click();
      assert.equal(await strength.inputValue(), "0"); await shot("reloaded-zero");
      entry.persisted = valid.postProcessing; entry.zeroPreserved = true; entry.rangeClamped = true;
      entry.backend = await page.locator("body").innerText(); assert.ok(Object.keys(entry.bundles).length, "Current author bundle must be captured");
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack ?? String(error); entry.body = await page.locator("body").innerText(); await shot("failed"); }
    finally { await context.close(); console.log(JSON.stringify({ round, passed: entry.passed, failure: entry.failure, errors: entry.errors })); }
    if (!entry.passed) throw new Error(entry.failure);
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
