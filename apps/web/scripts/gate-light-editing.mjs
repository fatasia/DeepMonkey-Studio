import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";

const gate = await createIsolatedStudioGate("light-editing");
const report = { createdAt: new Date().toISOString(), cases: [], boundary: "独立项目中真实灯光编辑、保存和恢复；不是整机 FPS 或 WebGPU 性能结论。" };
console.log(JSON.stringify({ output: gate.output }));
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const entry = { round, theme, width, errors: [], driverWarnings: [], passed: false };
    report.cases.push(entry);
    const context = await gate.browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
    await context.route("**/api/public/branding", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["warning", "error"].includes(message.type())) return;
      const text = message.text();
      if (message.type() === "warning" && /^THREE\.WebGLProgram: Program Info Log:/.test(text) && /warning X4122: sum of/.test(text) && !/error/i.test(text)) entry.driverWarnings.push(text);
      else entry.errors.push(text);
    });
    const shot = name => page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${width}-${name}.png`) });
    const open = async () => {
      await page.getByRole("button", { name: "查看与分析", exact: true }).click();
      await page.getByRole("menuitem", { name: "环境与灯光", exact: true }).click();
      await page.getByLabel("环境与全局灯光", { exact: true }).waitFor();
    };
    const panel = page.getByLabel("环境与全局灯光", { exact: true });
    try {
      const project = await gate.json("POST", "/api/projects", { name: `灯光验证-${round}-${theme}` });
      await gate.loginPage(page); await page.goto(`${gate.origin}/manager?project=${project.id}`);
      await page.getByRole("button", { name: "新建场景", exact: true }).click();
      await page.getByLabel("场景名称").fill("灯光编辑验证");
      const creating = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}/applications`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "创建并进入", exact: true }).click();
      const created = await creating; assert.equal(created.status(), 201);
      const application = await created.json();
      const appPath = `/api/projects/${project.id}/applications/${application.metadata.id}`;
      const scenePath = `${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/scenes/${application.scenes[0].id}`;
      await page.goto(scenePath); await page.locator(".viewport canvas").waitFor();
      if (await page.getByLabel("自动保存", { exact: true }).isChecked()) await page.getByLabel("自动保存", { exact: true }).uncheck();
      await open(); await panel.locator(".light-system-head select").selectOption("directional");
      const lightEditor = panel.locator(".light-editor");
      await lightEditor.getByLabel("名称", { exact: true }).fill("验收方向光");
      const vectors = lightEditor.locator(".light-vector");
      const setVector = async (index, values) => {
        const inputs = vectors.nth(index).locator("input");
        for (let axis = 0; axis < values.length; axis++) { await inputs.nth(axis).fill(String(values[axis])); await inputs.nth(axis).press("Tab"); }
      };
      await setVector(0, [6, 5, 4]); await setVector(1, [0, 0, 0]);
      await vectors.nth(1).scrollIntoViewIfNeeded(); await page.waitForTimeout(500);
      const canvas = page.locator(".viewport canvas");
      // 元素截图会包含覆盖其上的表单；只取未被环境面板遮挡的3D区域。
      const viewport = await canvas.boundingBox(), overlay = await panel.boundingBox();
      assert.ok(viewport && overlay);
      const clip = { x: viewport.x + 4, y: viewport.y + 110, width: overlay.x - viewport.x - 8, height: viewport.height - 160 };
      assert.ok(clip.width >= 40 && clip.height >= 200);
      if (process.argv.includes("--layout")) assert.ok(clip.width >= 300, "Editing lights must retain at least 300px unobstructed scene width");
      const pixels = async () => sharp(await page.screenshot({ clip })).ensureAlpha().raw().toBuffer();
      entry.sceneClip = clip;
      const before = await pixels();
      await shot("before");
      await setVector(0, [-6, 5, 4]); await setVector(1, [2, 0, -2]);
      await vectors.nth(1).scrollIntoViewIfNeeded(); await page.waitForTimeout(500);
      const after = await pixels();
      assert.equal(after.length, before.length);
      let changedPixels = 0;
      for (let offset = 0; offset < before.length; offset += 4) if (Math.max(...[0, 1, 2].map(channel => Math.abs(before[offset + channel] - after[offset + channel]))) > 8) changedPixels++;
      assert.ok(changedPixels > 20, "Real rendered light handles/direction must visibly move");
      entry.changedPixels = changedPixels; await shot("moved");
      const saving = page.waitForResponse(response => response.url().endsWith(`${appPath}/workspace`) && response.request().method() === "PUT");
      await page.getByRole("button", { name: "保存项目", exact: true }).click(); assert.equal((await saving).status(), 200);
      await page.reload(); await page.locator(".viewport canvas").waitFor(); await open();
      await panel.locator(".light-tabs").getByRole("button", { name: "验收方向光", exact: true }).click();
      const position = await vectors.nth(0).locator("input").evaluateAll(inputs => inputs.map(input => Number(input.value)));
      const target = await vectors.nth(1).locator("input").evaluateAll(inputs => inputs.map(input => Number(input.value)));
      assert.deepEqual(position, [-6, 5, 4]); assert.deepEqual(target, [2, 0, -2]);
      await vectors.nth(1).scrollIntoViewIfNeeded(); await shot("restored");
      if (process.argv.includes("--layout")) {
        await panel.getByRole("button", { name: "关闭环境与灯光", exact: true }).click();
        assert.equal(await panel.count(), 0);
        assert.ok(await page.locator(".app-shell:not(.app-shell-hidden) > .right-panel").isVisible(), "Closing environment must restore the previous inspector");
        await shot("closed-inspector-restored");
        await page.getByRole("button", { name: "收起属性检查器", exact: true }).click();
        await open(); await panel.getByRole("button", { name: "关闭环境与灯光", exact: true }).click();
        assert.equal(await page.locator(".app-shell:not(.app-shell-hidden) > .right-panel").isVisible(), false, "Environment must not overwrite an explicitly collapsed inspector preference");
        await page.getByRole("button", { name: "展开属性检查器", exact: true }).click();
      }
      await page.goto(`${gate.origin}/manager?project=${project.id}`); await page.locator(".scene-manager-page").waitFor();
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = String(error); await shot("failed"); }
    finally { await context.close(); }
  }
} finally { await gate.close(); await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report));
assert.ok(report.cases.every(entry => entry.passed), `Inspect ${gate.output}`);
