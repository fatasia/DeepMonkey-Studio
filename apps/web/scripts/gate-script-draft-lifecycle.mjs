import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";

const gate = await createIsolatedStudioGate("script-drafts");
const report = { cases: [] };
const widget = (id, title, y) => ({ id, name: title, kind: "data-widget", zIndex: 1, frame: { x: 80, y, width: 700, height: 140 }, widget: { type: "text", title, key: "", unit: "", fontSize: 32 } });
const script = (id, name) => ({ id, name, enabled: true, apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox", code: `function onStart(ctx) { const marker = "${id}"; ctx.log(marker); }`, lifecycle: ["onStart"], capabilities: ["studio.runtime"], permissions: ["scene.read"], target: { kind: "component", id } });
try {
  for (const theme of ["dark", "light"]) for (const width of [1440, 980]) {
    const entry = { theme, width, passed: false, errors: [], writes: 0, steps: [] };
    report.cases.push(entry);
    const project = await gate.json("POST", "/api/projects", { name: `草稿边界-${theme}-${width}` });
    const now = new Date().toISOString();
    const application = await gate.json("POST", `/api/projects/${project.id}/applications`, {
      schemaVersion: 2, metadata: { id: randomUUID(), projectId: project.id, name: "草稿保护", revision: 1, createdAt: now, updatedAt: now },
      pages: [{ id: "one", name: "切换验证", width: 1000, height: 650, viewportFit: "contain", nodes: [widget("a", "目标甲", 100), widget("b", "目标乙", 350)] }],
      scenes: [], topologies: [], geo: { providerIds: [], layers: [] }, data: { connectionIds: [], datasetIds: [], transforms: [], variables: [] },
      interactions: [], scripts: [script("a", "甲脚本"), script("b", "乙脚本")], assets: [], timelines: [],
      publicationProfiles: [{ id: "browser", name: "浏览器", target: "browser-preview", entryPageId: "one", renderer: "auto" }],
    });
    const appPath = `/api/projects/${project.id}/applications/${application.metadata.id}`;
    const context = await gate.browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } }); });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => { if (["warning", "error"].includes(message.type())) entry.errors.push(message.text()); });
    let releaseSave, saveIntercepted;
    let holdSave = false;
    await page.route(`**${appPath}`, async route => {
      if (route.request().method() !== "PUT") return route.continue();
      entry.writes++;
      if (holdSave) {
        holdSave = false;
        saveIntercepted?.();
        await new Promise(done => { releaseSave = done; });
      }
      return route.continue();
    });
    const shot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`) });
    const name = page.getByRole("textbox", { name: "脚本名称", exact: true });
    const selectTarget = async title => page.locator(".dashboard-native-widget").filter({ hasText: title }).click();
    try {
      await gate.loginPage(page);
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/one`);
      await page.getByRole("checkbox", { name: "自动保存", exact: true }).uncheck();
      await page.getByRole("button", { name: "脚本", exact: true }).click();
      await page.locator(".monaco-editor .view-lines").waitFor();
      await name.fill("甲未保存修改");
      await selectTarget("目标乙");
      await page.waitForFunction(() => document.querySelector('[aria-label="脚本名称"]')?.value === "乙脚本");
      await selectTarget("目标甲");
      await shot("switch-back");
      assert.equal(await name.inputValue(), "甲未保存修改", "Selecting another canvas target must preserve the previous script draft");
      assert.equal(entry.writes, 0, "Switching a target applies a local draft without implicit API save");
      entry.steps.push("target-selection-preserves-local-draft-without-network-write");

      await name.fill("");
      await selectTarget("目标乙");
      assert.equal(await name.inputValue(), "", "Invalid draft must block automatic file switch");
      await page.getByRole("button", { name: "新建", exact: true }).click();
      assert.equal(await name.inputValue(), "", "Creating a file must not discard an invalid draft");
      await page.getByText("请先填写脚本名称", { exact: true }).waitFor();
      await name.fill("甲保存请求");
      entry.steps.push("invalid-name-blocks-target-switch-and-new-file");

      holdSave = true;
      const intercepted = new Promise(done => { saveIntercepted = done; });
      await page.getByRole("button", { name: "保存脚本", exact: true }).click();
      await intercepted;
      await name.fill("等待期间继续编辑");
      await page.locator(".behavior-script-list > button").filter({ hasText: "乙脚本" }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="脚本名称"]')?.value === "乙脚本");
      const savedResponse = page.waitForResponse(response => response.url().endsWith(appPath) && response.request().method() === "PUT");
      releaseSave(); await savedResponse;
      await page.waitForFunction(() => !document.querySelector('.behavior-save-action')?.disabled);
      assert.doesNotMatch(await page.locator(".behavior-editor > footer").innerText(), /脚本已保存/, "A late response must not claim the newly selected script was saved");
      await page.locator(".behavior-script-list > button").filter({ hasText: "等待期间继续编辑" }).click();
      assert.equal(await name.inputValue(), "等待期间继续编辑", "Save acknowledgement must not overwrite later input");
      assert.equal((await gate.json("GET", appPath)).scripts.find(item => item.id === "a").name, "甲保存请求");
      await shot("late-save-retains-draft");
      await page.getByRole("button", { name: "保存脚本", exact: true }).click();
      await page.getByText("脚本已保存", { exact: true }).waitFor();
      assert.equal((await gate.json("GET", appPath)).scripts.find(item => item.id === "a").name, "等待期间继续编辑");
      await page.reload(); await page.getByRole("button", { name: "脚本", exact: true }).click();
      await page.locator(".monaco-editor .view-lines").waitFor();
      // 页面会恢复此前选中的目标乙；明确返回目标甲再核对保存内容。
      await selectTarget("目标甲");
      assert.equal(await name.inputValue(), "等待期间继续编辑");
      entry.steps.push("late-save-feedback-owned-by-file", "later-input-survives-save-and-reload");
      const problems = page.locator(".professional-code-problems.has-problems");
      if (await problems.count()) {
        await problems.click();
        entry.languageIssues = await page.locator(".professional-code-problem-list button strong").allTextContents();
        assert.deepEqual(entry.languageIssues, [], "The valid lifecycle fixture must have no script diagnostics");
      }
      assert.deepEqual(entry.errors, []); entry.passed = true; await shot("verified");
    } catch (error) { entry.failure = error.stack ?? String(error); await shot("failed"); }
    finally { releaseSave?.(); await context.close(); console.log(JSON.stringify(entry)); }
    if (!entry.passed) throw new Error(entry.failure);
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ ...report, output: gate.output }, null, 2));
