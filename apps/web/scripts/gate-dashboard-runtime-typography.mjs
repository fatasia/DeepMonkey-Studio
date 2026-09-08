import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createScene, observeDiagnostics, themeContext } from "./gateModelInstancesSupport.mjs";

const gate = await createIsolatedStudioGate("runtime-typography");
const report = { cases: [] };
console.log(JSON.stringify({ output: gate.output }));
async function inspect(page) {
  return page.evaluate(() => {
    const inspectNode = selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const css = getComputedStyle(element), rect = element.getBoundingClientRect();
      const ancestry = [];
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        ancestry.push({ tag: node.tagName, class: node.className, font: style.fontSize, transform: style.transform, zoom: style.zoom, width: node.getBoundingClientRect().width, offsetWidth: node.offsetWidth });
      }
      const rules = [];
      function visit(ruleList) {
        for (const rule of ruleList) {
          if (rule.selectorText && rule.style?.fontSize) {
            try { if (element.matches(rule.selectorText)) rules.push({ selector: rule.selectorText, font: rule.style.fontSize }); } catch {}
          }
          if (rule.cssRules) visit(rule.cssRules);
        }
      }
      for (const sheet of document.styleSheets) { try { visit(sheet.cssRules); } catch {} }
      return { text: element.textContent, font: css.fontSize, weight: css.fontWeight, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, ancestry, rules };
    };
    return { kpi: inspectNode(".dashboard-runtime-artboard .dashboard-value > strong"), label: inspectNode(".dashboard-runtime-artboard .dashboard-value > span"), title: inspectNode(".dashboard-runtime-artboard .dashboard-decoration-widget strong") };
  });
}
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const entry = { round, theme, width, errors: [], driverWarnings: [], expectedNetworkErrors: [], passed: false }; report.cases.push(entry);
    const context = await themeContext(gate, theme, width), page = await context.newPage();
    observeDiagnostics(page, entry); page.setDefaultTimeout(30000);
    try {
      const project = await gate.json("POST", "/api/projects", { name: `字体验收-${round}-${theme}` });
      const { application, appPath } = await createScene(gate, page, project.id);
      const authored = structuredClone(application); authored.pages[0].nodes = [];
      await gate.json("PUT", appPath, authored);
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${application.pages[0].id}`);
      await page.locator(".dashboard-left-tabs").getByRole("button", { name: "资源", exact: true }).click();
      await page.getByRole("button", { name: "模板", exact: true }).click();
      await page.getByLabel("模板分类").selectOption({ label: "行业深度包" });
      await page.locator("article.dashboard-template-pack").getByRole("button", { name: /导入整包/ }).click();
      const saving = page.waitForResponse(response => response.url().endsWith(appPath) && response.request().method() === "PUT");
      await page.getByRole("button", { name: "保存", exact: true }).click(); assert.equal((await saving).status(), 200);
      await page.getByRole("button", { name: "浏览", exact: true }).click();
      await page.locator(".dashboard-runtime-artboard .dashboard-value strong").first().waitFor();
      await page.waitForTimeout(1200);
      entry.author = await inspect(page);
      await page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-author.png`) });
      await page.locator("button.dashboard-runtime-back").click();
      const publishing = page.waitForResponse(response => response.url().endsWith(`${appPath}/publish`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "发布", exact: true }).click(); assert.equal((await publishing).status(), 201);
      const anonymous = await themeContext(gate, theme, width), publicPage = await anonymous.newPage();
      observeDiagnostics(publicPage, entry);
      await publicPage.goto(`${gate.origin}/apps/${application.metadata.id}`);
      await publicPage.locator(".dashboard-runtime-artboard .dashboard-value strong").first().waitFor();
      await publicPage.waitForTimeout(1200);
      entry.public = await inspect(publicPage);
      await publicPage.screenshot({ path: resolve(gate.output, `r${round}-${theme}-public.png`) });
      if (process.argv.includes("--assert-parity")) {
        for (const key of ["kpi", "label", "title"]) {
          assert.ok(entry.author[key] && entry.public[key], `${key} exists in both surfaces`);
          assert.equal(entry.author[key].font, entry.public[key].font, `${key} design font must match across surfaces`);
          for (const surface of [entry.author, entry.public]) {
            const transformed = surface[key].ancestry.filter(node => node.transform !== "none");
            assert.equal(transformed.length, 1, "only the artboard scales authored content");
            assert.match(transformed[0].class, /dashboard-runtime-artboard/);
          }
        }
        assert.equal(entry.author.kpi.font, "27px", "KPI retains its designed hierarchy instead of the 12px shell floor");
      }
      assert.equal(entry.errors.length, 0, entry.errors.join("\n"));
      await anonymous.close(); entry.passed = true;
      console.log(JSON.stringify({ round, theme, author: entry.author.kpi.font, public: entry.public.kpi.font }));
    } catch (error) { entry.failure = error.stack ?? String(error); console.error(entry.failure); }
    finally { await context.close(); }
  }
} finally {
  await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2));
  await gate.close();
}
assert.ok(report.cases.length === 4 && report.cases.every(entry => entry.passed));
