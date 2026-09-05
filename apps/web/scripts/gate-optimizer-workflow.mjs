import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";
import { gateOptimizerPublication } from "./gateOptimizerPublication.mjs";

const gate = await createIsolatedStudioGate("optimizer-workflow");
const cache = resolve(import.meta.dirname, "../../../data/external-assets/source-b");
const report = { cases: [] };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function ready(projectId, id, page) {
  for (let i = 0; i < 100; i++) {
    const project = await gate.json("GET", `/api/projects/${projectId}`);
    const model = project.models.find(model => model.id === id);
    if (model?.status === "ready") return model;
    assert.notEqual(model?.status, "failed", model?.message);
    await page.waitForTimeout(150);
  }
  throw new Error("Conversion did not finish");
}
try {
  const target = resolve(gate.output, "data/external-assets/source-b");
  const audit = JSON.parse(await readFile(resolve(cache, "audit.json"), "utf8"));
  await Promise.all([mkdir(resolve(target, "models"), { recursive: true }), mkdir(resolve(target, "reviewed-thumbnails"), { recursive: true })]);
  for (const file of ["catalog.json", "audit.json"]) await copyFile(resolve(cache, file), resolve(target, file));
  for (const item of audit.items) {
    assert.match(item.uid, /^[a-f0-9]{32}$/);
    await copyFile(resolve(cache, "models", `${item.uid}.glb`), resolve(target, "models", `${item.uid}.glb`));
    await copyFile(resolve(cache, "reviewed-thumbnails", `${item.uid}.png`), resolve(target, "reviewed-thumbnails", `${item.uid}.png`));
  }
  for (const theme of ["dark", "light"]) for (const width of [1440, 980]) {
    const entry = { theme, width, passed: false, errors: [], driverWarnings: [], steps: [], workers: 0, workersClosed: 0 }; report.cases.push(entry);
    const context = await gate.browser.newContext({ viewport: { width, height: 1000 } });
    await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } }); });
    const page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on("worker", worker => { entry.workers++; worker.on("close", () => entry.workersClosed++); });
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["warning", "error"].includes(message.type())) return;
      if (/^THREE\.WebGLProgram: Program Info Log:/.test(message.text()) && /warning X4122: sum of/.test(message.text()) && !/error/i.test(message.text())) entry.driverWarnings.push(message.text());
      else entry.errors.push(message.text());
    });
    const shot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`) });
    try {
      const project = await gate.json("POST", "/api/projects", { name: `优化工作流-${theme}-${width}` });
      const imported = await gate.json("POST", `/api/projects/${project.id}/asset-library/community-71df42c5d5964d2ea149c5513bbc061b/import`);
      const source = await ready(project.id, imported.model.id, page);
      const original = await (await gate.client.get(source.sourceUrl)).body();
      await gate.loginPage(page); await page.goto(`${gate.origin}/optimizer?project=${project.id}`);
      await page.getByLabel("从项目素材选择模型").selectOption(source.id);
      await page.waitForFunction(() => document.querySelector(".optimizer-preview-toolbar")?.textContent.includes("模型已载入"));
      assert.match(await page.locator(".optimizer-file strong").innerText(), /平行机械夹爪/);
      await page.locator(".model-asset-credit summary").press("Enter");
      assert.match(await page.locator(".model-asset-credit").innerText(), /trinityscsp/);
      await shot("source-credit");
      const optimize = async () => {
        await page.getByRole("button", { name: "开始优化", exact: true }).click();
        await page.waitForFunction(() => document.querySelector(".optimizer-preview-toolbar")?.textContent.includes("优化完成"));
        await page.locator(".optimizer-preview-state").waitFor({ state: "detached" });
      };
      await optimize();
      const save = page.locator(".optimizer-header-actions button.primary");
      await save.click();
      await page.waitForFunction(() => document.querySelector(".optimizer-preview-toolbar")?.textContent.includes("优化模型已保存"));
      assert.equal(await save.innerText(), "查看项目素材");
      let models = (await gate.json("GET", `/api/projects/${project.id}`)).models;
      const first = models.find(model => model.optimization?.sourceModelId === source.id);
      assert.ok(first); assert.equal(first.libraryOrigin, undefined, "A derivative must not own the catalog dedup identity");
      assert.deepEqual(first.optimization.libraryOrigin, source.libraryOrigin);
      const reused = await gate.json("POST", `/api/projects/${project.id}/asset-library/${source.libraryOrigin.itemId}/import`);
      assert.equal(reused.model.id, source.id);
      await page.getByLabel("目标保留比例", { exact: true }).press("ArrowRight");
      assert.equal(await save.isDisabled(), true);
      await optimize(); assert.equal(await save.isEnabled(), true, "New optimization must clear the old saved marker");
      const download = page.waitForEvent("download"); await page.getByRole("button", { name: "下载 GLB", exact: true }).click();
      const output = resolve(gate.output, `${theme}-${width}-optimized.glb`); await (await download).saveAs(output);
      const binary = await readFile(output); const json = JSON.parse(binary.subarray(20, 20 + binary.readUInt32LE(12)).toString("utf8").trim());
      assert.match(json.asset.copyright, /trinityscsp/); assert.match(json.asset.copyright, /creativecommons.org\/licenses\/by\/4.0/);
      assert.ok(json.animations?.length, "Animated source GLB must retain animation through optimization");
      entry.steps.push("source bytes / animation / attribution / optimize-save-rerun");

      let release; let arrived; const arrival = new Promise(resolve => { arrived = resolve; }); const hold = new Promise(resolve => { release = resolve; });
      let uploads = 0;
      await page.route(`**/api/projects/${project.id}/models*`, async route => {
        if (route.request().method() !== "POST") return route.continue();
        uploads++; const response = await route.fetch(); arrived(); await hold; await route.fulfill({ response });
      });
      await save.click(); await arrival; await page.getByRole("button", { name: "取消处理", exact: true }).click();
      release(); await page.waitForTimeout(100);
      await save.click();
      await page.waitForFunction(() => document.querySelector(".optimizer-preview-toolbar")?.textContent.includes("优化模型已保存"));
      assert.equal(uploads, 1, "Resuming a cancelled save must reuse its upload receipt");
      await page.unroute(`**/api/projects/${project.id}/models*`);
      models = (await gate.json("GET", `/api/projects/${project.id}`)).models;
      assert.equal(models.length, 3);
      assert.equal(sha(await (await gate.client.get(source.sourceUrl)).body()), sha(original));
      entry.steps.push("cancel delayed save / resume same receipt / original unchanged");

      await page.locator('.optimizer-page input[type="file"]').setInputFiles({ name: "broken.glb", mimeType: "model/gltf-binary", buffer: Buffer.from("not a model") });
      await page.locator(".optimizer-error").waitFor();
      assert.match(await page.locator(".optimizer-file strong").innerText(), /平行机械夹爪/);
      assert.equal(await page.getByRole("button", { name: "下载 GLB", exact: true }).isEnabled(), true);
      await shot("failed-replacement-keeps-result");
      await page.getByLabel("从项目素材选择模型").selectOption(first.id);
      await page.waitForFunction(() => document.querySelector(".optimizer-preview-toolbar")?.textContent.includes("模型已载入"));
      assert.equal(await page.getByRole("button", { name: "下载 GLB", exact: true }).isDisabled(), true);
      assert.equal(await page.locator(".optimizer-error").count(), 0);
      await page.getByRole("switch", { name: "轻量光照烘焙", exact: true }).click();
      await page.getByRole("button", { name: "Web 光照贴图", exact: true }).click();
      await page.getByRole("button", { name: "自然日光", exact: true }).click();
      await page.getByRole("button", { name: "高质量", exact: true }).click();
      await shot("bake-controls");
      await page.getByRole("switch", { name: "轻量光照烘焙", exact: true }).click();
      entry.contrast = await page.locator(".optimizer-page").evaluate(collectTextContrast, ".optimizer-pipeline-steps b, .optimizer-source-actions select, .optimizer-option-head strong, .optimizer-option-body p, .optimizer-render-settings button, .optimizer-header-actions button, .optimizer-preview-toolbar > span");
      await shot("ready");
      assert.deepEqual(entry.contrast.filter(item => item.text && item.contrast < 4.5), []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.getByRole("button", { name: "返回场景管理", exact: true }).click();
      await page.locator(".unified-assets-page").waitFor();
      assert.equal(new URL(page.url()).searchParams.get("tab"), "assets");
      assert.equal(new URL(page.url()).searchParams.get("project"), project.id);
      await page.reload(); await page.locator(".unified-assets-page").waitFor();
      assert.equal(entry.workersClosed, entry.workers, "All optimizer workers must close before returning to assets");
      entry.steps.push("failed replacement retains result / source switch resets result / bake controls / return and reload assets");
      await gateOptimizerPublication(gate, page, entry, project.id, first, source);
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack; await shot("failed"); throw error; }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, passed: report.cases.every(item => item.passed) }));
