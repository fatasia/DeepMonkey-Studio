import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createScene, observeDiagnostics, themeContext } from "./gateModelInstancesSupport.mjs";

const gate = await createIsolatedStudioGate("dashboard-samples");
const report = { cases: [] }; console.log(JSON.stringify({ output: gate.output }));
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const entry = { round, theme, width, errors: [], driverWarnings: [], expectedNetworkErrors: [], passed: false }; report.cases.push(entry);
    const context = await themeContext(gate, theme, width), page = await context.newPage();
    page.setDefaultTimeout(25000); observeDiagnostics(page, entry);
    const shot = name => page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${name}.png`) });
    try {
      const project = await gate.json("POST", "/api/projects", { name: `生产示例-${round}-${theme}` });
      const { application, appPath } = await createScene(gate, page, project.id);
      const authored = structuredClone(application); authored.pages[0].nodes = [];
      await gate.json("PUT", appPath, authored);
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${application.pages[0].id}`);
      await page.locator(".dashboard-left-tabs").getByRole("button", { name: "资源", exact: true }).click();
      await page.getByRole("button", { name: "模板", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "看板模板库", exact: true });
      await modal.getByRole("textbox", { name: "搜索模板或行业" }).fill("生产运行监控");
      await modal.locator("article").filter({ has: page.locator("strong", { hasText: "生产运行监控 · 经营总览" }) }).getByRole("button", { name: "插入当前页面", exact: true }).click();
      await modal.waitFor({ state: "detached" });
      await page.locator(".dashboard-artboard .dashboard-node").nth(2).click();
      await page.locator(".dashboard-inspector-tabs").getByRole("button", { name: "数据", exact: true }).click();
      const editor = page.getByRole("region", { name: "示例数据编辑" });
      await editor.waitFor(); const cell = editor.getByRole("textbox", { name: "1 · 产量", exact: true });
      await cell.fill("not-number"); await editor.getByRole("button", { name: "应用", exact: true }).click();
      await editor.getByRole("alert").getByText(/请输入有效数字/).waitFor(); await shot("invalid");
      await cell.focus(); await page.keyboard.press("Escape"); assert.equal(await cell.inputValue(), "1080");
      await cell.fill("1500"); await editor.getByRole("button", { name: "应用", exact: true }).click();
      await editor.getByRole("status").waitFor(); await shot("edited");
      await editor.getByRole("button", { name: "添加行", exact: true }).click();
      assert.equal(await editor.locator("tbody tr").count(), 4);
      await editor.getByRole("button", { name: "取消", exact: true }).click();
      assert.equal(await editor.locator("tbody tr").count(), 3);
      for (const narrow of [800, 480]) {
        await page.setViewportSize({ width: narrow, height: 1000 }); await shot(`narrow-${narrow}`);
        if (await editor.isVisible()) assert.equal(await editor.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
      }
      await page.setViewportSize({ width, height: 1000 });
      const saving = page.waitForResponse(response => response.url().endsWith(appPath) && response.request().method() === "PUT");
      await page.getByRole("button", { name: "保存", exact: true }).click(); assert.equal((await saving).status(), 200);
      const saved = await gate.json("GET", appPath);
      const samples = saved.pages[0].nodes.filter(node => node.widget?.sampleData);
      assert.equal(samples.length, 7); assert.ok(samples.every(node => node.widget.sampleData.rows[0]["产量"] === 1500));
      assert.deepEqual(saved.scenes, authored.scenes);
      await page.reload(); await page.locator(".dashboard-artboard .dashboard-node").first().waitFor();
      await page.getByRole("button", { name: "浏览", exact: true }).click();
      const runtime = page.locator(".dashboard-runtime-preview"); await runtime.waitFor();
      await runtime.locator(".dashboard-value strong").filter({ hasText: /^3020/ }).waitFor(); await shot("runtime");
      const filter = runtime.locator(".dashboard-runtime-artboard select"); await filter.selectOption("B");
      await runtime.locator(".dashboard-value strong").filter({ hasText: /^920/ }).waitFor();
      assert.equal(await runtime.locator(".dashboard-report-table tbody tr").count(), 1);
      await shot("filtered"); await filter.selectOption("全部");
      const [download] = await Promise.all([page.waitForEvent("download"), runtime.getByTitle("导出 CSV", { exact: true }).click()]);
      await download.saveAs(resolve(gate.output, `r${round}-${theme}.csv`));
      await page.getByRole("button", { name: "返回编辑", exact: true }).click();
      const publishing = page.waitForResponse(response => response.url().endsWith(`${appPath}/publish`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "发布", exact: true }).click(); assert.equal((await publishing).status(), 201);
      const anonymous = await gate.browser.newContext({ viewport: { width, height: 1000 } });
      const publicPage = await anonymous.newPage(); observeDiagnostics(publicPage, entry);
      await publicPage.goto(`${gate.origin}/apps/${application.metadata.id}`);
      await publicPage.locator(".dashboard-value strong").filter({ hasText: /^3020/ }).waitFor();
      await publicPage.reload(); await publicPage.locator(".dashboard-value strong").filter({ hasText: /^3020/ }).waitFor();
      // 数据先到达 DOM，ECharts 入场动画随后结束；截图不能截在零高度首帧。
      await publicPage.waitForTimeout(1500);
      await publicPage.screenshot({ path: resolve(gate.output, `r${round}-${theme}-public.png`) });
      await anonymous.close(); assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack; await shot("failed"); throw error; }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
