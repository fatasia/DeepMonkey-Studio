import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createWritebackGate } from "./gateWritebackFixture.mjs";
import { createScene, observeDiagnostics, themeContext } from "./gateModelInstancesSupport.mjs";

const gate = await createWritebackGate();
const report = { webIndexSha: createHash("sha256").update(await readFile(resolve(import.meta.dirname, "../dist/index.html"))).digest("hex"), cases: [],
  boundary: "Real isolated authoring and persistence; deterministic SSE model responses, not online model-quality evaluation." };
const sse = (text, draft) => ({ contentType: "text/event-stream", body: `event: delta\ndata: ${JSON.stringify({ delta: JSON.stringify({ text }) })}\n\nevent: done\ndata: ${JSON.stringify({ text, model: "isolated-dashboard-ai", dashboardPageDraft: draft })}\n\n` });
console.log(JSON.stringify({ output: gate.output }));
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const id = `ai-r${round}-${theme}`;
    const entry = { id, round, theme, width, passed: false, errors: [], driverWarnings: [], expectedNetworkErrors: [], saves: 0, requests: 0 };
    report.cases.push(entry);
    const context = await themeContext(gate, theme, width), page = await context.newPage();
    page.setDefaultTimeout(20000); observeDiagnostics(page, entry);
    let capture;
    const pending = new Set();
    await page.route("**/api/ai/assistant/stream", async route => {
      entry.requests++;
      let release; const response = new Promise(resolve => { release = resolve; }); pending.add(release);
      capture?.({ body: route.request().postDataJSON(), release }); capture = undefined;
      await route.fulfill(await response).catch(() => undefined); pending.delete(release);
    });
    await page.route("**/api/ai/assistant", route => { entry.errors.push("Unexpected non-streaming request"); return route.abort(); });
    const panel = page.getByRole("dialog", { name: "AI 看板", exact: true });
    const shot = name => page.screenshot({ path: resolve(gate.output, `${id}-${name}.png`), fullPage: true });
    const open = async () => { await page.getByRole("button", { name: "AI 看板", exact: true }).click(); await panel.waitFor(); };
    const ask = async question => {
      const captured = new Promise(resolve => { capture = resolve; });
      await panel.getByLabel("看板需求", { exact: true }).fill(question);
      await panel.getByRole("button", { name: "生成草案", exact: true }).click();
      return captured;
    };
    try {
      gate.seed(id);
      const project = await gate.json("POST", "/api/projects", { name: `AI 看板 ${id}` });
      const connection = await gate.json("POST", `/api/projects/${project.id}/data-connections`, { name: "实际产量", type: "http", enabled: true, config: { url: `${gate.fixtureOrigin}/list?id=${id}` } });
      const dataset = await gate.json("POST", `/api/projects/${project.id}/datasets`, { name: "实际产量", connectionId: connection.id, sourceKey: "items", refreshSeconds: 0, fields: [{ key: "output", type: "number", label: "产量" }] });
      const { application, appPath } = await createScene(gate, page, project.id);
      await page.getByRole("button", { name: "AI 场景助手", exact: true }).click();
      entry.legacyBounds = await page.locator(".ai-assistant-studio").evaluate(element => {
        const panel = element.getBoundingClientRect(), viewport = element.closest(".workspace")?.querySelector(".viewport")?.getBoundingClientRect();
        return { left: panel.left, right: panel.right, width: panel.width, viewportLeft: viewport?.left, viewportRight: viewport?.right };
      });
      assert.ok(entry.legacyBounds.viewportLeft !== undefined && entry.legacyBounds.left >= entry.legacyBounds.viewportLeft + 8, JSON.stringify(entry.legacyBounds));
      assert.ok(entry.legacyBounds.right <= entry.legacyBounds.viewportRight - 8, JSON.stringify(entry.legacyBounds));
      await page.getByRole("button", { name: "看板", exact: true }).click();
      const legacyCaptured = new Promise(resolve => { capture = resolve; });
      const legacyPrompt = page.getByRole("textbox", { name: "向 AI 助手提问", exact: true });
      await legacyPrompt.fill("生成当前场景看板"); await legacyPrompt.press("Enter");
      const legacy = await legacyCaptured;
      assert.equal(legacy.body.mode, "dashboard"); assert.notEqual(legacy.body.context?.workspace?.dashboardDraftVersion, 1);
      legacy.release({ contentType: "text/event-stream", body: `event: done\ndata: ${JSON.stringify({ text: "保留旧场景看板流程。", model: "isolated-dashboard-ai", dashboard: { side: "right", width: 320, widgets: [{ id: "legacy-kpi", type: "value", title: "旧入口产量", key: "output", x: 0, y: 0, w: 12, h: 4 }] } })}\n\n` });
      await page.getByRole("button", { name: "查看并应用", exact: true }).click();
      await page.getByRole("button", { name: "应用到草稿", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "已写入当前看板草稿" }).waitFor();
      assert.deepEqual((await gate.json("GET", appPath)).scenes, application.scenes);
      await shot("legacy-3d-applied"); entry.legacy3dAppliedWithoutSaving = true;
      await legacyPrompt.press("Escape");
      const pageId = application.pages[0].id;
      const node = (id, title, x, y = 80) => ({ id, kind: "data-widget", name: title, zIndex: 1, frame: { x, y, width: 300, height: 180 }, widget: { type: "value", title, key: `${dataset.id}.output`, unit: "件", fontSize: 24, datasetId: dataset.id, field: "output" } });
      application.pages[0].nodes = [node("existing", "原产量", 64), node("remove", "待移除", 400), node("untouched", "保留组件", 64, 360)];
      const secondPage = { ...structuredClone(application.pages[0]), id: `other-${id}`, name: "其他页面", nodes: [node("other-page-widget", "跨页保留", 64)] };
      application.pages.push(secondPage);
      const authored = await gate.json("PUT", appPath, application);
      const initial = authored.pages[0].nodes;
      const url = `${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${pageId}`;
      await page.goto(url);
      await page.route(`**${appPath}`, route => { if (route.request().method() === "PUT") entry.saves++; return route.continue(); });
      const nodes = page.locator(".dashboard-artboard .dashboard-node");
      await nodes.first().waitFor(); await open();
      const first = await ask("新增产量，修改原产量标题，删除待移除组件，其他不变");
      const firstDraft = { version: 1, pageId, changes: [
        { op: "add", id: "generated", frame: { x: 400, y: 80, width: 360, height: 180 }, widget: { type: "value", title: "AI 产量", key: "output", unit: "件", datasetId: dataset.id, field: "output" } },
        { op: "update", id: "existing", widget: { title: "调整后产量" } }, { op: "delete", id: "remove" },
      ] };
      assert.equal(first.body.context.workspace.page.id, pageId); assert.equal(first.body.context.workspace.dashboardDraftVersion, 1);
      first.release(sse("新增一个产量组件，修改标题并删除指定组件。", firstDraft));
      await panel.getByRole("button", { name: "确认应用", exact: true }).waitFor();
      entry.draftBounds = await panel.evaluate(element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }; });
      assert.ok(entry.draftBounds.left >= 0 && entry.draftBounds.right <= width && entry.draftBounds.top >= 52 && entry.draftBounds.bottom <= 1000, JSON.stringify(entry.draftBounds));
      assert.ok(entry.draftBounds.scrollWidth <= entry.draftBounds.clientWidth + 1, JSON.stringify(entry.draftBounds));
      assert.equal(await panel.locator(".dashboard-ai-draft-diff article").count(), 3);
      assert.deepEqual((await gate.json("GET", appPath)).pages[0].nodes, initial); assert.equal(entry.saves, 0);
      await shot("diff");
      await panel.getByRole("button", { name: "确认应用", exact: true }).focus(); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
      await panel.getByRole("status").filter({ hasText: "已应用" }).waitFor();
      assert.equal(await nodes.count(), 3); assert.equal(entry.saves, 0);
      await panel.getByRole("button", { name: "关闭 AI 看板", exact: true }).click();
      await page.getByRole("button", { name: "撤销", exact: true }).click(); await nodes.getByText("原产量", { exact: true }).waitFor();
      assert.equal(await nodes.getByText("AI 产量", { exact: true }).count(), 0); await nodes.getByText("待移除", { exact: true }).waitFor();
      await page.getByRole("button", { name: "重做", exact: true }).click(); await nodes.getByText("AI 产量", { exact: true }).waitFor();
      await nodes.filter({ hasText: "AI 产量" }).locator('.dashboard-value strong[title="7"]').waitFor();
      await save(page, appPath); assert.equal(entry.saves, 1);
      const saved = await gate.json("GET", appPath);
      assert.deepEqual(saved.pages[1], secondPage); assert.deepEqual(saved.scenes, application.scenes);
      assert.deepEqual(saved.pages[0].nodes.find(node => node.id === "untouched"), initial[2]);
      await page.reload(); await nodes.getByText("AI 产量", { exact: true }).waitFor(); await open();
      const second = await ask("把 AI 产量标题改为复核产量，并移动到 x=440");
      assert.equal(second.body.context.workspace.page.nodes.find(node => node.id === "generated").widget.title, "AI 产量");
      second.release(sse("修改已保存的同一组件。", { version: 1, pageId, changes: [{ op: "update", id: "generated", widget: { title: "复核产量" }, frame: { x: 440, y: 80, width: 360, height: 180 } }] }));
      await panel.getByRole("button", { name: "确认应用", exact: true }).click(); await panel.getByRole("status").filter({ hasText: "已应用" }).waitFor();
      await panel.getByRole("button", { name: "关闭 AI 看板", exact: true }).click(); await save(page, appPath); await page.reload();
      await nodes.getByText("复核产量", { exact: true }).waitFor();
      await nodes.filter({ hasText: "复核产量" }).locator('.dashboard-value strong[title="7"]').waitFor();
      const iterated = await gate.json("GET", appPath); assert.equal(iterated.pages[0].nodes.find(node => node.id === "generated").frame.x, 440);
      await shot("saved-iteration"); await open();
      const invalid = await ask("使用不存在的字段");
      invalid.release(sse("无效字段草案", { version: 1, pageId, changes: [{ ...firstDraft.changes[0], id: "invalid", widget: { ...firstDraft.changes[0].widget, field: "invented" } }] }));
      await panel.getByRole("alert").filter({ hasText: "不存在字段" }).waitFor(); assert.equal(await panel.getByRole("button", { name: "确认应用", exact: true }).count(), 0);
      await shot("invalid-field"); assert.equal(entry.saves, 2);
      const noChange = await ask("无需修改"); noChange.release(sse("当前页面无需变更。", { version: 1, pageId, changes: [] }));
      await panel.getByRole("status").filter({ hasText: "没有可应用" }).waitFor(); assert.equal(entry.saves, 2);
      const stopped = await ask("待停止的生成"); const requestsBeforeStop = entry.requests;
      await panel.getByRole("button", { name: "停止", exact: true }).click(); stopped.release(sse("迟到方案", firstDraft));
      await panel.getByRole("status").filter({ hasText: "已停止" }).waitFor(); assert.equal(await panel.getByRole("button", { name: "确认应用", exact: true }).count(), 0);
      assert.equal(entry.requests, requestsBeforeStop, "stopping must not submit another generation");
      const stale = await ask("生成期间页面被人工移动");
      await nodes.getByText("调整后产量", { exact: true }).click();
      await page.keyboard.press("ArrowRight");
      stale.release(sse("旧页面草案", { version: 1, pageId, changes: [{ op: "update", id: "generated", widget: { title: "不应落入" } }] }));
      await panel.getByRole("alert").filter({ hasText: "页面已变化" }).waitFor(); assert.equal(entry.saves, 2);
      await shot("stale-rejected");
      await panel.getByRole("button", { name: "关闭 AI 看板", exact: true }).click();
      await page.reload(); await open();
      const late = await ask("关闭后迟到的草案"); await panel.getByRole("button", { name: "关闭 AI 看板", exact: true }).click(); late.release(sse("不应应用", firstDraft));
      await open(); assert.equal(await panel.locator(".dashboard-ai-draft-diff article").count(), 0);
      assert.deepEqual((await gate.json("GET", appPath)).pages[0].nodes, iterated.pages[0].nodes); assert.equal(gate.writes(id), 0);
      await panel.getByRole("button", { name: "关闭 AI 看板", exact: true }).click();
      // 英文界面单独检查空草案反馈，不把英文 labels 的单测当作浏览器证据。
      await page.evaluate(() => localStorage.setItem("bim-studio.locale", "en-US")); await page.reload();
      await page.getByRole("button", { name: "AI dashboard", exact: true }).click();
      const english = page.getByRole("dialog", { name: "AI dashboard", exact: true });
      const captured = new Promise(resolve => { capture = resolve; });
      await english.getByLabel("Dashboard request").fill("Keep the current page unchanged"); await english.getByRole("button", { name: "Generate draft", exact: true }).click();
      (await captured).release(sse("No change is needed.", { version: 1, pageId, changes: [] }));
      await english.getByRole("status").filter({ hasText: "No changes to apply" }).waitFor();
      assert.doesNotMatch(await english.getByRole("status").textContent(), /[\u4e00-\u9fff]/);
      await shot("english-empty");
      const englishAsk = async question => {
        const request = new Promise(resolve => { capture = resolve; });
        await english.getByLabel("Dashboard request").fill(question); await english.getByRole("button", { name: "Generate draft", exact: true }).click(); return request;
      };
      const englishInvalid = await englishAsk("Use an unavailable field");
      englishInvalid.release(sse("Invalid field.", { version: 1, pageId, changes: [{ ...firstDraft.changes[0], id: "invalid-en", widget: { ...firstDraft.changes[0].widget, field: "invented" } }] }));
      await english.getByRole("alert").filter({ hasText: "Unable to apply" }).waitFor();
      assert.doesNotMatch(await english.getByRole("alert").textContent(), /[\u4e00-\u9fff]/); await shot("english-invalid");
      const englishStale = await englishAsk("Update while the page changes");
      await nodes.getByText("调整后产量", { exact: true }).click(); await page.keyboard.press("ArrowRight");
      englishStale.release(sse("Stale draft.", { version: 1, pageId, changes: [{ op: "update", id: "generated", widget: { title: "Must not apply" } }] }));
      await english.getByRole("alert").filter({ hasText: "Unable to apply" }).waitFor();
      assert.doesNotMatch(await english.getByRole("alert").textContent(), /[\u4e00-\u9fff]/); await shot("english-stale");
      await readonly(gate, project.id, url, id, theme, width); entry.readonlyEntryHidden = true;
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (reason) { entry.failure = String(reason); await shot("failure"); throw reason; }
    finally { for (const release of pending) release(sse("Cancelled", { version: 1, changes: [] })); await context.close(); }
  }
} finally { await writeFile(resolve(gate.output, "ai-dashboard-report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, passed: report.cases.every(entry => entry.passed), cases: report.cases.length }));

async function save(page, appPath) {
  const pending = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith(appPath));
  await page.getByRole("button", { name: "保存", exact: true }).click(); assert.equal((await pending).status(), 200);
}

async function readonly(gate, projectId, url, id, theme, width) {
  const username = `viewer-${id}`, password = "isolated-ai-viewer";
  await gate.json("POST", "/api/admin/users", { username, password, role: "viewer", projectIds: [projectId] });
  const context = await themeContext(gate, theme, width);
  try {
    const page = await context.newPage(); await page.goto(gate.origin);
    await page.getByLabel("用户名").fill(username); await page.getByLabel("密码").fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click(); await page.locator(".scene-manager-page").waitFor();
    await page.goto(url); await page.locator(".dashboard-artboard .dashboard-node").first().waitFor();
    assert.equal(await page.getByRole("button", { name: "AI 看板", exact: true }).count(), 0);
    await page.screenshot({ path: resolve(gate.output, `${id}-readonly.png`) });
  } finally { await context.close(); }
}
