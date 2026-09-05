import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";

const rows = [{ region: "华东", factory: "一厂", amount: 10, valid: true }, { region: "华东", factory: "二厂", amount: 30, valid: false }, { region: "华西", factory: "一厂", amount: 20, valid: true }];
const source = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(rows)); });
await new Promise(done => source.listen(0, "127.0.0.1", done));
const gate = await createIsolatedStudioGate("semantic-consumers");
const report = { createdAt: new Date().toISOString(), cases: [] };
const node = (id, type, x, y, width, height) => ({ id, name: id, kind: "data-widget", zIndex: 1, frame: { x, y, width, height }, widget: { type, key: id, title: id, unit: "", backgroundColor: "#11191d", textColor: "#eef2f4" } });
try {
  for (const theme of ["dark", "light"]) for (const width of [1440, 980]) {
    const entry = { theme, width, passed: false, errors: [], expectedHttpErrors: [] }; report.cases.push(entry);
    const project = await gate.json("POST", "/api/projects", { name: `语义消费-${theme}-${width}` });
    const path = `/api/projects/${project.id}`;
    const connection = await gate.json("POST", `${path}/data-connections`, { name: "生产样本", type: "http", enabled: true, config: { url: `http://127.0.0.1:${source.address().port}` } });
    const fields = [{ key: "region", label: "区域", type: "string" }, { key: "factory", label: "工厂", type: "string" }, { key: "amount", label: "产量", type: "number" }, { key: "valid", label: "有效", type: "boolean" }];
    const dataset = await gate.json("POST", `${path}/datasets`, { name: "生产记录", connectionId: connection.id, fields, refreshSeconds: 0 });
    const model = await gate.json("POST", `${path}/semantic-models`, {
      name: "合格生产口径", source: { kind: "dataset", id: dataset.id },
      metrics: [{ id: "sum", key: "qualified", label: "合格产量", fieldKey: "amount", aggregation: "sum", unit: "件", defaultFilters: [{ fieldKey: "valid", op: "eq", value: true }] }],
      dimensions: [{ id: "region", key: "region", label: "区域到工厂", fieldKey: "region", hierarchy: [{ fieldKey: "region", label: "区域" }, { fieldKey: "factory", label: "工厂" }] }, { id: "factory", key: "factory", label: "工厂", fieldKey: "factory" }],
      parameters: [{ id: "parent", key: "region", label: "区域参数", type: "option", optionsSource: { kind: "dimension", dimensionKey: "region" } }, { id: "child", key: "factory", label: "工厂参数", type: "option", parentKey: "region", optionsSource: { kind: "dimension", dimensionKey: "factory" } }],
    });
    const now = new Date().toISOString();
    const app = await gate.json("POST", `${path}/applications`, {
      schemaVersion: 2, metadata: { id: randomUUID(), projectId: project.id, name: "语义指标真实消费", revision: 1, createdAt: now, updatedAt: now },
      pages: [{ id: "overview", name: "生产", width: 1000, height: 650, viewportFit: "contain", nodes: [node("分区产量", "bar", 30, 170, 600, 410), node("合格总产量", "value", 670, 170, 300, 140), node("区域选择", "filter", 30, 40, 420, 100), node("工厂选择", "filter", 510, 40, 420, 100)] }],
      scenes: [], topologies: [], geo: { providerIds: [], layers: [] }, data: { connectionIds: [connection.id], datasetIds: [dataset.id], transforms: [], variables: [] }, interactions: [], scripts: [], assets: [], timelines: [], publicationProfiles: [{ id: "browser", name: "浏览器", target: "browser-preview", entryPageId: "overview", renderer: "auto" }],
    });
    const appPath = `${path}/applications/${app.metadata.id}`;
    const context = await gate.browser.newContext({ viewport: { width, height: 1000 } });
    await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } }); });
    const page = await context.newPage(); page.setDefaultTimeout(16000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => { if (["warning", "error"].includes(message.type())) { if (/status of 503/.test(message.text())) entry.expectedHttpErrors.push(message.text()); else entry.errors.push(message.text()); } });
    const shot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`), fullPage: true });
    const select = async index => {
      await page.locator(".dashboard-layer-row").nth(index).locator(".dashboard-layer-select").click();
      await page.locator(".dashboard-inspector-tabs").getByRole("button", { name: "数据", exact: true }).click();
    };
    const save = async () => {
      const response = page.waitForResponse(result => result.url().endsWith(appPath) && result.request().method() === "PUT");
      await page.getByRole("button", { name: "保存", exact: true }).click(); assert.equal((await response).status(), 200);
    };
    const kpi = () => page.locator(".dashboard-runtime-artboard .dashboard-value strong");
    const expectValue = value => kpi().filter({ hasText: new RegExp(`^${value}`) }).waitFor();
    try {
      await gate.loginPage(page); await page.goto(`${gate.origin}/studio/${project.id}/applications/${app.metadata.id}/pages/overview`);
      for (let index = 0; index < 4; index++) {
        await select(index); await page.getByLabel("语义模型", { exact: true }).selectOption(model.id);
        if (index === 3) await page.getByLabel("语义参数", { exact: true }).selectOption("factory");
      }
      await save(); await page.reload(); await select(0);
      assert.equal(await page.getByLabel("语义模型", { exact: true }).inputValue(), model.id);
      assert.equal(await page.getByLabel("语义维度", { exact: true }).inputValue(), "region");
      entry.geometry = await page.locator(".dashboard-semantic-binding").evaluate(element => {
        const checkbox = element.querySelector('input[type="checkbox"]')?.getBoundingClientRect();
        return { overflow: element.scrollWidth > element.clientWidth + 1, bodyOverflow: document.documentElement.scrollWidth > innerWidth + 1, checkboxWidth: checkbox?.width, checkboxHeight: checkbox?.height };
      });
      assert.equal(entry.geometry.overflow || entry.geometry.bodyOverflow, false);
      assert.equal(entry.geometry.checkboxWidth, 16); assert.equal(entry.geometry.checkboxHeight, 16);
      entry.contrast = await page.locator("body").evaluate(collectTextContrast, ".dashboard-semantic-binding label > span, .dashboard-semantic-binding select, .dashboard-semantic-binding small");
      assert.deepEqual(entry.contrast.filter(item => item.contrast < 4.5), []);
      await shot("saved-binding");
      const saved = await gate.json("GET", appPath);
      assert.ok(saved.pages[0].nodes.every(item => item.widget.semanticBinding.revision === model.revision));
      const publish = page.waitForResponse(response => response.url().endsWith(`${appPath}/publish`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "发布", exact: true }).click(); assert.equal((await publish).status(), 201);
      const published = await (await fetch(`${gate.apiOrigin}/api/public/applications/${app.metadata.id}`)).json();
      assert.equal(published.document.pages[0].nodes[0].widget.semanticBinding.revision, 1);
      const runtimeBaseline = await gate.json("GET", appPath);
      await page.getByRole("button", { name: "浏览", exact: true }).click(); await expectValue(30);
      const queryPanel = page.getByRole("complementary", { name: "参数查询", exact: true });
      await queryPanel.locator("select").nth(0).selectOption("华西");
      await queryPanel.locator("select").nth(1).selectOption("一厂");
      await expectValue(30); // 参数查询草稿不能提前修改已应用条件。
      await queryPanel.getByRole("button", { name: "查询", exact: true }).click(); await expectValue(20);
      await queryPanel.locator("select").nth(0).selectOption("华东");
      assert.equal(await queryPanel.locator("select").nth(1).inputValue(), "全部");
      assert.deepEqual(await queryPanel.locator("select").nth(1).locator("option").allTextContents(), ["全部", "一厂", "二厂"]);
      await queryPanel.getByRole("button", { name: "重置", exact: true }).click(); await expectValue(30);
      await page.waitForTimeout(1100); // 重置后的柱高恢复完成再留证，避免把过渡帧当最终画面。
      await shot("query-parameters");
      await queryPanel.getByRole("button", { name: "收起参数", exact: true }).click();
      const runtime = page.locator(".dashboard-runtime-artboard");
      const parent = runtime.locator(".dashboard-filter-widget").nth(0).locator("select"), child = runtime.locator(".dashboard-filter-widget").nth(1).locator("select");
      assert.equal(await child.isDisabled(), true);
      await parent.selectOption("华西"); await expectValue(20);
      await child.locator("option", { hasText: "一厂" }).waitFor({ state: "attached" });
      assert.deepEqual(await child.locator("option").allTextContents(), ["全部", "一厂"]);
      await child.focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
      await expectValue(20);
      await parent.selectOption("华东"); await expectValue(10);
      assert.equal(await child.inputValue(), "全部");
      await parent.selectOption("全部"); await expectValue(30);
      const canvas = runtime.locator(".dashboard-chart canvas"); await canvas.waitFor();
      await page.waitForTimeout(650);
      const bounds = await canvas.boundingBox(); assert.ok(bounds);
      await page.mouse.click(bounds.x + 36 * bounds.width / 600 + (bounds.width - 44 * bounds.width / 600) / 4, bounds.y + bounds.height * .82);
      await expectValue(10);
      await runtime.locator(".dashboard-drill-chart nav button", { hasText: "华东" }).waitFor();
      await page.waitForTimeout(1100); // 等图表的可见过渡完成，截图不是动画中途。
      await shot("linked-drill");
      await runtime.locator(".dashboard-drill-chart nav button", { hasText: /^region$/ }).click(); await expectValue(30);
      assert.deepEqual(await gate.json("GET", appPath), runtimeBaseline, "预览过滤与钻取不能写入作者草稿");
      await page.getByRole("button", { name: "返回编辑", exact: true }).first().click();
      const previewRoute = `**${path}/datasets/${dataset.id}/preview`;
      await page.route(previewRoute, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "隔离故障注入" }) }));
      await page.reload(); await page.locator(".dashboard-node [role=alert]").filter({ hasText: "数据源运行失败" }).first().waitFor(); await shot("source-failure");
      await page.unroute(previewRoute); await page.reload(); await select(0);
      assert.equal(await page.locator(".dashboard-node [role=alert]").count(), 0);
      await gate.json("PUT", `${path}/semantic-models/${model.id}`, { ...model, name: "合格生产口径 v2" });
      await page.reload(); await select(0);
      await page.locator(".dashboard-semantic-binding [role=alert]").filter({ hasText: "重新确认" }).waitFor();
      await shot("revision-stale");
      await page.getByRole("button", { name: "确认使用新口径", exact: true }).click(); await save();
      assert.equal((await gate.json("GET", appPath)).pages[0].nodes[0].widget.semanticBinding.revision, 2);
      assert.equal((await (await fetch(`${gate.apiOrigin}/api/public/applications/${app.metadata.id}`)).json()).document.pages[0].nodes[0].widget.semanticBinding.revision, 1);
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack ?? String(error); await shot("failed"); }
    finally { await context.close(); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); await new Promise(done => source.close(done)); }
console.log(JSON.stringify({ ...report, output: gate.output }, null, 2));
assert.ok(report.cases.length === 4 && report.cases.every(entry => entry.passed), "Semantic consumer gate failed");
