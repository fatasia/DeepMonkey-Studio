import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";

const gate = await createIsolatedStudioGate("script-editor");
const report = { createdAt: new Date().toISOString(), cases: [] };
const code = message => `function onStart(ctx) {\n  ctx.log("${message}", { version: "${message}" });\n}`;
try {
  for (const theme of ["dark", "light"]) for (const width of [1440, 980]) {
    const entry = { theme, width, passed: false, errors: [], expectedNetworkErrors: [], writes: 0, steps: [] };
    report.cases.push(entry);
    const project = await gate.json("POST", "/api/projects", { name: `脚本键盘验收-${theme}-${width}` });
    const now = new Date().toISOString();
    const application = await gate.json("POST", `/api/projects/${project.id}/applications`, {
      schemaVersion: 2, metadata: { id: randomUUID(), projectId: project.id, name: "脚本运行与保存", revision: 1, createdAt: now, updatedAt: now },
      pages: [{ id: "one", name: "测试页面", width: 1000, height: 650, viewportFit: "contain", nodes: [] }],
      scenes: [], topologies: [], geo: { providerIds: [], layers: [] },
      data: { connectionIds: [], datasetIds: [], transforms: [], variables: [] }, interactions: [],
      scripts: [{ id: "main", name: "主脚本", enabled: true, apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox", code: code("OLD"), lifecycle: ["onStart"], capabilities: ["studio.runtime"], permissions: ["scene.read"], target: { kind: "scene" } }],
      assets: [], timelines: [], publicationProfiles: [{ id: "browser", name: "浏览器", target: "browser-preview", entryPageId: "one", renderer: "auto" }],
    });
    const appPath = `/api/projects/${project.id}/applications/${application.metadata.id}`;
    const context = await gate.browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } }); });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    let rejectSave = false;
    let delaySave = false;
    await page.route(`**${appPath}`, async route => {
      if (route.request().method() !== "PUT") return route.continue();
      entry.writes++;
      if (rejectSave) { rejectSave = false; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "验收：保存暂不可用" }) }); }
      if (delaySave) { delaySave = false; await new Promise(done => setTimeout(done, 900)); }
      return route.continue();
    });
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["warning", "error"].includes(message.type())) return;
      const text = message.text();
      if (text.includes("Failed to load resource: the server responded with a status of 503")) entry.expectedNetworkErrors.push(text);
      else entry.errors.push(text);
    });
    const shot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`) });
    const replace = async text => {
      await page.locator(".monaco-editor").click({ position: { x: 180, y: 80 } });
      await page.keyboard.press("Control+A"); await page.keyboard.press("Backspace");
      // Chrome's native EditContext inserts Monaco's closing brace while this
      // keyboard input is composed. Leave that pair to the editor (not the test).
      await page.keyboard.insertText(text.endsWith("}") ? text.slice(0, -1) : text);
      await page.getByText("有未应用的修改", { exact: true }).waitFor();
    };
    try {
      await gate.loginPage(page);
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/one`);
      await page.getByRole("checkbox", { name: "自动保存", exact: true }).uncheck();
      await page.getByRole("button", { name: "脚本", exact: true }).click();
      await page.locator(".monaco-editor .view-lines").waitFor();
      assert.equal(await page.locator(`.monaco-editor.${theme === "light" ? "vs" : "vs-dark"}`).count(), 1);
      entry.layout = await page.evaluate(() => [".app-workspace-surface", ".dashboard-workspace", ".dashboard-design-surface", ".dashboard-canvas-scroll", ".dashboard-field-panel-shell", ".behavior-editor-toolbar", ".monaco-editor-background"].map(selector => {
        const node = document.querySelector(selector);
        if (!node) return { selector, missing: true };
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { selector, width: rect.width, x: rect.x, grid: style.gridTemplateColumns, background: style.backgroundColor };
      }));
      const toolbar = await page.locator(".behavior-editor-toolbar").boundingBox();
      for (const control of await page.locator(".behavior-editor-toolbar > :is(label,button,details,.behavior-target-field)").all()) {
        const box = await control.boundingBox();
        assert.ok(!box || box.x + box.width <= toolbar.x + toolbar.width + 1, "Script toolbar control clipped");
      }
      assert.ok((await page.locator(".behavior-run-action").boundingBox()).width >= 72);
      const editorColor = entry.layout.find(item => item.selector === ".monaco-editor-background").background.match(/\d+/g).map(Number);
      assert.ok(editorColor.every(value => theme === "light" ? value >= 250 : value <= 40), "Monaco background must match the token theme");
      assert.equal(entry.layout.find(item => item.selector === ".dashboard-design-surface").width, entry.layout.find(item => item.selector === ".app-workspace-surface").width, "Hidden inspector must not reserve preview space");
      assert.ok((await page.locator(".dashboard-canvas-toolbar").boundingBox()).y >= 52, "Canvas tools must not sit behind the fixed global header");
      const list = page.getByRole("complementary", { name: "脚本文件", exact: true });
      const listWidth = (await list.boundingBox()).width;
      assert.equal(listWidth, 152);
      const codeWidth = (await page.locator(".monaco-editor").boundingBox()).width;
      await page.getByRole("button", { name: "收起文件列表", exact: true }).click();
      assert.equal(await list.count(), 0);
      assert.ok((await page.locator(".monaco-editor").boundingBox()).width > codeWidth + 140);
      await shot("files-collapsed");
      await page.getByRole("button", { name: "展开脚本列表", exact: true }).click();
      const target = page.locator(".behavior-target-picker > summary");
      assert.equal((await target.innerText()).trim(), "整个场景");
      assert.ok((await target.boundingBox()).height <= 34);
      entry.steps.push("compact-152px-files-collapse-restores-code-space-single-line-target");
      await replace(code("NEW")); await page.keyboard.press("Control+Enter");
      await page.getByText("试运行已提交，请查看运行状态与日志", { exact: true }).waitFor();
      if (await page.locator(".behavior-console-toggle").getAttribute("aria-expanded") !== "true") await page.locator(".behavior-console-toggle").click();
      await page.locator(".behavior-console p").filter({ hasText: "NEW" }).waitFor();
      assert.doesNotMatch(await page.locator(".behavior-console").innerText(), /OLD/);
      await replace(code("LATEST")); await page.keyboard.press("Control+Enter");
      await page.locator(".behavior-console p").filter({ hasText: "LATEST" }).waitFor();
      assert.match(await page.locator(".behavior-console").innerText(), /version.*LATEST/);
      await page.getByRole("searchbox", { name: "搜索运行日志", exact: true }).fill("missing");
      await page.getByText("没有匹配的日志，请调整筛选。", { exact: true }).waitFor();
      await page.getByRole("searchbox", { name: "搜索运行日志", exact: true }).fill("LATEST");
      await page.locator(".behavior-console p").filter({ hasText: "LATEST" }).waitFor();
      await page.getByRole("combobox", { name: "日志等级", exact: true }).selectOption("error");
      assert.equal(await page.locator(".behavior-console p").count(), 0);
      await page.getByRole("combobox", { name: "日志等级", exact: true }).selectOption("all");
      await page.getByRole("searchbox", { name: "搜索运行日志", exact: true }).fill("");
      const chromeText = ".behavior-panel-heading strong, .behavior-context-badge, .behavior-file-header strong, .behavior-script-list > button strong, .behavior-editor > footer > span, .behavior-editor > footer em, .behavior-console header button, .behavior-console-filters select, .behavior-console-filters label, .behavior-console p, .workspace-mode-switch button.active, .workspace-context, .dashboard-canvas-toolbar output, .dashboard-page-tabs button.active, .dashboard-field-panel-handle span, .dashboard-workspace-title strong, .dashboard-workspace-title span";
      entry.contrast = await page.locator("body").evaluate(collectTextContrast, chromeText);
      assert.deepEqual(entry.contrast.filter(item => item.text && item.contrast < 4.5), [], "Editor chrome text contrast below 4.5:1");
      entry.steps.push("real-CtrlEnter-always-uses-latest-code-and-structured-detail", "chrome-text-contrast-at-least-4.5"); await shot("latest-run");
      await page.getByRole("button", { name: "停止运行", exact: true }).click();
      await replace("const broken = ;");
      await page.locator(".professional-code-problems.has-problems").waitFor();
      await page.locator(".professional-code-problems").click();
      await page.locator(".professional-code-problem-list button").first().click();
      await page.waitForFunction(() => document.querySelector(".monaco-editor")?.contains(document.activeElement));
      entry.steps.push("language-only-error-opens-and-focuses-source");
      await replace(code("SAVED"));
      rejectSave = true;
      await page.keyboard.press("Control+S");
      await page.getByText("保存未完成，草稿已保留，请重试", { exact: true }).waitFor();
      assert.equal((await gate.json("GET", appPath)).scripts[0].code, code("OLD"));
      assert.match(await page.locator(".monaco-editor .view-lines").innerText(), /SAVED/);
      await shot("failed-save-retains-draft");
      const writesBefore = entry.writes;
      delaySave = true;
      await page.locator(".monaco-editor").click({ position: { x: 180, y: 80 } });
      await page.keyboard.press("Control+S"); await page.keyboard.press("Control+S");
      await page.getByText("脚本已保存", { exact: true }).waitFor();
      assert.equal(entry.writes - writesBefore, 1, "Repeated save must share one request");
      assert.equal((await gate.json("GET", appPath)).scripts[0].code.replace(/\s/g, ""), code("SAVED").replace(/\s/g, ""));
      entry.steps.push("failed-save-retains-input-retry-persists-deduplicated-CtrlS");
      await shot("saved"); await page.reload();
      await page.getByRole("button", { name: "脚本", exact: true }).click();
      await page.locator(".monaco-editor .view-lines").waitFor();
      assert.match(await page.locator(".monaco-editor .view-lines").innerText(), /SAVED/);
      entry.steps.push("reload-restores-saved-code");
      assert.equal(entry.expectedNetworkErrors.length, 1); assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack ?? String(error); entry.visibleCode = await page.locator(".monaco-editor .view-lines").innerText().catch(() => "unavailable"); await shot("failed"); }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
    if (!entry.passed) throw new Error(entry.failure);
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ ...report, output: gate.output }, null, 2));
assert.ok(report.cases.length === 4 && report.cases.every(entry => entry.passed));
