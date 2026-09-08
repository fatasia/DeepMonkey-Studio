import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createScene, observeDiagnostics, themeContext } from "./gateModelInstancesSupport.mjs";

const gate = await createIsolatedStudioGate("logistics-pack");
const report = { cases: [] };
console.log(JSON.stringify({ output: gate.output }));
const workflow = [
  ["核对可用库存", "库存可用性", "450", "货位"],
  ["跟踪拣选波次", "波次拣选", "350", "订单"],
  ["查看装车进度", "装车发运", "29", "运单"],
  ["处理履约异常", "异常闭环", "2", "异常号"],
  ["返回履约总览", "履约总览", "12", "入库托盘"],
];
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const entry = { round, theme, width, passed: false, errors: [], driverWarnings: [], expectedNetworkErrors: [] };
    report.cases.push(entry);
    const context = await themeContext(gate, theme, width), page = await context.newPage();
    page.setDefaultTimeout(30000); observeDiagnostics(page, entry);
    const shot = name => page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${name}.png`) });
    try {
      const project = await gate.json("POST", "/api/projects", { name: `仓储包-${round}-${theme}` });
      const { application, appPath } = await createScene(gate, page, project.id);
      const authored = structuredClone(application); authored.pages[0].nodes = [];
      await gate.json("PUT", appPath, authored);
      const route = `${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${application.pages[0].id}`;
      await page.goto(route);
      await page.locator(".dashboard-left-tabs").getByRole("button", { name: "资源", exact: true }).click();
      await page.getByRole("button", { name: "模板", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "看板模板库", exact: true });
      await modal.getByLabel("模板分类").selectOption("packs");
      const card = modal.locator("article.dashboard-template-pack").filter({ hasText: "仓储履约运行包" });
      await card.waitFor();
      for (const label of ["履约总览", "库存可用性", "波次拣选", "装车发运", "异常闭环"]) {
        await card.getByRole("button", { name: label, exact: true }).click();
        assert.equal(await card.locator("[data-template-node]").count(), 10);
      }
      await shot("catalog");
      await card.getByRole("button", { name: "导入整包（5 页）", exact: true }).click();
      await modal.waitFor({ state: "detached" });
      const tabs = page.locator(".dashboard-page-tab");
      assert.equal(await tabs.count(), authored.pages.length + 5);
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      assert.equal(await tabs.count(), authored.pages.length);
      await page.getByRole("button", { name: "重做", exact: true }).click();
      await tabs.filter({ hasText: "履约总览" }).click();
      await page.locator(".dashboard-artboard .dashboard-node").nth(2).click();
      await page.locator(".dashboard-inspector-tabs").getByRole("button", { name: "数据", exact: true }).click();
      const editor = page.locator(".dashboard-sample-editor");
      const incoming = editor.getByRole("textbox", { name: "1 · 入库托盘", exact: true });
      await incoming.fill("invalid");
      await editor.getByRole("button", { name: "应用", exact: true }).click();
      await editor.getByRole("alert").waitFor();
      await incoming.fill("20");
      await editor.getByRole("button", { name: "应用", exact: true }).click();
      const saving = page.waitForResponse(response => response.url().endsWith(appPath) && response.request().method() === "PUT");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      assert.equal((await saving).status(), 200);
      const saved = await gate.json("GET", appPath);
      const pages = saved.pages.filter(item => item.templateSource?.packId === "warehouse-fulfillment");
      assert.equal(pages.length, 5);
      assert.equal(saved.interactions.length - authored.interactions.length, 5);
      for (const item of pages) { assert.equal(item.nodes.length, 10); assert.equal(item.templateSource.revision, 1); }
      assert.equal(pages[0].nodes[2].widget.sampleData.rows[0]["入库托盘"], 20);
      await page.reload();
      await page.locator(".dashboard-artboard .dashboard-node").nth(2).waitFor();
      await page.getByRole("button", { name: "浏览", exact: true }).click();
      const runtime = page.locator(".dashboard-runtime-preview");
      await runtime.locator(".dashboard-value strong").filter({ hasText: /^42\s*托$/ }).waitFor();
      await runtime.locator(".dashboard-runtime-artboard select").first().selectOption("B");
      for (const [action, next, expected, column] of workflow) {
        await runtime.getByRole("button", { name: action, exact: true }).click();
        await runtime.locator(".dashboard-decoration-widget").filter({ hasText: next }).waitFor();
        assert.equal(await runtime.locator(".dashboard-runtime-artboard select").first().inputValue(), "B");
        assert.match(await runtime.locator(".dashboard-value strong").first().innerText(), new RegExp(`^${expected}(?:\\s|[^0-9])`));
        const [csv] = await Promise.all([page.waitForEvent("download"), runtime.getByRole("button", { name: "CSV", exact: true }).click()]);
        const path = resolve(gate.output, `r${round}-${theme}-${next}.csv`); await csv.saveAs(path);
        const contents = await readFile(path, "utf8");
        assert.ok(contents.includes(column)); assert.ok(contents.includes("B"));
        await page.waitForTimeout(1200);
        await shot(next);
      }
      await page.getByRole("button", { name: "返回编辑", exact: true }).click();
      const publishing = page.waitForResponse(response => response.url().endsWith(`${appPath}/publish`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "发布", exact: true }).click(); assert.equal((await publishing).status(), 201);
      const anonymous = await themeContext(gate, theme, width);
      try {
        const publicPage = await anonymous.newPage(); observeDiagnostics(publicPage, entry);
        await publicPage.goto(`${gate.origin}/apps/${application.metadata.id}`);
        await publicPage.locator(".dashboard-value strong").filter({ hasText: /^42\s*托$/ }).waitFor();
        await publicPage.reload();
        await publicPage.locator(".dashboard-value strong").filter({ hasText: /^42\s*托$/ }).waitFor();
        await publicPage.locator(".dashboard-runtime-artboard select").first().selectOption("C");
        await publicPage.getByRole("button", { name: "核对可用库存", exact: true }).click();
        await publicPage.locator(".dashboard-value strong").filter({ hasText: /^680\s*件$/ }).waitFor();
        assert.equal(await publicPage.locator(".dashboard-report-table tbody tr").count(), 2);
        await publicPage.waitForTimeout(1200);
        await publicPage.screenshot({ path: resolve(gate.output, `r${round}-${theme}-public.png`) });
      } finally { await anonymous.close(); }
      assert.deepEqual(entry.errors, []);
      entry.passed = true;
    } catch (error) { entry.failure = error.stack; await shot("failed"); throw error; }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
