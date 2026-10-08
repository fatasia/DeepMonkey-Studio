import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createScene, saveScene } from "./gateModelInstancesSupport.mjs";

/**
 * 体积雾散射反照率作者闭环(深色 1920x1080,Deep WebGPU):
 * UI 滑块 → 持久化 → 重载回显 → 画面像素随 albedo 变化(0 与 1 的视口哈希必须不同)。
 * 用法: BIM_FOG_WEB_ROOT=<含最新 src 的 vite 构建目录> node scripts/gate-volumetric-fog-albedo.mjs
 */
const webRoot = process.env.BIM_FOG_WEB_ROOT;
const gate = await createIsolatedStudioGate("fog-albedo", webRoot ? { webRoot } : {});
const report = { createdAt: new Date().toISOString(), scope: "volumetric-fog-albedo-author-loop", theme: "dark", width: 1920, height: 1080 };
console.log(JSON.stringify({ output: gate.output }));
const context = await gate.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await context.route("**/api/public/branding", async route => {
  const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: "dark" } });
});
await context.addInitScript(() => localStorage.setItem("bim-studio.renderer-backend", "webgpu"));
const page = await context.newPage(); page.setDefaultTimeout(30000);
const errors = []; page.on("pageerror", error => errors.push(error.message));
try {
  const project = await gate.json("POST", "/api/projects", { name: "Fog albedo" });
  const { application, appPath, scenePath } = await createScene(gate, page, project.id);
  const documentScene = application.scenes[0], now = new Date().toISOString();
  const scene = { ...structuredClone(documentScene), schemaVersion: 1, projectId: project.id, createdAt: now, updatedAt: now };
  const material = color => ({ color, metalness: .05, roughness: .6, emissive: "#000000", emissiveIntensity: 1, ior: 1.5,
    normalScale: 1, doubleSided: false, wireframe: false, hue: 0, saturation: 0, brightness: 0, contrast: 0 });
  const box = (modelId, name, color, x, z, sx, sy, sz) => ({ modelId, name, kind: "box", color, visible: true, opacity: 1, material: material(color),
    transform: { position: { x, y: sy / 2, z }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: sx, y: sy, z: sz } } });
  scene.primitives = [box("fog-ground", "地面", "#5b6773", 0, 0, 60, .1, 60), box("fog-a", "近处设备", "#3ec6c1", -3, 4, 2, 2, 2),
    box("fog-b", "中景设备", "#d0a24a", 3, -6, 3, 4, 3), box("fog-c", "远景设备", "#a45ad6", -6, -22, 5, 8, 5)];
  scene.camera = { position: { x: 9, y: 4, z: 14 }, target: { x: 0, y: 2, z: -8 }, mode: "orbit" };
  scene.postProcessing = { ...scene.postProcessing, enabled: true, volumetricFog: true, volumetricFogDensity: .03, volumetricFogHeight: 24 };
  Object.assign(documentScene, { primitives: scene.primitives, camera: scene.camera });
  await gate.json("PUT", `${appPath}/workspace`, { application, scene });
  await page.goto(`${scenePath}?renderer=webgpu`); await page.locator('.viewport canvas:not([aria-hidden="true"])').first().waitFor();
  const ready = () => page.waitForFunction(() => !document.querySelector('[aria-label="进入播放模式"]')?.disabled);
  const discard = page.getByRole("button", { name: "丢弃副本", exact: true });
  if (await discard.isVisible({ timeout: 4000 }).catch(() => false)) await discard.click();
  await ready(); const autoSave = page.getByLabel("自动保存"); if (await autoSave.isChecked()) await autoSave.uncheck();
  const open = async () => {
    await page.getByRole("button", { name: "查看与分析", exact: true }).click();
    await page.getByRole("menuitem", { name: "环境与灯光", exact: true }).click();
  };
  await page.locator('.viewport canvas[data-renderer-backend="deep-webgpu"]').waitFor({ state: "attached" });
  await page.waitForFunction(() => { const canvas = document.querySelector('.viewport canvas[data-renderer-backend="deep-webgpu"]');
    return canvas && getComputedStyle(canvas).opacity === "1"; }, undefined, { timeout: 120000 });
  await open();
  const albedo =  page.locator(".post-processing-control").getByRole("slider", { name: /^散射反照率/ });
  await albedo.waitFor(); assert.equal(await albedo.inputValue(), "0.82");
  const hashes = {}, buffers = {};
  const capture = async tag => {
    await page.waitForTimeout(1800);
    // 只截面板左侧的 Deep 画布区域,排除随滑块变化的 UI。
    const buffer = await page.screenshot({ path: resolve(gate.output, `fog-albedo-${tag}.png`), clip: { x: 250, y: 120, width: 700, height: 840 } });
    buffers[tag] = buffer; hashes[tag] = createHash("sha256").update(buffer).digest("hex");
  };
  await capture("default");
  await albedo.focus(); await albedo.press("Home"); assert.equal(await albedo.inputValue(), "0");
  const zero = await saveScene(page, appPath);
  assert.equal(zero.postProcessing.volumetricFogAlbedo, 0); await capture("albedo-0");
  await albedo.press("End"); assert.equal(await albedo.inputValue(), "1");
  const one = await saveScene(page, appPath); assert.equal(one.postProcessing.volumetricFogAlbedo, 1); await capture("albedo-1");
  report.changedBytesRatio = [...buffers["albedo-0"]].reduce((n, byte, i) => n + (byte === buffers["albedo-1"][i] ? 0 : 1), 0) / buffers["albedo-0"].length;
  assert.notEqual(hashes["albedo-0"], hashes["albedo-1"], "albedo 0 与 1 的画面必须不同(未被 Deep 渲染消费)");
  await page.reload(); await page.locator('.viewport canvas:not([aria-hidden="true"])').first().waitFor(); await ready(); await open();
  assert.equal(await page.locator(".post-processing-control").getByRole("slider", { name: /^散射反照率/ }).inputValue(), "1");
  report.hashes = hashes; report.persisted = one.postProcessing; report.errors = errors;
  assert.deepEqual(errors, []); report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.stack ?? String(error);
  await page.screenshot({ path: resolve(gate.output, "failed.png") }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await context.close();
  await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close();
  console.log(JSON.stringify({ passed: report.passed, failure: report.failure, hashes: report.hashes }));
}
