import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { migrateSceneSnapshotV1 } from "../../../packages/contracts/dist/index.js";
import { createWritebackGate } from "./gateWritebackFixture.mjs";
import { themeContext } from "./gateModelInstancesSupport.mjs";

const gate = await createWritebackGate();
const report = { kind: "dashboard-record-form", webIndexSha: createHash("sha256").update(await readFile(resolve(import.meta.dirname, "../dist/index.html"))).digest("hex"), cases: [] };
console.log(JSON.stringify({ output: gate.output }));
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const id = `r${round}-${theme}`, entry = { id, theme, width, passed: false, errors: [], expectedNetworkErrors: [], recordReads: 0, recordWrites: 0 };
    report.cases.push(entry); gate.seed(id);
    const context = await themeContext(gate, theme, width), page = await context.newPage(); page.setDefaultTimeout(20000);
    let expectedStatus;
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("request", request => { if (request.url().includes("/records/")) { if (request.method() === "GET") entry.recordReads++; if (request.method() === "PATCH") entry.recordWrites++; } });
    page.on("console", message => {
      if (!["warning", "error"].includes(message.type())) return;
      const url = message.location().url;
      if (expectedStatus && (url.includes("/records/") || expectedStatus === 503 && url.endsWith("/preview")) && message.text().includes(String(expectedStatus))) entry.expectedNetworkErrors.push(message.text());
      else entry.errors.push(message.text());
    });
    const shot = name => page.screenshot({ path: resolve(gate.output, `${id}-${name}.png`), fullPage: true });
    try {
      const project = await gate.json("POST", "/api/projects", { name: `画布填报 ${id}` });
      const connection = await gate.json("POST", `/api/projects/${project.id}/data-connections`, { name: "产量记录", type: "http", enabled: true, config: { url: `${gate.fixtureOrigin}/list?id=${id}` } });
      const dataset = await gate.json("POST", `/api/projects/${project.id}/datasets`, { name: "产量填报", connectionId: connection.id, sourceKey: "items", refreshSeconds: 0, fields: [{ key: "output", type: "number", label: "产量" }], writeback: { version: 1, recordPath: "/records/{id}", fields: [{ key: "output", type: "number", min: 0, max: 100 }] } });
      const fixture = JSON.parse(await readFile(resolve(import.meta.dirname, "../../../test-fixtures/scene-v1-pure-3d.json"), "utf8"));
      const application = migrateSceneSnapshotV1({ ...fixture, id: randomUUID(), projectId: project.id, name: `画布填报 ${id}` });
      const authoredPage = application.pages[0]; authoredPage.width = 1280; authoredPage.height = 900;
      authoredPage.nodes = [{ id: "actual-output", name: "实际产量", kind: "data-widget", frame: { x: 870, y: 100, width: 260, height: 180 }, zIndex: 1,
        widget: { type: "value", title: "实际产量", key: `${dataset.id}.output`, unit: "件", datasetId: dataset.id, field: "output" } }];
      await gate.json("POST", `/api/projects/${project.id}/applications`, application);
      const appPath = `/api/projects/${project.id}/applications/${application.metadata.id}`;
      const url = `${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${authoredPage.id}`;
      await gate.loginPage(page); await page.goto(url);
      const autoSave = page.getByLabel("自动保存", { exact: true }); if (await autoSave.isChecked()) await autoSave.uncheck();
      await page.locator(".dashboard-left-tabs").getByRole("button", { name: "资源", exact: true }).click();
      await page.getByPlaceholder("搜索组件", { exact: true }).fill("填报表单");
      await page.locator(".dashboard-library-card").filter({ hasText: "填报表单" }).first().click();
      entry.libraryAdded = await inspectAuthorTheme(page, theme, true);
      const inspector = page.locator(".dashboard-inspector-panel");
      for (const [label, value] of [["X", "80"], ["Y", "90"], ["宽", "720"], ["高", "650"]]) await inspector.getByLabel(label, { exact: true }).fill(value);
      await inspector.locator(".dashboard-inspector-tabs").getByRole("button", { name: "数据", exact: true }).click();
      await inspector.locator("label").filter({ hasText: /^填报数据集/ }).locator("select").selectOption(dataset.id);
      await inspector.getByLabel("记录编号", { exact: true }).fill(id); await inspector.getByLabel("记录编号", { exact: true }).press("Tab");
      await save(page, appPath);
      const saved = await gate.json("GET", appPath), form = saved.pages[0].nodes.find(node => node.widget?.type === "record-form");
      assert.equal(form.widget.datasetId, dataset.id); assert.deepEqual(form.widget.recordForm, { recordId: id });
      await page.getByRole("button", { name: "完整显示看板", exact: true }).click();
      entry.authorTheme = await inspectAuthorTheme(page, theme);
      assert.equal(entry.recordReads, 0); assert.equal(entry.recordWrites, 0); await shot("author-configured");
      await page.reload(); await page.locator(".dashboard-artboard .dashboard-record-form").waitFor();
      const runtime = page.locator(".dashboard-runtime-preview"), panel = runtime.locator(".dataset-writeback"), input = panel.getByLabel(/^output/);
      const browse = async () => { await page.getByRole("button", { name: "浏览", exact: true }).click(); await runtime.waitFor(); };
      await browse(); await input.waitFor(); assert.equal(await input.inputValue(), "7"); assert.equal(await panel.getByLabel("记录编号", { exact: true }).getAttribute("readonly"), "");
      await input.fill("101"); await panel.getByRole("button", { name: "检查并提交", exact: true }).click();
      await panel.getByRole("alert").filter({ hasText: /范围/ }).waitFor(); assert.equal(gate.writes(id), 0);
      await input.fill("12"); await submit(panel); await panel.getByRole("status").filter({ hasText: "记录已写入" }).waitFor();
      await runtime.locator('.dashboard-value strong[title="12"]').waitFor(); assert.equal(gate.record(id).values.output, 12); assert.equal(gate.writes(id), 1);
      entry.formGeometry = await inspectFormGeometry(page); await shot("written"); await input.fill("25");
      await page.getByRole("button", { name: "返回编辑", exact: true }).click(); await page.reload();
      const beforeRestoreReads = entry.recordReads; await browse(); await panel.getByText(/已恢复未提交修改/).waitFor();
      assert.equal(await input.inputValue(), "25"); assert.equal(entry.recordReads, beforeRestoreReads); assert.equal(gate.writes(id), 1);
      await panel.getByRole("button", { name: "重新读取并核对", exact: true }).click(); await panel.getByRole("button", { name: "保留我的修改并重新确认", exact: true }).click();
      gate.externalUpdate(id, 30); expectedStatus = 409; await submit(panel);
      await panel.getByRole("button", { name: "重新读取并核对", exact: true }).waitFor(); assert.equal(await input.inputValue(), "25"); assert.equal(gate.writes(id), 1);
      await panel.getByRole("button", { name: "重新读取并核对", exact: true }).click();
      await panel.getByRole("button", { name: "保留我的修改并重新确认", exact: true }).waitFor(); assert.equal(await panel.locator("tbody tr").last().textContent(), "output2530");
      entry.conflictGeometry = await inspectFormGeometry(page); await shot("conflict"); await panel.getByRole("button", { name: "保留我的修改并重新确认", exact: true }).click(); await submit(panel);
      await panel.getByRole("status").filter({ hasText: "记录已写入" }).waitFor(); assert.equal(gate.writes(id), 2);
      await runtime.locator('.dashboard-value strong[title="25"]').waitFor();
      gate.disconnectNext(id); expectedStatus = 502; await input.fill("40"); await submit(panel);
      await panel.getByText(/写入结果未确认/).waitFor(); assert.equal(gate.writes(id), 3); assert.equal(gate.record(id).values.output, 40);
      assert.equal(await panel.getByRole("button", { name: "检查并提交", exact: true }).isDisabled(), true); await shot("unknown");
      await page.getByRole("button", { name: "返回编辑", exact: true }).click(); await browse(); await panel.getByText(/已恢复未提交修改/).waitFor();
      assert.equal(gate.writes(id), 3); await panel.getByRole("button", { name: "重新读取并核对", exact: true }).click();
      await panel.getByRole("button", { name: "采用当前记录", exact: true }).click();
      const previewPath = `**/datasets/${dataset.id}/preview`; expectedStatus = 503;
      await page.route(previewPath, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "isolated preview failure" }) }));
      await input.fill("41"); await submit(panel); await panel.getByText("记录已写入，视图刷新失败。", { exact: true }).waitFor();
      assert.equal(gate.writes(id), 4); await shot("refresh-failed"); await page.unroute(previewPath);
      await panel.getByRole("button", { name: "刷新视图", exact: true }).click(); await runtime.locator('.dashboard-value strong[title="41"]').waitFor();
      assert.equal(gate.writes(id), 4); await shot("refreshed");
      await page.getByRole("button", { name: "返回编辑", exact: true }).click();
      const publishing = page.waitForResponse(response => response.url().endsWith(`${appPath}/publish`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "发布", exact: true }).click(); assert.equal((await publishing).status(), 201);
      const published = await gate.json("GET", `/api/public/applications/${application.metadata.id}`);
      assert.ok(JSON.stringify(published).includes('"record-form"')); assert.ok(JSON.stringify(published).includes(id));
      const anonymous = await themeContext(gate, theme, width), publicPage = await anonymous.newPage();
      let publicRecords = 0;
      publicPage.on("request", request => { if (request.url().includes("/records/")) publicRecords++; });
      publicPage.on("pageerror", error => entry.errors.push(error.message));
      publicPage.on("console", message => { if (["warning", "error"].includes(message.type())) entry.errors.push(message.text()); });
      await publicPage.goto(`${gate.origin}/apps/${application.metadata.id}`);
      await publicPage.locator(".dashboard-runtime-artboard").or(publicPage.getByRole("alert")).first().waitFor();
      entry.publicText = await publicPage.locator("body").innerText();
      await publicPage.screenshot({ path: resolve(gate.output, `${id}-public-loaded.png`), fullPage: true });
      await publicPage.getByText("公开页只读，填报需在登录后的作者预览中操作。", { exact: true }).waitFor();
      await publicPage.reload(); await publicPage.getByText("公开页只读，填报需在登录后的作者预览中操作。", { exact: true }).waitFor();
      assert.equal(await publicPage.locator(".dataset-writeback").count(), 0); assert.equal(publicRecords, 0); assert.equal(gate.writes(id), 4);
      entry.publicGeometry = await inspectFormGeometry(publicPage);
      await publicPage.screenshot({ path: resolve(gate.output, `${id}-public.png`), fullPage: true }); await anonymous.close();
      if (round === 1 && theme === "dark") await viewer(gate, project.id, url, id);
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = String(error); await shot("failed").catch(() => {}); throw error; }
    finally { await context.close(); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
assert.equal(report.cases.filter(entry => entry.passed).length, 4); console.log(JSON.stringify({ passed: true, output: gate.output, cases: 4 }));

async function save(page, path) {
  const response = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存", exact: true }).click(); const saved = await response; assert.equal(saved.status(), 200, await saved.text());
}
async function submit(panel) { await panel.getByRole("button", { name: "检查并提交", exact: true }).click(); await panel.getByRole("button", { name: "确认写入", exact: true }).click(); }
async function inspectFormGeometry(page) {
  const result = await page.locator(".dashboard-runtime-artboard .dashboard-record-form").evaluate(form => {
    const artboard = form.closest(".dashboard-runtime-artboard"), matrix = new DOMMatrix(getComputedStyle(artboard).transform);
    const rect = form.getBoundingClientRect(), node = form.closest(".dashboard-node").getBoundingClientRect();
    const controls = [...form.querySelectorAll("input,select,button")].map(el => ({ height: el.getBoundingClientRect().height, font: parseFloat(getComputedStyle(el).fontSize) * matrix.d }));
    const texts = [...form.querySelectorAll("label,p,th,td,span")].filter(el => el.textContent.trim()).map(el => parseFloat(getComputedStyle(el).fontSize) * matrix.d);
    return { scaleX: matrix.a, scaleY: matrix.d, transform: getComputedStyle(form).transform, controls, minText: Math.min(...texts), overflowX: form.scrollWidth - form.clientWidth, contained: rect.left >= node.left - 1 && rect.right <= node.right + 1 && rect.top >= node.top - 1 && rect.bottom <= node.bottom + 1 };
  });
  assert.equal(result.transform, "none"); assert.equal(result.contained, true); assert.ok(result.overflowX <= 1);
  assert.ok(result.minText >= 12.9, JSON.stringify(result));
  for (const control of result.controls) { assert.ok(control.height >= 31.9, JSON.stringify(result)); assert.ok(control.font >= 12.9, JSON.stringify(result)); }
  return result;
}
async function inspectAuthorTheme(page, theme, added = false) {
  const result = await page.evaluate(requireAdded => {
    const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
    const rgb = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lum = color => rgb(color).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    return [[".dashboard-library-search input", ".dashboard-library-search"], [requireAdded ? ".dashboard-library-card.added strong" : ".dashboard-library-card strong", ".dashboard-library-card"], [".dashboard-delete-node", ".dashboard-delete-node"]].map(([text, background]) => {
      const el = document.querySelector(text), bg = document.querySelector(background); if (!el || !bg) throw new Error(`Missing theme target ${text}`);
      const fgL = lum(getComputedStyle(el).color), bgL = lum(getComputedStyle(bg).backgroundColor);
      return { target: text, backgroundLuminance: bgL, contrast: (Math.max(fgL, bgL) + .05) / (Math.min(fgL, bgL) + .05) };
    });
  }, added);
  for (const item of result) { assert.ok(item.contrast >= 4.5, JSON.stringify(item)); assert.ok(theme === "light" ? item.backgroundLuminance > .5 : item.backgroundLuminance < .15, JSON.stringify(item)); }
  return result;
}
async function viewer(gate, projectId, url, recordId) {
  const username = "canvas-viewer", password = "isolated-canvas-viewer";
  await gate.json("POST", "/api/admin/users", { username, password, role: "viewer", projectIds: [projectId] });
  const context = await gate.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const page = await context.newPage(); await page.goto(gate.origin);
    await page.getByLabel("用户名").fill(username); await page.getByLabel("密码").fill(password); await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator(".scene-manager-page").waitFor(); await page.goto(url); await page.getByRole("button", { name: "浏览", exact: true }).click();
    const panel = page.locator(".dataset-writeback"); await panel.getByLabel(/^output/).waitFor();
    assert.equal(await panel.getByLabel(/^output/).isDisabled(), true); assert.equal(await panel.getByRole("button", { name: "检查并提交", exact: true }).isDisabled(), true); assert.equal(gate.writes(recordId), 4);
  } finally { await context.close(); }
}
