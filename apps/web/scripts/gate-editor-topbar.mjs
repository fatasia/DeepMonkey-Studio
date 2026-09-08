import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createScene, observeDiagnostics, themeContext } from "./gateModelInstancesSupport.mjs";

const gate = await createIsolatedStudioGate("editor-topbar");
const report = { cases: [] };
console.log(JSON.stringify({ output: gate.output }));
try {
  for (const theme of ["dark", "light"]) {
    const context = await themeContext(gate, theme, 1920);
    const page = await context.newPage();
    const diagnostics = { errors: [], driverWarnings: [], expectedNetworkErrors: [] };
    observeDiagnostics(page, diagnostics);
    const project = await gate.json("POST", "/api/projects", { name: "标题栏对齐验证" });
    const { application, scenePath } = await createScene(gate, page, project.id);
    const routes = {
      "3d": scenePath,
      "2d": `${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${application.pages[0].id}`,
    };
    for (const round of [1, 2]) for (const width of [1920, 1440, 980]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const [mode, url] of Object.entries(routes)) {
        const entry = { round, theme, width, mode, passed: false };
        report.cases.push(entry);
        await page.goto(url);
        const header = page.locator(mode === "3d" ? ".topbar" : ".dashboard-workspace-topbar");
        await header.waitFor();
        await page.evaluate(() => document.fonts.ready);
        const bounds = await header.evaluate(element => {
          const actions = element.querySelector(".topbar-actions, .dashboard-workspace-actions");
          const rect = element.getBoundingClientRect();
          const actionRect = actions.getBoundingClientRect();
          const buttons = [...actions.querySelectorAll("button")].filter(button => button.getBoundingClientRect().width);
          const last = buttons.at(-1).getBoundingClientRect();
          return { width: innerWidth, headerRight: rect.right, rightGap: innerWidth - last.right,
            actionGap: rect.right - actionRect.right, scrollWidth: document.documentElement.scrollWidth,
            buttonsInside: buttons.every(button => { const r = button.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }) };
        });
        Object.assign(entry, bounds);
        assert.ok(Math.abs(bounds.rightGap - 12) <= 1, JSON.stringify(entry));
        assert.ok(bounds.buttonsInside && bounds.scrollWidth <= width, JSON.stringify(entry));
        await page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${width}-${mode}.png`) });
        entry.passed = true;
      }
    }
    assert.deepEqual(diagnostics.errors, []);
    await context.close();
  }
} finally {
  await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2));
  await gate.close();
}
assert.equal(report.cases.length, 24);
assert.ok(report.cases.every(entry => entry.passed));
console.log(JSON.stringify({ passed: report.cases.length }));
