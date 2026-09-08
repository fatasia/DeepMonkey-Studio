import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createScene, observeDiagnostics, themeContext } from "./gateModelInstancesSupport.mjs";

const gate = await createIsolatedStudioGate("dashboard-readability");
const report = { cases: [] }; console.log(JSON.stringify({ output: gate.output }));
const steps = [["查看产线设备", "设备健康"], ["追踪告警来源", "告警处置"], ["关联质量损失", "质量分析"], ["安排维护工单", "维护计划"], ["回到全局视角", "生产总览"]];
async function buttonContrast(button) {
  return button.evaluate(element => {
    const style = getComputedStyle(element);
    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const foreground = luminance(style.color), background = luminance(style.backgroundColor);
    return { color: style.color, background: style.backgroundColor, ratio: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) };
  });
}
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const entry = { round, theme, width, passed: false, errors: [], driverWarnings: [], expectedNetworkErrors: [], pages: [] };
    report.cases.push(entry);
    const context = await themeContext(gate, theme, width), page = await context.newPage();
    page.setDefaultTimeout(25000); observeDiagnostics(page, entry);
    try {
      const project = await gate.json("POST", "/api/projects", { name: `Readability ${round} ${theme}` });
      const { application, appPath } = await createScene(gate, page, project.id);
      const pageUrl = `${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${application.pages[0].id}`;
      await page.goto(pageUrl);
      await page.locator(".dashboard-left-tabs").getByRole("button", { name: "资源", exact: true }).click();
      await page.getByRole("button", { name: "模板", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "看板模板库", exact: true });
      await modal.getByLabel("模板分类").selectOption({ label: "行业深度包" });
      await modal.locator("article.dashboard-template-pack").filter({ hasText: "制造设备运行包" }).getByRole("button", { name: /导入整包（5 页）/ }).click();
      const saving = page.waitForResponse(response => response.url().endsWith(appPath) && response.request().method() === "PUT");
      await page.getByRole("button", { name: "保存", exact: true }).click(); assert.ok((await saving).ok());
      const saved = await gate.json("GET", appPath), original = application.pages[0];
      assert.deepEqual(saved.pages.find(item => item.id === original.id), original, "Import must not rewrite original page parameters");
      const packPages = saved.pages.filter(item => item.templateSource?.packId === "manufacturing-asset-ops");
      assert.equal(packPages.length, 5);
      for (const item of packPages) assert.ok(item.nodes.filter(node => node.kind === "data-widget").every(node => node.widget.type === "text" || node.widget.fontSize >= 24));
      await page.reload(); await page.getByRole("button", { name: "浏览", exact: true }).click();
      const runtime = page.locator(".dashboard-runtime-preview"); await runtime.waitFor();
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      const back = runtime.getByRole("button", { name: "返回编辑", exact: true });
      entry.backContrast = await buttonContrast(back);
      assert.ok(entry.backContrast.ratio >= 4.5, "Back to editor must remain readable in light theme");
      await back.hover(); entry.backHoverContrast = await buttonContrast(back);
      assert.ok(entry.backHoverContrast.ratio >= 4.5);
      await page.mouse.move(width / 2, 10);
      assert.equal(await runtime.locator(".dashboard-runtime-parameters").count(), 0, "Parameter panel must not cover first-view KPI");
      const controls = runtime.getByRole("button", { name: "项目控制", exact: true });
      await controls.click();
      const parameters = runtime.getByRole("button", { name: "参数", exact: true });
      await parameters.focus(); await page.keyboard.press("Enter");
      await runtime.getByRole("complementary", { name: "参数查询", exact: true }).waitFor();
      assert.equal(await parameters.getAttribute("aria-expanded"), "true");
      await runtime.getByRole("button", { name: "收起参数", exact: true }).click(); await controls.click();
      await page.waitForTimeout(1200);
      await page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-overview-all.png`) });
      await runtime.locator(".dashboard-runtime-artboard select").first().selectOption("B");
      for (const [action, title] of steps) {
        await runtime.getByRole("button", { name: action, exact: true }).click();
        await runtime.locator(".dashboard-decoration-widget").filter({ hasText: title }).waitFor();
        await page.waitForTimeout(1200);
        const layout = await runtime.locator(".dashboard-runtime-artboard").evaluate(artboard => {
          const scale = artboard.getBoundingClientRect().width / artboard.offsetWidth;
          const measure = selector => [...artboard.querySelectorAll(selector)].map(element => ({ text: element.textContent, font: Number.parseFloat(getComputedStyle(element).fontSize), screenFont: Number.parseFloat(getComputedStyle(element).fontSize) * scale }));
          return { scale, headings: measure(".dashboard-chart-heading strong"), units: measure(".dashboard-chart-heading > span"), labels: measure(".dashboard-value > span"), columns: measure(".dashboard-report-table th"), body: measure(".dashboard-report-table td"), charts: artboard.querySelectorAll(".dashboard-chart canvas").length };
        });
        assert.equal(layout.headings.length, 2); assert.equal(layout.charts, 2);
        assert.ok(layout.headings.every(item => item.text.trim() && item.screenFont >= 10));
        assert.ok([...layout.labels, ...layout.columns, ...layout.body].every(item => item.font >= 24 && item.screenFont >= 10), "Design font and scaled screen readability must both pass");
        assert.ok(layout.units.length >= 1 && layout.units.every(item => item.text.trim()));
        assert.equal(await runtime.locator(".dashboard-runtime-artboard select").first().inputValue(), "B");
        assert.equal(await runtime.locator(".dashboard-runtime-parameters").count(), 0);
        entry.pages.push({ title, ...layout });
        await page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${title}.png`) });
      }
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack; await page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-failed.png`) }); throw error; }
    finally { await context.close(); console.log(JSON.stringify({ ...entry, pages: entry.pages.map(({ title, scale }) => ({ title, scale })) })); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, passed: report.cases.every(entry => entry.passed) }));
