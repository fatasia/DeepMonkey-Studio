import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createIsolatedPostgres } from "../../api/scripts/isolatedPostgresFixture.mjs";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { themeContext } from "./gateModelInstancesSupport.mjs";

const pg = await createIsolatedPostgres();
const before = process.env.BIM_WRITEBACK_PG_PASSWORD;
let gate;
try { process.env.BIM_WRITEBACK_PG_PASSWORD = ""; gate = await createIsolatedStudioGate("postgres-writeback-ui"); }
finally { if (before === undefined) delete process.env.BIM_WRITEBACK_PG_PASSWORD; else process.env.BIM_WRITEBACK_PG_PASSWORD = before; }
const report = { pgEvidence: pg.output, webIndexSha: createHash("sha256").update(await readFile(resolve(import.meta.dirname, "../dist/index.html"))).digest("hex"), cases: [] };
console.log(JSON.stringify({ output: gate.output }));
const record = async id => (await pg.client.query("SELECT output,revision FROM records WHERE id=$1", [id])).rows[0];
try {
  await pg.client.query("CREATE TABLE records (id text PRIMARY KEY, revision bigint NOT NULL DEFAULT 1, output integer NOT NULL CHECK(output BETWEEN 0 AND 90))");
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const id = `r${round}-${theme}`, entry = { id, passed: false, errors: [], expectedNetworkErrors: [] }; report.cases.push(entry);
    await pg.client.query("INSERT INTO records(id,output) VALUES($1,7)", [id]);
    const project = await gate.json("POST", "/api/projects", { name: `SQL 填报 ${id}` });
    const connection = await gate.json("POST", `/api/projects/${project.id}/data-connections`, { name: `PostgreSQL ${id}`, type: "postgresql", enabled: true, config: { host: "127.0.0.1", port: pg.proxyPort, database: "postgres", user: "writeback_test", passwordEnv: "BIM_WRITEBACK_PG_PASSWORD" } });
    const context = await themeContext(gate, theme, width), page = await context.newPage(); page.setDefaultTimeout(15000);
    let expectedStatus, metadataWrites = 0;
    page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/datasets")) metadataWrites++; });
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["warning", "error"].includes(message.type())) return;
      if (expectedStatus && (message.location().url.includes("/records/") || (expectedStatus === 503 && message.location().url.endsWith("/preview"))) && message.text().includes(String(expectedStatus))) entry.expectedNetworkErrors.push(message.text());
      else entry.errors.push(message.text());
    });
    try {
      await gate.loginPage(page); await page.goto(`${gate.origin}/manager?project=${project.id}`);
      await page.getByRole("button", { name: "数据中心", exact: true }).click(); await page.locator(".data-center-page").waitFor();
      const datasetPane = page.locator(".data-center-pane").nth(1); await datasetPane.getByRole("button", { name: "新建", exact: true }).click();
      const form = datasetPane.locator(".data-inline-form");
      await form.getByLabel("名称", { exact: true }).fill(`产量填报 ${id}`);
      await form.locator("label").filter({ hasText: /^SQL/ }).locator("textarea").fill(`SELECT id,output FROM records WHERE id='${id}'`);
      await form.getByLabel("更新策略").selectOption("manual");
      await form.getByLabel("启用填报", { exact: true }).check();
      await form.getByLabel("填报数据表", { exact: true }).fill("records");
      await form.getByLabel("填报字段 1", { exact: true }).fill("output");
      await form.getByLabel("字段类型 1", { exact: true }).selectOption("number");
      await form.getByText("校验规则", { exact: true }).click();
      await form.getByLabel("必填", { exact: true }).check();
      await form.getByLabel("字段 1 最小值", { exact: true }).fill("0");
      await form.getByLabel("字段 1 最大值", { exact: true }).fill("100");
      await form.locator(".dataset-writeback-config").scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(gate.output, `${id}-configuration.png`), fullPage: true });
      const savedResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/datasets"));
      await form.getByRole("button", { name: "保存数据集", exact: true }).click();
      const saved = await savedResponse; assert.equal(saved.status(), 201); const dataset = await saved.json();
      assert.equal(dataset.connectionId, connection.id); assert.equal(dataset.writeback.version, 2); assert.equal(dataset.writeback.kind, "postgresql");
      assert.equal(dataset.writeback.recordPath, undefined);
      const previewResponse = page.waitForResponse(response => response.url().endsWith(`/datasets/${dataset.id}/preview`));
      await page.getByRole("button", { name: "运行查询", exact: true }).click();
      const preview = await previewResponse; assert.equal(preview.status(), 200);
      assert.deepEqual((await preview.json()).rows, [{ id, output: 7 }]);
      await page.getByText("查询成功 · 已同步 2 个字段", { exact: true }).waitFor();
      const writesAfterDiscovery = metadataWrites;
      const path = `/api/projects/${project.id}/datasets/${dataset.id}/records/${id}`;
      const panel = page.locator(".dataset-writeback"), input = panel.getByLabel(/^output/);
      await panel.getByLabel("记录编号", { exact: true }).fill(id); await panel.getByRole("button", { name: "读取记录", exact: true }).click();
      await input.waitFor(); assert.equal(await input.inputValue(), "7");
      await input.fill("101"); await panel.getByRole("button", { name: "检查并提交", exact: true }).click();
      await panel.getByRole("alert").filter({ hasText: /范围/ }).waitFor(); assert.equal((await record(id)).revision, "1");
      await input.fill("12"); await submit(panel); await panel.getByRole("status").filter({ hasText: "记录已写入" }).waitFor();
      assert.deepEqual(await record(id), { output: 12, revision: "2" }); assert.equal((await gate.json("GET", path)).values.output, 12);
      const previewTable = page.locator(".data-preview-table");
      await previewTable.getByText("12", { exact: true }).waitFor(); assert.equal(metadataWrites, writesAfterDiscovery);
      entry.contrast = { heading: await contrast(previewTable.locator("th span").last()), cell: await contrast(previewTable.locator("tbody td").last()) };
      for (const ratio of Object.values(entry.contrast)) assert.ok(ratio >= 4.5, `preview contrast ${ratio}`);
      await page.screenshot({ path: resolve(gate.output, `${id}-written.png`), fullPage: true });
      await input.fill("25"); await page.reload(); await panel.getByText(/已恢复未提交修改/).waitFor();
      assert.equal(await input.inputValue(), "25");
      await panel.getByRole("button", { name: "重新读取并核对", exact: true }).click();
      await panel.getByRole("button", { name: "保留我的修改并重新确认", exact: true }).click();
      await pg.client.query("UPDATE records SET output=30,revision=revision+1 WHERE id=$1", [id]);
      expectedStatus = 409;
      const conflict = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(path));
      await submit(panel); assert.equal((await conflict).status(), 409); assert.equal(await input.inputValue(), "25");
      await panel.getByRole("button", { name: "重新读取并核对", exact: true }).click();
      await panel.getByRole("button", { name: "保留我的修改并重新确认", exact: true }).waitFor();
      assert.equal(await panel.locator("tbody tr").last().textContent(), "output2530");
      await page.screenshot({ path: resolve(gate.output, `${id}-conflict.png`), fullPage: true });
      await panel.getByRole("button", { name: "保留我的修改并重新确认", exact: true }).click();
      await submit(panel); await panel.getByRole("status").filter({ hasText: "记录已写入" }).waitFor();
      assert.deepEqual(await record(id), { output: 25, revision: "4" });
      expectedStatus = 422; await input.fill("95");
      const rejected = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(path));
      await submit(panel); assert.equal((await rejected).status(), 422); assert.deepEqual(await record(id), { output: 25, revision: "4" });
      expectedStatus = 502; await input.fill("40"); pg.dropNextCommit();
      const unknown = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(path));
      await submit(panel); const response = await unknown;
      assert.equal(response.status(), 502); assert.equal((await response.json()).outcome, "unknown");
      await panel.getByText(/写入结果未确认/).waitFor(); assert.deepEqual(await record(id), { output: 40, revision: "5" });
      assert.equal(await panel.getByRole("button", { name: "检查并提交", exact: true }).isDisabled(), true);
      await page.screenshot({ path: resolve(gate.output, `${id}-unknown.png`), fullPage: true });
      await page.reload(); await panel.getByText(/已恢复未提交修改/).waitFor(); assert.equal(await input.inputValue(), "40");
      await panel.getByRole("button", { name: "重新读取并核对", exact: true }).click();
      await panel.getByRole("button", { name: "采用当前记录", exact: true }).click();
      assert.deepEqual(await record(id), { output: 40, revision: "5" });
      if (round === 1 && theme === "dark") await readonlyCheck(project.id, dataset.id, id);
      const previewPath = `**/datasets/${dataset.id}/preview`;
      await page.getByRole("button", { name: "运行查询", exact: true }).click();
      await previewTable.getByText("40", { exact: true }).waitFor();
      expectedStatus = 503;
      await page.route(previewPath, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "isolated preview unavailable" }) }));
      const beforeFailureWrites = metadataWrites;
      await input.fill("41"); await submit(panel);
      await panel.getByText("记录已写入，视图刷新失败。", { exact: true }).waitFor();
      assert.deepEqual(await record(id), { output: 41, revision: "6" });
      await previewTable.getByText("40", { exact: true }).waitFor(); assert.equal(metadataWrites, beforeFailureWrites);
      await page.screenshot({ path: resolve(gate.output, `${id}-refresh-failed.png`), fullPage: true });
      await page.unroute(previewPath);
      await panel.getByRole("button", { name: "刷新视图", exact: true }).click();
      await previewTable.getByText("41", { exact: true }).waitFor();
      assert.deepEqual(await record(id), { output: 41, revision: "6" }); assert.equal(metadataWrites, beforeFailureWrites);
      assert.equal(await panel.getByText("记录已写入，视图刷新失败。", { exact: true }).count(), 0);
      await page.screenshot({ path: resolve(gate.output, `${id}-refreshed.png`), fullPage: true });
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = String(error); await page.screenshot({ path: resolve(gate.output, `${id}-failure.png`), fullPage: true }).catch(() => {}); throw error; }
    finally { await context.close(); }
  }
  assert.equal(pg.droppedCommits(), 4);
} finally {
  await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); await pg.close();
}
async function contrast(locator) {
  return locator.evaluate(element => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true }), ancestors = []; let node = element;
    while (node) { ancestors.unshift(node); node = node.parentElement; }
    for (const ancestor of ancestors) { ctx.fillStyle = getComputedStyle(ancestor).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
    const background = Array.from(ctx.getImageData(0, 0, 1, 1).data);
    ctx.fillStyle = getComputedStyle(element).color; ctx.fillRect(0, 0, 1, 1);
    const foreground = Array.from(ctx.getImageData(0, 0, 1, 1).data);
    const light = rgb => rgb.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
    return (Math.max(light(background), light(foreground)) + .05) / (Math.min(light(background), light(foreground)) + .05);
  });
}
assert.equal(report.cases.filter(entry => entry.passed).length, 4); console.log(JSON.stringify({ passed: true, output: gate.output, cases: 4 }));
async function submit(panel) { await panel.getByRole("button", { name: "检查并提交", exact: true }).click(); await panel.getByRole("button", { name: "确认写入", exact: true }).click(); }
async function readonlyCheck(projectId, datasetId, id) {
  const username = "sql-viewer", password = "isolated-sql-viewer";
  await gate.json("POST", "/api/admin/users", { username, password, role: "viewer", projectIds: [projectId] });
  const context = await gate.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const page = await context.newPage(); await page.goto(gate.origin);
    await page.getByLabel("用户名").fill(username); await page.getByLabel("密码").fill(password); await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator(".scene-manager-page").waitFor(); await page.goto(`${gate.origin}/manager?project=${projectId}`);
    await page.getByRole("button", { name: "数据中心", exact: true }).click();
    const panel = page.locator(".dataset-writeback");
    await panel.getByLabel("记录编号").fill(id); await panel.getByRole("button", { name: "读取记录", exact: true }).click();
    await panel.getByLabel(/^output/).waitFor(); assert.equal(await panel.getByLabel(/^output/).isDisabled(), true);
    const login = await gate.client.post("/api/auth/login", { data: { username, password } }), token = (await login.json()).token;
    const denied = await fetch(`${gate.apiOrigin}/api/projects/${projectId}/datasets/${datasetId}/records/${id}`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: '"sql:5"', values: { output: 60 } }) });
    assert.equal(denied.status, 403); assert.deepEqual(await record(id), { output: 40, revision: "5" });
  } finally { await context.close(); }
}
