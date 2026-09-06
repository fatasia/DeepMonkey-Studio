import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createScene, observeDiagnostics, themeContext } from "./gateModelInstancesSupport.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";
import sharp from "sharp";

const gate = await createIsolatedStudioGate("workspace-themes");
const report = { cases: [] }; console.log(JSON.stringify({ output: gate.output }));
async function controlTheme(locator) {
  return locator.evaluate(element => {
    const css = getComputedStyle(element), probe = document.createElement("span");
    probe.style.background = "var(--surface-2)"; element.parentElement.append(probe);
    const expected = getComputedStyle(probe).backgroundColor; probe.remove();
    return { background: css.backgroundColor, expected, color: css.color };
  });
}
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const entry = { round, theme, width, passed: false, errors: [], driverWarnings: [], expectedNetworkErrors: [] }; report.cases.push(entry);
    const context = await themeContext(gate, theme, width), page = await context.newPage(); page.setDefaultTimeout(20000); observeDiagnostics(page, entry);
    const shot = name => page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${width}-${name}.png`) });
    try {
      const project = await gate.json("POST", "/api/projects", { name: `工作区主题-${round}-${theme}` });
      const { application, appPath } = await createScene(gate, page, project.id);
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${application.pages[0].id}`);
      const inspector = page.locator(".dashboard-inspector-panel"); await inspector.waitFor();
      const name = inspector.getByLabel("页面名称", { exact: true }); await name.waitFor();
      entry.dashboardControl = await controlTheme(name); assert.equal(entry.dashboardControl.background, entry.dashboardControl.expected);
      const original = await name.inputValue(); await name.fill("本地编辑验证"); await name.press("Tab");
      assert.equal(await name.inputValue(), "本地编辑验证"); await name.fill(original); await name.press("Tab");
      await shot("dashboard-inspector");
      await page.goto(`${gate.origin}/manager?project=${project.id}`);
      await page.getByRole("button", { name: "视觉中心", exact: true }).click();
      for (const tab of ["识别任务", "视觉源", "识别记录", "AI模型"]) {
        await page.locator(".vision-tabs").getByRole("button", { name: tab, exact: true }).click();
        await shot(`vision-${tab}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      }
      await page.getByRole("button", { name: "视觉源", exact: true }).click();
      await page.getByRole("button", { name: "添加视频源", exact: true }).click();
      const modal = page.locator(".vision-modal"), field = modal.getByLabel("名称", { exact: true });
      await field.fill("不会提交的视频源"); await field.focus();
      entry.visionControl = await controlTheme(field); assert.equal(entry.visionControl.background, entry.visionControl.expected);
      entry.contrast = await modal.evaluate(collectTextContrast, "header strong,label > span,label > small,footer button");
      assert.deepEqual(entry.contrast.filter(item => item.text && item.contrast < 4.5), []);
      await shot("vision-source-form");
      await modal.getByRole("combobox").first().selectOption("upload"); await shot("vision-upload-form");
      await page.keyboard.press("Escape"); await modal.waitFor({ state: "detached" });
      await page.getByRole("button", { name: "添加视频源", exact: true }).click();
      await modal.getByRole("combobox").first().selectOption("upload");
      await modal.getByLabel("名称", { exact: true }).fill("隔离图片源");
      const pixels = await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 214, g: 170, b: 77 } } }).png().toBuffer();
      await modal.locator('input[type="file"]').setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: pixels });
      const uploaded = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/vision/sources/upload") && response.request().method() === "POST");
      await modal.getByRole("button", { name: "保存并接入", exact: true }).click();
      assert.ok((await uploaded).ok()); await modal.waitFor({ state: "detached" });
      await page.locator(".vision-source-card").filter({ hasText: "隔离图片源" }).waitFor(); await shot("vision-created-source");
      const sources = await gate.json("GET", `/api/projects/${project.id}/vision/sources`);
      assert.equal(sources.length, 1); assert.equal(sources[0].name, "隔离图片源");
      const after = await gate.json("GET", appPath); assert.deepEqual(after.scenes, application.scenes);
      if (theme === "light") for (const small of [800, 480]) {
        await page.setViewportSize({ width: small, height: 1000 });
        await page.getByRole("button", { name: "添加视频源", exact: true }).click();
        await modal.waitFor(); await shot(`vision-${small}`);
        const bounds = await modal.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= small);
        await page.keyboard.press("Escape"); await modal.waitFor({ state: "detached" });
      }
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack; entry.url = page.url(); await shot("failed"); throw error; }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, passed: report.cases.every(item => item.passed) }));
