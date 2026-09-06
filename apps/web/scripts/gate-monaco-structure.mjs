import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createDebugFixture } from "./authorDebugFixture.mjs";

const gate = await createIsolatedStudioGate("monaco-structure");
const report = { createdAt: new Date().toISOString(), bundleSha256: createHash("sha256").update(await readFile(new URL("../dist/index.html", import.meta.url))).digest("hex"), cases: [] };
try {
  for (const theme of ["dark", "light"]) for (const width of [1280, 980]) {
    const entry = { theme, width, passed: false, errors: [], writes: 0, editingCycles: 0 };
    report.cases.push(entry);
    const { project, application } = await createDebugFixture(gate, theme, width);
    const appPath = `/api/projects/${project.id}/applications/${application.metadata.id}`;
    const before = await gate.json("GET", appPath);
    const context = await gate.browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } }); });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on("pageerror", error => entry.errors.push({ stack: error.stack }));
    page.on("console", message => { if (["error", "warning"].includes(message.type())) entry.errors.push({ text: message.text(), location: message.location() }); });
    page.on("request", request => { if (request.url().endsWith(appPath) && request.method() === "PUT") entry.writes++; });
    try {
      await gate.loginPage(page);
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/page`);
      await page.getByRole("checkbox", { name: "自动保存", exact: true }).uncheck();
      await page.getByRole("button", { name: "脚本", exact: true }).click();
      await page.locator(".monaco-editor .view-lines").waitFor();
      const editor = page.locator(".professional-code-editor");
      const fingerprint = await editor.getAttribute("data-content-fingerprint");
      // SDK错误发生于首次插入前的代码编辑；反复清空/撤销并改变可见范围，
      // 覆盖指南位置暂不可见的渲染窗口，不更改第三方源码、不吞控制台异常。
      await page.locator(".monaco-editor").click({ position: { x: 160, y: 80 } });
      for (let index = 0; index < 20; index++) {
        await page.keyboard.press("Control+A"); await page.keyboard.press("Backspace");
        assert.notEqual(await editor.getAttribute("data-content-fingerprint"), fingerprint);
        await page.keyboard.press("Control+Z");
        assert.equal(await editor.getAttribute("data-content-fingerprint"), fingerprint);
        await page.keyboard.press(index % 2 ? "Control+Home" : "Control+End");
        await page.setViewportSize({ width: index % 2 ? width : width + 80, height: 900 });
        entry.editingCycles++;
      }
      await page.setViewportSize({ width, height: 900 });
      await page.keyboard.press("Control+Home");
      await page.waitForTimeout(250);
      entry.indentGuides = await page.locator(".monaco-editor .core-guide-indent").count();
      entry.bracketGuides = await page.locator(".monaco-editor .bracket-indent-guide").count();
      entry.bracketColors = await page.locator('.monaco-editor .view-lines [class*="bracket-highlighting-"]').count();
      assert.ok(entry.indentGuides > 0, "Indentation guides must remain visible");
      assert.ok(entry.bracketColors > 0, "Bracket character colors must remain enabled");
      assert.equal(entry.bracketGuides, 0, "The upstream unsafe bracket-guide rendering path must be disabled");
      assert.deepEqual(entry.errors, []); assert.equal(entry.writes, 0);
      assert.deepEqual(await gate.json("GET", appPath), before);
      entry.passed = true;
    } catch (error) { entry.failure = error.stack ?? String(error); }
    finally { await page.screenshot({ path: resolve(gate.output, `${theme}-${width}.png`) }); await context.close(); console.log(JSON.stringify(entry)); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, report }, null, 2));
assert.equal(report.cases.filter(entry => entry.passed).length, 4);
