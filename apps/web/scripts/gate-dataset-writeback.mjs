import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createWritebackGate } from "./gateWritebackFixture.mjs";
import { themeContext } from "./gateModelInstancesSupport.mjs";

const gate = await createWritebackGate();
const report = { createdAt: new Date().toISOString(), cases: [], webIndexSha: createHash("sha256").update(await readFile(resolve(import.meta.dirname, "../dist/index.html"))).digest("hex") };
console.log(JSON.stringify({ output: gate.output }));
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const id = `r${round}-${theme}`, entry = { id, round, theme, width, passed: false, errors: [], expectedNetworkErrors: [], steps: [] };
    report.cases.push(entry); gate.seed(id);
    const project = await gate.json("POST", "/api/projects", { name: `REST 填报 ${id}` });
    const context = await themeContext(gate, theme, width), page = await context.newPage();
    page.setDefaultTimeout(15000);
    let expectedStatus;
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["error", "warning"].includes(message.type())) return;
      const text = message.text(), url = message.location().url;
      if (expectedStatus && url.includes("/records/") && text.includes(String(expectedStatus))) entry.expectedNetworkErrors.push(text);
      else entry.errors.push(text);
    });
    try {
      await gate.loginPage(page);
      await page.goto(`${gate.origin}/manager?project=${project.id}`);
      await page.getByRole("button", { name: "数据中心", exact: true }).click();
      await page.locator(".data-center-page").waitFor();
      const connectionPane = page.locator(".data-center-pane").first();
      await connectionPane.getByRole("button", { name: "新建", exact: true }).click();
      const connectionForm = connectionPane.locator(".data-inline-form");
      await connectionForm.getByLabel("名称", { exact: true }).fill(`业务 REST ${id}`);
      await connectionForm.getByLabel("类型").selectOption("http");
      await connectionForm.getByLabel("URL / Endpoint").fill(`${gate.fixtureOrigin}/list?id=${id}`);
      const connectionResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/data-connections"));
      await connectionForm.getByRole("button", { name: "保存连接", exact: true }).click();
      assert.equal((await connectionResponse).status(), 201);
      await connectionForm.waitFor({ state: "hidden" });
      const datasetPane = page.locator(".data-center-pane").nth(1);
      await datasetPane.getByRole("button", { name: "新建", exact: true }).click();
      const form = datasetPane.locator(".data-inline-form");
      await form.getByLabel("名称", { exact: true }).fill(`产量填报 ${id}`);
      await form.getByPlaceholder("data.items", { exact: true }).fill("items");
      await form.getByLabel("启用填报", { exact: true }).check();
      await form.getByLabel("填报字段 1", { exact: true }).fill("output");
      await form.getByLabel("字段类型 1", { exact: true }).selectOption("number");
      await form.getByText("校验规则", { exact: true }).click();
      await form.getByLabel("必填", { exact: true }).check();
      await form.getByLabel("字段 1 最小值", { exact: true }).fill("0");
      await form.getByLabel("字段 1 最大值", { exact: true }).fill("100");
      await form.locator(".dataset-writeback-config").scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(gate.output, `${id}-configuration.png`), fullPage: true });
      const datasetResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/datasets"));
      await form.getByRole("button", { name: "保存数据集", exact: true }).click();
      const saved = await datasetResponse; assert.equal(saved.status(), 201); const dataset = await saved.json();
      assert.deepEqual(dataset.writeback, { version: 1, recordPath: "/records/{id}", fields: [{ key: "output", type: "number", required: true, min: 0, max: 100 }] });
      const recordPath = `/api/projects/${project.id}/datasets/${dataset.id}/records/${id}`;
      entry.steps.push("UI configure and persist");
      const panel = page.locator(".dataset-writeback");
      await panel.getByLabel("记录编号", { exact: true }).fill(id);
      await panel.getByRole("button", { name: "读取记录", exact: true }).click();
      const input = panel.getByLabel(/^output/);
      await input.waitFor(); assert.equal(await input.inputValue(), "7");
      await input.fill("101");
      await panel.getByRole("button", { name: "检查并提交", exact: true }).click();
      await panel.getByRole("alert").filter({ hasText: /范围/ }).waitFor(); assert.equal(gate.writes(id), 0);
      await input.fill("12"); await reviewAndSubmit(panel);
      await panel.getByRole("status").filter({ hasText: "记录已写入" }).waitFor();
      assert.equal(gate.record(id).values.output, 12); assert.equal(gate.writes(id), 1);
      assert.equal((await gate.json("GET", recordPath)).values.output, 12);
      await page.locator(".data-preview-table").getByText("12", { exact: true }).waitFor();
      entry.steps.push("validate then true write and re-read");
      await page.reload(); await page.locator(".data-center-page").waitFor();
      await panel.getByLabel("记录编号", { exact: true }).fill(id);
      await panel.getByRole("button", { name: "读取记录", exact: true }).click();
      await input.waitFor(); assert.equal(await input.inputValue(), "12");
      entry.steps.push("reload preserved configuration and record");
      await input.fill("25");
      await page.reload(); await panel.getByText(/已恢复未提交修改/).waitFor();
      assert.equal(await input.inputValue(), "25"); assert.equal(gate.writes(id), 1);
      await panel.getByRole("button", { name: "重新读取并核对", exact: true }).click();
      await panel.getByRole("button", { name: "保留我的修改并重新确认", exact: true }).click();
      assert.equal(await input.inputValue(), "25");
      entry.steps.push("unsent draft survives reload and requires reconciliation");
      gate.externalUpdate(id, 30);
      expectedStatus = 409;
      const conflictResponse = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(recordPath));
      await reviewAndSubmit(panel); assert.equal((await conflictResponse).status(), 409);
      await panel.getByRole("button", { name: "重新读取并核对", exact: true }).waitFor();
      assert.equal(await input.inputValue(), "25"); assert.equal(gate.writes(id), 1);
      await panel.getByRole("button", { name: "重新读取并核对", exact: true }).click();
      await panel.getByRole("button", { name: "保留我的修改并重新确认", exact: true }).waitFor();
      assert.equal(await panel.locator("tbody tr").last().textContent(), "output2530");
      await page.screenshot({ path: resolve(gate.output, `${id}-conflict.png`), fullPage: true });
      await panel.getByRole("button", { name: "保留我的修改并重新确认", exact: true }).click();
      await reviewAndSubmit(panel); await panel.getByRole("status").filter({ hasText: "记录已写入" }).waitFor();
      assert.equal(gate.record(id).values.output, 25); assert.equal(gate.writes(id), 2);
      entry.steps.push("409 kept draft, compare and explicit resubmit");
      expectedStatus = 502; gate.disconnectNext(id); await input.fill("40");
      const unknownResponse = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(recordPath));
      await reviewAndSubmit(panel); const unknown = await unknownResponse;
      assert.equal(unknown.status(), 502); assert.equal((await unknown.json()).outcome, "unknown");
      await panel.getByText(/写入结果未确认/).waitFor(); assert.equal(gate.writes(id), 3);
      assert.equal(await panel.getByRole("button", { name: "检查并提交", exact: true }).isDisabled(), true);
      await page.reload(); await panel.getByText(/已恢复未提交修改/).waitFor();
      assert.equal(await input.inputValue(), "40"); assert.equal(gate.writes(id), 3);
      await panel.getByRole("button", { name: "重新读取并核对", exact: true }).click();
      await panel.getByRole("button", { name: "采用当前记录", exact: true }).click();
      assert.equal(await input.inputValue(), "40"); assert.equal(gate.writes(id), 3);
      await page.screenshot({ path: resolve(gate.output, `${id}-reconciled.png`), fullPage: true });
      entry.steps.push("unknown outcome reconciled without replay");
      if (round === 1 && theme === "dark") await verifyReadonly(gate, project.id, dataset.id, id, entry);
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = String(error); await page.screenshot({ path: resolve(gate.output, `${id}-failure.png`), fullPage: true }).catch(() => {}); throw error; }
    finally { await context.close(); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
assert.ok(report.cases.length === 4 && report.cases.every(entry => entry.passed));
console.log(JSON.stringify({ passed: true, output: gate.output, cases: report.cases.length }));

async function reviewAndSubmit(panel) {
  await panel.getByRole("button", { name: "检查并提交", exact: true }).click();
  await panel.getByRole("button", { name: "确认写入", exact: true }).click();
}
async function verifyReadonly(gate, projectId, datasetId, recordId, entry) {
  const password = "readonly-writeback-fixture";
  await gate.json("POST", "/api/admin/users", { username: "writeback-viewer", password, role: "viewer", projectIds: [projectId] });
  const context = await gate.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const page = await context.newPage(); await page.goto(gate.origin);
    await page.getByLabel("用户名").fill("writeback-viewer"); await page.getByLabel("密码").fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click(); await page.locator(".scene-manager-page").waitFor();
    await page.goto(`${gate.origin}/manager?project=${projectId}`); await page.getByRole("button", { name: "数据中心", exact: true }).click();
    const panel = page.locator(".dataset-writeback");
    await panel.getByLabel("记录编号", { exact: true }).fill(recordId); await panel.getByRole("button", { name: "读取记录", exact: true }).click();
    await panel.getByLabel(/^output/).waitFor(); assert.equal(await panel.getByLabel(/^output/).isDisabled(), true);
    assert.equal(await panel.getByRole("button", { name: "检查并提交", exact: true }).isDisabled(), true);
    const login = await gate.client.post("/api/auth/login", { data: { username: "writeback-viewer", password } });
    const token = (await login.json()).token;
    const denial = await fetch(`${gate.apiOrigin}/api/projects/${projectId}/datasets/${datasetId}/records/${recordId}`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ values: { output: 99 }, expectedVersion: '"v1"' }) });
    assert.equal(denial.status, 403); assert.equal(gate.record(recordId).values.output, 40);
    entry.steps.push("viewer UI and direct API both deny write");
  } finally { await context.close(); }
}
