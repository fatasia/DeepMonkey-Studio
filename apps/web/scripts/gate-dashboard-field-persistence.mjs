import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";

const rows = [{ region: "装配线", amount: 24 }, { region: "测试线", amount: 38 }];
const source = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(rows)); });
await new Promise((ready) => source.listen(0, "127.0.0.1", ready));
const gate = await createIsolatedStudioGate("field-persistence");
const report = { createdAt: new Date().toISOString(), passed: false, steps: [], errors: [] };
let page;
try {
  const { json, browser, origin, output } = gate;
  const project = await json("POST", "/api/projects", { name: "字段绑定生产验收" });
  const path = `/api/projects/${project.id}`;
  const connection = await json("POST", `${path}/data-connections`, { name: "本地生产记录", type: "http", enabled: true, config: { url: `http://127.0.0.1:${source.address().port}` } });
  const dataset = await json("POST", `${path}/datasets`, { name: "生产记录", connectionId: connection.id, refreshSeconds: 0,
    fields: [{ key: "region", label: "产线", type: "string" }, { key: "amount", label: "产量", type: "number", unit: "件" }],
    computedFields: [{ id: "double", key: "double", label: "双倍产量", type: "number", formula: "amount * 2" }] });
  const preview = await json("GET", `${path}/datasets/${dataset.id}/preview`);
  assert.equal(preview.rows[0].double, 48);
  const now = new Date().toISOString();
  const application = await json("POST", `${path}/applications`, {
    schemaVersion: 2, metadata: { id: randomUUID(), projectId: project.id, name: "字段持久化验收", revision: 1, createdAt: now, updatedAt: now },
    pages: [{ id: "overview", name: "产线总览", width: 1280, height: 720, viewportFit: "contain", nodes: [
      { id: "chart", name: "产线产量", kind: "data-widget", zIndex: 1, frame: { x: 40, y: 40, width: 800, height: 480 }, widget: { type: "bar", title: "产线产量", key: "", unit: "件" } },
    ] }], topologies: [], scenes: [], geo: { providerIds: [], layers: [] }, data: { connectionIds: [connection.id], datasetIds: [dataset.id], transforms: [], variables: [] },
    interactions: [], scripts: [], assets: [], timelines: [], publicationProfiles: [{ id: "browser", name: "浏览器发布", target: "browser-preview", entryPageId: "overview", renderer: "auto" }],
  });
  const appPath = `${path}/applications/${application.metadata.id}`;
  const url = `${origin}/studio/${project.id}/applications/${application.metadata.id}/pages/overview`;
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (message) => { if (["error", "warning"].includes(message.type())) report.errors.push(message.text()); });
  await gate.loginPage(page);
  await page.goto(url);
  const selectChart = async () => {
    await page.locator(".dashboard-node").first().click();
    await page.locator(".dashboard-inspector-tabs").getByRole("button", { name: "数据", exact: true }).click();
  };
  await selectChart();
  await page.getByRole("button", { name: "选字段", exact: true }).click();
  const panel = page.locator(".dashboard-field-panel");
  await panel.getByRole("button", { name: /生产记录/ }).click();
  const drag = async (name, role) => panel.locator(".dashboard-field-row").filter({ has: page.locator("strong", { hasText: new RegExp(`^${name}$`) }) }).dragTo(page.locator(`[data-field-role="${role}"]`));
  await drag("产量", "measure"); await drag("产线", "dimension");
  const save = async () => {
    const response = page.waitForResponse((result) => result.url().endsWith(appPath) && result.request().method() === "PUT");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    assert.equal((await response).status(), 200);
  };
  await save();
  const saved = await json("GET", appPath);
  assert.deepEqual(saved.pages[0].nodes[0].widget.analysis, { aggregation: "none", measureField: "amount", dimensionField: "region" });
  assert.equal(saved.pages[0].nodes[0].widget.key, `${dataset.id}.amount`);
  report.steps.push("real-http-data-and-computed-field", "drag-bind-and-save");
  await page.reload(); await selectChart();
  assert.match(await page.locator('[data-field-role="measure"]').innerText(), /产量/);
  assert.match(await page.locator('[data-field-role="dimension"]').innerText(), /产线/);
  await page.screenshot({ path: resolve(output, "saved-reloaded.png") });
  report.steps.push("refresh-restores-bindings");
  const published = page.waitForResponse((response) => response.url().endsWith(`${appPath}/publish`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "发布", exact: true }).click();
  assert.equal((await published).status(), 201);
  const publicResponse = await fetch(`${gate.apiOrigin}/api/public/applications/${application.metadata.id}`);
  assert.equal(publicResponse.status, 200);
  const publication = await publicResponse.json();
  assert.equal(publication.document.pages[0].nodes[0].widget.analysis.measureField, "amount");
  report.steps.push("publish-and-anonymous-read");
  await panel.getByRole("button", { name: /生产记录/ }).click();
  await drag("双倍产量", "measure"); await save();
  assert.equal((await json("GET", appPath)).pages[0].nodes[0].widget.analysis.measureField, "double");
  const unchanged = await (await fetch(`${gate.apiOrigin}/api/public/applications/${application.metadata.id}`)).json();
  assert.equal(unchanged.id, publication.id);
  assert.equal(unchanged.document.pages[0].nodes[0].widget.analysis.measureField, "amount");
  report.steps.push("saved-draft-does-not-overwrite-publication");
  await panel.getByRole("button", { name: "收起字段面板", exact: true }).click();
  await page.getByRole("button", { name: "浏览", exact: true }).click();
  await page.locator(".dashboard-runtime-preview").waitFor();
  await page.screenshot({ path: resolve(output, "runtime-real-data.png") });
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack ?? String(error);
  await page?.screenshot({ path: resolve(gate.output, "failed.png") });
} finally {
  await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2));
  await gate.close(); await new Promise((done) => source.close(done));
}
console.log(JSON.stringify({ ...report, output: gate.output }, null, 2));
assert.ok(report.passed, report.failure);
