import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { ensureRows, saveScene, themeContext, uploadModel } from "./gateModelInstancesSupport.mjs";

const root = resolve(import.meta.dirname, "../../.."), cache = resolve(root, "data/external-assets/source-b");
const uids = ["06cec0c0510f4e668ea337dc50c7202c", "07f04ecaf89642dbad604c469e4dada9", "0819b51c59c3407cb98f0e2c75029e30"];
const catalog = JSON.parse(await readFile(resolve(cache, "catalog.json"), "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const glbJson = bytes => JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8").trim());
const legacy = "KHR_materials_pbrSpecularGlossiness";
const localSource = process.argv.includes("--local-source");
async function restored(page) {
  await page.locator(".viewport canvas").waitFor();
  await page.waitForFunction(() => !document.querySelector(".loading-overlay") && [...document.querySelectorAll(".viewport-status")].some(item => item.textContent.includes("已恢复")));
  await page.waitForTimeout(250);
}
const gate = await createIsolatedStudioGate("legacy-material-workflow"), report = { boundary: "真实原GLB/隔离项目；不审批、不修改缓存原字节", cases: [] };
console.log(JSON.stringify({ output: gate.output }));
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) for (const uid of uids) {
    const entry = { round, theme, width, uid, errors: [], driverWarnings: [], optimizationWarnings: [], passed: false }; report.cases.push(entry);
    const context = await themeContext(gate, theme, width), page = await context.newPage(); page.setDefaultTimeout(60000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["warning", "error"].includes(message.type())) return;
      const text = message.text();
      if (message.type() === "warning" && /^prune: Detected single-color (specularTexture|specularColorTexture) texture\. Pruning \1 not yet supported\.$/.test(text)) entry.optimizationWarnings.push(text);
      else if (message.type() === "warning" && /^THREE\.WebGLProgram: Program Info Log:/.test(text) && /warning X4122: sum of/.test(text) && !/error/i.test(text)) entry.driverWarnings.push(text);
      else entry.errors.push(text);
    });
    const prefix = `r${round}-${theme}-${uid}`, shot = name => page.screenshot({ path: resolve(gate.output, `${prefix}-${name}.png`) });
    try {
      const sourcePath = resolve(cache, "models", `${uid}.glb`), bytes = await readFile(sourcePath), original = glbJson(bytes);
      assert.equal(hash(bytes), catalog.models.find(item => item.uid === uid).sha256);
      assert.ok(original.extensionsRequired.includes(legacy));
      const project = await gate.json("POST", "/api/projects", { name: `旧材质-${prefix}` }); entry.projectId = project.id;
      const source = localSource ? undefined : await uploadModel(gate, project.id, page, `${uid}.glb`, bytes);
      entry.sourceRoute = localSource ? "local-file" : "project-upload";
      if (source) assert.equal(hash(await (await gate.client.get(source.sourceUrl)).body()), hash(bytes));
      await gate.loginPage(page); await page.goto(`${gate.origin}/optimizer?project=${project.id}`);
      if (source) await page.getByLabel("从项目素材选择模型").selectOption(source.id);
      else await page.locator('.optimizer-page input[type="file"]').setInputFiles(sourcePath);
      await page.waitForFunction(() => document.querySelector(".optimizer-preview-toolbar")?.textContent.includes("模型已载入"));
      await page.getByRole("button", { name: "适应窗口", exact: true }).click(); await shot("source");
      await page.getByRole("button", { name: "开始优化", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".optimizer-preview-toolbar")?.textContent.includes("优化完成"), null, { timeout: 120000 });
      await page.getByRole("button", { name: "适应窗口", exact: true }).click(); await page.waitForTimeout(200); await shot("optimized");
      const previewDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "下载预览图", exact: true }).click();
      const previewPath = resolve(gate.output, `${prefix}-optimized-preview.png`); await (await previewDownload).saveAs(previewPath);
      const pixels = await sharp(previewPath).removeAlpha().raw().toBuffer(); let coloredPixels = 0;
      for (let index = 0; index < pixels.length; index += 3) if (Math.max(...pixels.subarray(index, index + 3)) - Math.min(...pixels.subarray(index, index + 3)) > 45) coloredPixels++;
      assert.ok(coloredPixels > 100, "Actual optimized preview must retain colored material pixels, not an empty/default-white model"); entry.optimizedColoredPixels = coloredPixels;
      const downloading = page.waitForEvent("download"); await page.getByRole("button", { name: "下载 GLB", exact: true }).click();
      const outputPath = resolve(gate.output, `${prefix}-optimized.glb`); await (await downloading).saveAs(outputPath);
      const binary = await readFile(outputPath), output = glbJson(binary);
      assert.ok(!output.extensionsUsed?.includes(legacy)); assert.ok(!output.extensionsRequired?.includes(legacy));
      assert.ok(output.materials.length > 0); assert.ok(output.materials.some(item => item.pbrMetallicRoughness?.baseColorTexture));
      assert.ok(output.materials.every(item => !item.extensions?.[legacy]));
      if (original.asset.copyright) assert.equal(output.asset.copyright, original.asset.copyright);
      entry.output = { bytes: binary.length, hash: hash(binary), materials: output.materials.length, baseMaps: output.materials.filter(item => item.pbrMetallicRoughness?.baseColorTexture).length, extensions: output.extensionsUsed };
      await page.locator(".optimizer-header-actions button.primary").click();
      await page.waitForFunction(() => document.querySelector(".optimizer-preview-toolbar")?.textContent.includes("优化模型已保存") || document.querySelector(".optimizer-error"));
      assert.equal(await page.locator(".optimizer-error").count(), 0, await page.locator(".optimizer-error").allTextContents());
      const models = (await gate.json("GET", `/api/projects/${project.id}`)).models;
      const derivative = source ? models.find(item => item.optimization?.sourceModelId === source.id) : models[0]; assert.ok(derivative);
      assert.equal(hash(await (await gate.client.get(derivative.sourceUrl)).body()), hash(binary));
      await gate.json("PATCH", `/api/projects/${project.id}/models/${derivative.id}`, { name: "兼容材质派生模型" });
      await page.goto(`${gate.origin}/manager?project=${project.id}`);
      await page.getByRole("button", { name: "新建场景", exact: true }).click(); await page.getByLabel("场景名称").fill("旧材质真实模型复验");
      const creating = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}/applications`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "创建并进入", exact: true }).click();
      const created = await creating; assert.equal(created.status(), 201); const app = await created.json();
      const appPath = `/api/projects/${project.id}/applications/${app.metadata.id}`;
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${app.metadata.id}/scenes/${app.scenes[0].id}`);
      await page.locator(".viewport canvas").waitFor(); const autoSave = page.getByLabel("自动保存"); if (await autoSave.isChecked()) await autoSave.uncheck();
      if (!await page.locator(".asset-row").count()) await page.getByRole("button", { name: "场景图层与编组", exact: true }).click();
      const row = page.locator(".asset-row").filter({ hasText: "兼容材质派生模型" });
      await row.locator(".asset-main").click(); await row.locator(".mini-button").first().waitFor(); await row.locator(".asset-main").dblclick();
      await page.waitForTimeout(1600); const saved = await saveScene(page, appPath);
      assert.deepEqual(saved.models.map(item => item.modelId), [derivative.id]); await shot("scene");
      await page.reload(); await restored(page); await shot("scene-reloaded");
      const persisted = await gate.json("GET", appPath); assert.deepEqual(persisted.scenes[0].models.map(item => item.modelId), [derivative.id]);
      if (uid === uids[0]) {
        // 历史场景夹具：相同隔离geometry URL返回未改旧GLB，不把新API现代派生当旧加载证据。
        const geometry = derivative.manifest.geometryUrl, routePattern = `**${geometry}`; let originalRequests = 0;
        const storedGeometryHash = hash(await (await gate.client.get(geometry)).body());
        await page.route(routePattern, async route => { originalRequests++; await route.fulfill({ status: 200, contentType: "model/gltf-binary", body: bytes }); });
        await page.reload(); await restored(page);
        await ensureRows(page, saved.models[0].id ?? derivative.id);
        await page.getByRole("button", { name: "适应全部", exact: true }).click();
        await page.waitForTimeout(1200); await saveScene(page, appPath); await shot("historical-raw-scene");
        await page.reload(); await restored(page); await shot("historical-raw-reloaded");
        assert.ok(originalRequests >= 2, "Both historical scene loads must actually request the unchanged legacy GLB");
        assert.equal(hash(await (await gate.client.get(geometry)).body()), storedGeometryHash, "Historical route fixture cannot rewrite persisted derivative geometry");
        entry.historicalRaw = { originalRequests, suppliedHash: hash(bytes), persistedGeometryUnchanged: true };
        await page.unroute(routePattern);
      }
      assert.equal(hash(await readFile(sourcePath)), hash(bytes)); assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack; await shot("failed").catch(() => {}); }
    finally { await context.close(); await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ round, theme, uid, passed: entry.passed, failure: entry.failure, errors: entry.errors })); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
assert.ok(report.cases.length === 12 && report.cases.every(item => item.passed));
