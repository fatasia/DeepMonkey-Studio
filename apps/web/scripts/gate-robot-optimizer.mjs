import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";
import { observeDiagnostics, themeContext } from "./gateModelInstancesSupport.mjs";
import { URDF_GATE_SOURCE } from "./urdfGateFixture.mjs";

const gate = await createIsolatedStudioGate("robot-optimizer");
const report = { bundleSha256: createHash("sha256").update(await readFile(new URL("../dist/index.html", import.meta.url))).digest("hex"), cases: [] };
console.log(JSON.stringify({ output: gate.output }));
const zip = await new JSZip().file("alternate.urdf", '<robot name="other"><link name="base"/></robot>').file("robot/selected.urdf", URDF_GATE_SOURCE).generateAsync({ type: "nodebuffer" });
try {
  for (const theme of ["dark", "light"]) for (const width of [1440, 980]) {
    const entry = { theme, width, passed: false, errors: [], driverWarnings: [], expectedNetworkErrors: [] }; report.cases.push(entry);
    const context = await themeContext(gate, theme, width), page = await context.newPage(); page.setDefaultTimeout(25000); observeDiagnostics(page, entry);
    const shot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`) });
    try {
      const project = await gate.json("POST", "/api/projects", { name: `机器人优化-${theme}-${width}` });
      await gate.loginPage(page); await page.goto(`${gate.origin}/optimizer?project=${project.id}`);
      const chooseFile = async () => page.locator('.optimizer-page input[type="file"]').setInputFiles({ name: "robot.zip", mimeType: "application/zip", buffer: zip });
      await chooseFile(); const dialog = page.getByRole("dialog", { name: "选择机器人", exact: true });
      await dialog.waitFor(); await shot("choose-entry"); await dialog.getByRole("button", { name: "取消", exact: true }).click();
      assert.equal((await gate.json("GET", `/api/projects/${project.id}`)).models.length, 0);
      await chooseFile(); await dialog.getByRole("combobox").selectOption("robot/selected.urdf");
      await dialog.getByRole("button", { name: "导入", exact: true }).click();
      const workspace = page.locator(".robot-asset-workspace"), preview = workspace.locator(".robot-asset-viewport");
      await workspace.waitFor(); await page.getByRole("spinbutton", { name: "shoulder_pitch (°)", exact: true }).waitFor();
      await preview.locator('[role="status"]').waitFor({ state: "detached" }); await page.waitForTimeout(350);
      assert.equal(await page.getByRole("button", { name: "下载 GLB", exact: true }).count(), 0);
      await page.getByRole("spinbutton", { name: "shoulder_pitch (°)", exact: true }).fill("40");
      await shot("pose-preview");
      const source = (await gate.json("GET", `/api/projects/${project.id}`)).models[0];
      assert.equal(source.manifest.robot.entryPath, "robot/selected.urdf");
      assert.equal(createHash("sha256").update(await (await gate.client.get(source.sourceUrl)).body()).digest("hex"), createHash("sha256").update(zip).digest("hex"));
      const sourceDownload = page.waitForEvent("download"); await workspace.getByRole("button", { name: `下载原包 ${source.name}`, exact: true }).click();
      const sourcePath = resolve(gate.output, `${theme}-${width}-source.zip`); await (await sourceDownload).saveAs(sourcePath); assert.deepEqual(await readFile(sourcePath), zip);
      const screenshot = page.waitForEvent("download"); await workspace.getByRole("button", { name: "截图", exact: true }).click();
      const imagePath = resolve(gate.output, `${theme}-${width}-preview.jpg`); await (await screenshot).saveAs(imagePath); assert.ok((await readFile(imagePath)).byteLength > 1000);
      await workspace.getByRole("button", { name: "压缩", exact: true }).click();
      const download = page.waitForEvent("download"); await workspace.getByRole("button", { name: "下载", exact: true }).click();
      const downloaded = await download, outputPath = resolve(gate.output, `${theme}-${width}-compressed.zip`); await downloaded.saveAs(outputPath);
      const compressed = await JSZip.loadAsync(await readFile(outputPath));
      assert.equal(await compressed.file("robot/selected.urdf").async("text"), URDF_GATE_SOURCE);
      assert.equal(Object.values(compressed.files).filter(file => !file.dir).length, 2);
      const created = page.waitForResponse(response => new URL(response.url()).pathname === `/api/projects/${project.id}/models` && response.request().method() === "POST");
      let arrived, release, uploads = 0;
      const arrival = new Promise(resolve => { arrived = resolve; }), hold = new Promise(resolve => { release = resolve; });
      await page.route(`**/api/projects/${project.id}/models?optimizedFromModelId=*`, async route => {
        uploads++; const response = await route.fetch(); arrived(); await hold; await route.fulfill({ response });
      });
      await workspace.getByRole("button", { name: "另存素材", exact: true }).dblclick(); await arrival;
      await workspace.getByRole("button", { name: "取消处理", exact: true }).click(); release();
      const uploaded = await created; assert.equal(uploaded.status(), 202);
      await workspace.getByRole("button", { name: "另存素材", exact: true }).click();
      await workspace.getByText("已保存", { exact: true }).waitFor();
      assert.equal(uploads, 1, "Cancelled wait must reuse the upload receipt"); await page.unroute(`**/api/projects/${project.id}/models?optimizedFromModelId=*`);
      let models = (await gate.json("GET", `/api/projects/${project.id}`)).models;
      assert.equal(models.length, 2); const saved = models.find(model => model.id !== source.id);
      assert.equal(saved.status, "ready"); assert.equal(saved.optimization.sourceModelId, source.id);
      assert.equal(saved.manifest.robot.entryPath, source.manifest.robot.entryPath); assert.deepEqual(saved.manifest.robot.resources, source.manifest.robot.resources);
      await shot("saved");
      await workspace.locator('input[type="file"]').setInputFiles({ name: "invalid.zip", mimeType: "application/zip", buffer: Buffer.from("broken") });
      await workspace.getByRole("alert").waitFor(); assert.equal(await page.getByRole("spinbutton", { name: "shoulder_pitch (°)", exact: true }).inputValue(), "40");
      await shot("invalid-keeps-pose");
      entry.contrast = await workspace.evaluate(collectTextContrast, 'h1,h2,.robot-joint-preview summary,.robot-joint-preview label span:first-child,.robot-package-actions button,.robot-package-actions > span');
      assert.deepEqual(entry.contrast.filter(item => item.text && item.contrast < 4.5), []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await workspace.getByRole("button", { name: "素材库", exact: true }).click();
      const asset = page.locator(`.model-library-item[data-model-id="${saved.id}"]`); await asset.waitFor();
      await asset.getByRole("button", { name: `预览与优化 ${saved.name}`, exact: true }).click();
      await page.getByRole("spinbutton", { name: "shoulder_pitch (°)", exact: true }).waitFor();
      assert.equal(await page.getByRole("spinbutton", { name: "shoulder_pitch (°)", exact: true }).inputValue(), "0", "Preview edits never mutate source asset");
      await preview.locator('[role="status"]').waitFor({ state: "detached" });
      await page.waitForTimeout(350);
      await shot("reopened");
      if (theme === "light" && width === 980) for (const small of [800, 480]) {
        await page.setViewportSize({ width: small, height: 1000 });
        await page.waitForTimeout(350);
        const { data, info } = await sharp(await preview.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        let robotPixels = 0;
        for (let pixel = 0; pixel < data.length; pixel += info.channels) {
          if (data[pixel] > 90 && data[pixel] > data[pixel + 1] * 1.04 && data[pixel + 1] > data[pixel + 2] * 1.15) robotPixels++;
        }
        assert.ok(robotPixels > 100, `Robot must remain rendered at ${small}px, got ${robotPixels} gold fixture pixels`);
        (entry.responsivePixels ??= []).push({ width: small, robotPixels });
        await shot(`responsive-${small}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      }
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack; await shot("failed"); throw error; }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, passed: report.cases.every(item => item.passed) }));
