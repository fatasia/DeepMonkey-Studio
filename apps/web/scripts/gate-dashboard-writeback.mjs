import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createWritebackGate } from "./gateWritebackFixture.mjs";
import { createScene, themeContext } from "./gateModelInstancesSupport.mjs";

const gate = await createWritebackGate();
const report = { webIndexSha: createHash("sha256").update(await readFile(resolve(import.meta.dirname, "../dist/index.html"))).digest("hex"), cases: [] };
console.log(JSON.stringify({ output: gate.output }));
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const id = `r${round}-${theme}`, recordId = `${id}-alpha`, otherId = `${id}-beta`;
    gate.seed(recordId); gate.seed(otherId);
    const entry = { id, passed: false, errors: [], expectedNetworkErrors: [], driverWarnings: [] }; report.cases.push(entry);
    const context = await themeContext(gate, theme, width), page = await context.newPage();
    let expectedPreviewFailure = false;
    const previewReads = new Map();
    page.on("request", request => { if (/\/datasets\/[^/]+\/preview$/.test(request.url())) previewReads.set(request.url(), (previewReads.get(request.url()) ?? 0) + 1); });
    page.setDefaultTimeout(20000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["error", "warning"].includes(message.type())) return;
      if (message.location().url.includes("/records/") && /409|502/.test(message.text())) entry.expectedNetworkErrors.push(message.text());
      else if (expectedPreviewFailure && message.location().url.endsWith("/preview") && /503/.test(message.text())) entry.expectedNetworkErrors.push(message.text());
      else if (/X4122/.test(message.text())) entry.driverWarnings.push(message.text());
      else entry.errors.push(message.text());
    });
    const shot = name => page.screenshot({ path: resolve(gate.output, `${id}-${name}.png`), fullPage: true });
    try {
      const project = await gate.json("POST", "/api/projects", { name: `二维填报 ${id}` });
      const connection = await gate.json("POST", `/api/projects/${project.id}/data-connections`, { name: "产量记录", type: "http", enabled: true, config: { url: `${gate.fixtureOrigin}/list?id=${recordId}` } });
      const datasets = [];
      for (const name of ["产量填报 A", "产量填报 B"]) datasets.push(await gate.json("POST", `/api/projects/${project.id}/datasets`, { name, connectionId: connection.id, sourceKey: "items", refreshSeconds: 0, fields: [{ key: "output", type: "number", label: "产量" }], writeback: { version: 1, recordPath: "/records/{id}", fields: [{ key: "output", type: "number", min: 0, max: 100 }] } }));
      const { application, appPath } = await createScene(gate, page, project.id);
      const authored = structuredClone(application);
      authored.pages[0].nodes = [0, 1].map(index => ({ id: `entry-${index}`, name: `产量 ${index ? "B" : "A"}`, kind: "data-widget", frame: { x: 64, y: 64 + index * 250, width: 280, height: 180 }, zIndex: index + 1, widget: { type: "value", title: `产量 ${index ? "B" : "A"}`, key: "output", unit: "件", ...(index ? { datasetId: datasets[1].id } : {}) } }));
      await gate.json("PUT", appPath, authored);
      const url = `${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${application.pages[0].id}`;
      await page.goto(url);
      const nodes = page.locator(".dashboard-artboard .dashboard-node"); await nodes.first().click();
      await dataTab(page);
      const inspector = page.locator(".dashboard-inspector-panel");
      await inspector.getByLabel("数据来源", { exact: true }).selectOption("platform");
      await inspector.getByLabel("数据产品", { exact: true }).selectOption(`dataset:${datasets[0].id}`);
      const saved = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith(appPath));
      await page.getByRole("button", { name: "保存", exact: true }).click(); assert.equal((await saved).status(), 200);
      assert.equal((await gate.json("GET", appPath)).pages[0].nodes[0].widget.datasetId, datasets[0].id);
      // 两个工具面板共享工作区而不是叠在一起遮挡：填报展开会收起字段目录。
      const fields = page.getByRole("complementary", { name: "字段面板", exact: true });
      if (!(await fields.locator(".dashboard-field-panel").count())) await fields.getByTitle("展开数据字段", { exact: true }).click();
      await inspector.getByRole("button", { name: "填报", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "数据集填报", exact: true });
      const panel = dialog.locator(".dataset-writeback");
      assert.equal(await fields.locator(".dashboard-field-panel").count(), 0);
      await inspector.getByRole("button", { name: "选字段", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await inspector.getByRole("button", { name: "填报", exact: true }).click();
      await dialog.waitFor(); assert.equal(await fields.locator(".dashboard-field-panel").count(), 0);
      await load(panel, recordId); const input = panel.getByLabel(/^output/); assert.equal(await input.inputValue(), "7");
      const previewPath = `${gate.origin}/api/projects/${project.id}/datasets/${datasets[0].id}/preview`;
      const otherPreviewPath = `${gate.origin}/api/projects/${project.id}/datasets/${datasets[1].id}/preview`;
      const otherReads = previewReads.get(otherPreviewPath) ?? 0;
      await input.fill("12"); await submit(panel); await panel.getByRole("status").filter({ hasText: "记录已写入" }).waitFor();
      assert.equal(gate.record(recordId).values.output, 12); assert.equal(gate.writes(recordId), 1);
      await nodes.first().locator('.dashboard-value strong[title="12"]').waitFor();
      assert.equal(previewReads.get(otherPreviewPath) ?? 0, otherReads, "写后只刷新当前数据集，不能刷新其他数据集");
      entry.dock = await page.locator(".dashboard-writeback-dock").evaluate(element => ({ blur: getComputedStyle(element).backdropFilter, outer: element.getBoundingClientRect().width, inner: element.firstElementChild.getBoundingClientRect().width }));
      assert.equal(entry.dock.blur, "none"); assert.equal(entry.dock.outer, 440); assert.equal(entry.dock.inner, entry.dock.outer);
      await shot("written");
      await input.fill("25"); await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
      await inspector.getByRole("button", { name: "填报", exact: true }).click();
      await panel.getByText(/已恢复未提交修改/).waitFor(); assert.equal(await input.inputValue(), "25"); assert.equal(gate.writes(recordId), 1);
      await nodes.nth(1).click(); await dialog.waitFor({ state: "hidden" });
      await dataTab(page); await inspector.getByRole("button", { name: "填报", exact: true }).click();
      await load(panel, otherId); assert.equal(await input.inputValue(), "7"); assert.equal(gate.writes(otherId), 0);
      await input.fill("18"); await dialog.getByRole("button", { name: "关闭填报", exact: true }).click();
      await nodes.first().click(); await dataTab(page); await inspector.getByRole("button", { name: "填报", exact: true }).click();
      await panel.getByText(/已恢复未提交修改/).waitFor(); assert.equal(await input.inputValue(), "25");
      await page.reload(); await nodes.first().click(); await dataTab(page); await inspector.getByRole("button", { name: "填报", exact: true }).click();
      await panel.getByText(/已恢复未提交修改/).waitFor(); assert.equal(await input.inputValue(), "25"); assert.equal(gate.writes(recordId), 1);
      await panel.getByRole("button", { name: "重新读取并核对", exact: true }).click();
      await panel.getByRole("button", { name: "保留我的修改并重新确认", exact: true }).click();
      const beforeConflictReads = previewReads.get(previewPath) ?? 0;
      gate.externalUpdate(recordId, 30); await submit(panel);
      await panel.getByRole("button", { name: "重新读取并核对", exact: true }).waitFor(); assert.equal(await input.inputValue(), "25");
      await panel.getByRole("button", { name: "重新读取并核对", exact: true }).click();
      await panel.getByRole("button", { name: "保留我的修改并重新确认", exact: true }).waitFor(); await shot("conflict");
      assert.equal(await panel.locator("tbody tr").last().textContent(), "output2530");
      assert.equal(previewReads.get(previewPath) ?? 0, beforeConflictReads, "409不是写入成功，不能触发成功刷新");
      await panel.getByRole("button", { name: "保留我的修改并重新确认", exact: true }).click();
      await submit(panel); await panel.getByRole("status").filter({ hasText: "记录已写入" }).waitFor(); assert.equal(gate.writes(recordId), 2);
      await nodes.first().locator('.dashboard-value strong[title="25"]').waitFor();
      const beforeUnknownReads = previewReads.get(previewPath) ?? 0;
      gate.disconnectNext(recordId); await input.fill("40"); await submit(panel);
      await panel.getByText(/写入结果未确认/).waitFor(); assert.equal(gate.writes(recordId), 3);
      assert.equal(previewReads.get(previewPath) ?? 0, beforeUnknownReads, "未知结果不能当成功刷新");
      await dialog.getByRole("button", { name: "关闭填报", exact: true }).click();
      await inspector.getByRole("button", { name: "填报", exact: true }).click();
      await panel.getByText(/已恢复未提交修改/).waitFor(); assert.equal(await input.inputValue(), "40");
      assert.equal(await panel.getByRole("button", { name: "检查并提交", exact: true }).isDisabled(), true);
      await panel.getByRole("button", { name: "重新读取并核对", exact: true }).click();
      await panel.getByRole("button", { name: "采用当前记录", exact: true }).click();
      assert.equal(gate.writes(recordId), 3); assert.equal(gate.record(recordId).values.output, 40); await shot("reconciled");
      if (round === 1 && theme === "dark") await readonly(gate, project.id, url, recordId);
      // 仅查询响应注入 503；业务 PATCH 仍由真实上游落库，不伪造写入成功。
      expectedPreviewFailure = true;
      await page.route(previewPath, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "受控视图刷新失败" }) }));
      const failedRefresh = page.waitForResponse(response => response.url() === previewPath && response.status() === 503);
      await input.fill("41"); await submit(panel); await failedRefresh;
      await panel.getByRole("status").filter({ hasText: "记录已写入" }).waitFor();
      await panel.getByRole("alert").filter({ hasText: "视图刷新失败" }).waitFor();
      assert.equal(gate.record(recordId).values.output, 41); assert.equal(gate.writes(recordId), 4);
      assert.equal(await panel.getByRole("button", { name: "检查并提交", exact: true }).isDisabled(), true);
      assert.equal(await panel.getByText(/写入结果未确认/).count(), 0);
      assert.equal(await nodes.first().locator(".dashboard-value strong").getAttribute("title"), "25");
      await shot("refresh-failed"); await page.unroute(previewPath);
      // 首次重试只读，并把在飞的旧快照卡住；随后确认的新写入必须等待新查询。
      let releaseOld, capturedOld;
      const oldCaptured = new Promise(resolve => { capturedOld = resolve; });
      const oldRelease = new Promise(resolve => { releaseOld = resolve; });
      let held = false;
      await page.route(previewPath, async route => {
        if (held) { await route.continue(); return; }
        held = true;
        const response = await route.fetch(); capturedOld(); await oldRelease; await route.fulfill({ response });
      });
      const beforeRetry = previewReads.get(previewPath) ?? 0;
      await panel.getByRole("button", { name: "刷新视图", exact: true }).click(); await oldCaptured;
      await panel.getByRole("status").filter({ hasText: "正在刷新视图" }).waitFor();
      assert.equal(gate.writes(recordId), 4, "刷新视图不能发起写请求");
      await input.fill("42"); await submit(panel);
      await panel.getByRole("status").filter({ hasText: "记录已写入" }).waitFor();
      assert.equal(gate.writes(recordId), 5); releaseOld();
      await nodes.first().locator('.dashboard-value strong[title="42"]').waitFor();
      await panel.getByRole("status").filter({ hasText: "正在刷新视图" }).waitFor({ state: "hidden" });
      assert.equal(previewReads.get(previewPath), beforeRetry + 2, "写后新读不能复用写前的旧在飞快照");
      assert.equal(await panel.getByRole("alert").filter({ hasText: "视图刷新失败" }).count(), 0);
      await shot("refresh-recovered"); await page.unroute(previewPath);
      // 切记录后迟到的查询失败不能污染新记录；仍不得重放已确认的 PATCH。
      let releaseLate, capturedLate;
      const lateCaptured = new Promise(resolve => { capturedLate = resolve; });
      const lateRelease = new Promise(resolve => { releaseLate = resolve; });
      await page.route(previewPath, async route => {
        capturedLate(); await lateRelease;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "受控迟到查询失败" }) });
      });
      await input.fill("43"); await submit(panel); await lateCaptured;
      await panel.getByRole("status").filter({ hasText: "记录已写入" }).waitFor();
      await load(panel, otherId); await panel.locator("legend").filter({ hasText: otherId }).waitFor();
      const lateResponse = page.waitForResponse(response => response.url() === previewPath && response.status() === 503);
      releaseLate(); await (await lateResponse).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await panel.getByRole("alert").filter({ hasText: "视图刷新失败" }).count(), 0);
      assert.equal(await input.inputValue(), "7"); assert.equal(gate.writes(recordId), 6);
      await shot("late-refresh-ignored"); await page.unroute(previewPath);
      await dialog.getByRole("button", { name: "关闭填报", exact: true }).click();
      const conditional = inspector.getByRole("region", { name: "条件格式", exact: true });
      await conditional.getByRole("button", { name: "添加规则", exact: true }).click();
      await conditional.locator(".dashboard-conditional-rule").scrollIntoViewIfNeeded();
      entry.conditional = await conditional.evaluate(element => {
        const rule = element.querySelector(".dashboard-conditional-rule"), button = element.querySelector("header button");
        const probe = document.createElement("span"); probe.style.backgroundColor = "var(--surface-2)"; element.append(probe);
        const expected = getComputedStyle(probe).backgroundColor; probe.remove();
        return { background: getComputedStyle(rule).backgroundColor, expected, nowrap: getComputedStyle(button).whiteSpace };
      });
      assert.equal(entry.conditional.nowrap, "nowrap");
      assert.equal(entry.conditional.background, entry.conditional.expected);
      await shot("conditional");
      await conditional.getByRole("button", { name: "删除规则 1", exact: true }).click();
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = String(error); await shot("failure"); throw error; }
    finally { await context.close(); }
  }
} finally { await writeFile(resolve(gate.output, "dashboard-report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, passed: report.cases.every(entry => entry.passed), cases: report.cases.length }));

async function dataTab(page) { await page.locator(".dashboard-inspector-tabs").getByRole("button", { name: "数据", exact: true }).click(); }
async function load(panel, id) { await panel.getByLabel("记录编号", { exact: true }).fill(id); await panel.getByRole("button", { name: "读取记录", exact: true }).click(); await panel.getByLabel(/^output/).waitFor(); }
async function submit(panel) { await panel.getByRole("button", { name: "检查并提交", exact: true }).click(); await panel.getByRole("button", { name: "确认写入", exact: true }).click(); }
async function readonly(gate, projectId, url, recordId) {
  await gate.json("POST", "/api/admin/users", { username: "dashboard-viewer", password: "dashboard-viewer-fixture", role: "viewer", projectIds: [projectId] });
  const context = await gate.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const page = await context.newPage(); await page.goto(gate.origin);
    await page.getByLabel("用户名").fill("dashboard-viewer"); await page.getByLabel("密码").fill("dashboard-viewer-fixture");
    await page.getByRole("button", { name: "登录", exact: true }).click(); await page.locator(".scene-manager-page").waitFor();
    await page.goto(url); await page.locator(".dashboard-artboard .dashboard-node").first().click(); await dataTab(page);
    await page.locator(".dashboard-inspector-panel").getByRole("button", { name: "填报", exact: true }).click();
    const panel = page.locator(".dashboard-writeback-dock .dataset-writeback"); await load(panel, recordId);
    assert.equal(await panel.getByLabel(/^output/).isDisabled(), true);
    assert.equal(await panel.getByRole("button", { name: "检查并提交", exact: true }).isDisabled(), true);
    assert.equal(gate.writes(recordId), 3);
  } finally { await context.close(); }
}
