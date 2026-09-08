import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createScene, observeDiagnostics, themeContext } from "./gateModelInstancesSupport.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";

// 真实编辑器和独立 API；只拦截模型传输，不调用提供方、不把模型夹具当质量评测。
const gate = await createIsolatedStudioGate("script-ai-session");
const report = { cases: [], evidenceScope: "Real editor and isolated persistence; deterministic model transport fixture" };
console.log(JSON.stringify({ output: gate.output }));
const widget = (id, name, y) => ({ id, name, kind: "data-widget", zIndex: 2, frame: { x: 40, y, width: 260, height: 100 }, widget: { type: "text", title: name, key: "", unit: "" } });
const script = (id, name) => ({ id, name, enabled: false, apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox", code: `function onStart(ctx) { ctx.log("${id}"); }`, lifecycle: ["onStart"], capabilities: ["studio.runtime"], permissions: ["scene.read"], target: { kind: "component", id } });
const sse = text => ({ contentType: "text/event-stream", body: `event: delta\ndata: ${JSON.stringify({ delta: text })}\n\nevent: done\ndata: ${JSON.stringify({ text, model: "isolated-script-ai" })}\n\n` });
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const entry = { round, theme, width, passed: false, errors: [], driverWarnings: [], expectedNetworkErrors: [], writes: 0, steps: [] };
    report.cases.push(entry);
    const context = await themeContext(gate, theme, width), page = await context.newPage();
    page.setDefaultTimeout(20000); observeDiagnostics(page, entry);
    const streams = [];
    await page.route("**/api/ai/assistant/stream", async route => {
      let release;
      const response = new Promise(done => { release = done; });
      streams.push({ body: route.request().postDataJSON(), release });
      await route.fulfill(await response).catch(() => undefined);
    });
    // 若实现回退到旧不可取消接口，立即失败且绝不访问在线模型。
    await page.route("**/api/ai/assistant", route => { entry.errors.push("Unexpected non-streaming AI request"); return route.abort(); });
    const waitCount = async count => {
      for (let attempt = 0; streams.length < count && attempt < 200; attempt++) await page.waitForTimeout(25);
      assert.equal(streams.length, count);
    };
    const shot = name => page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${name}.png`) });
    const ai = page.locator(".behavior-agent-workspace");
    const mode = name => ai.getByRole("button", { name, exact: true }).click();
    const run = name => ai.getByRole("button", { name, exact: true }).click();
    const open = async () => {
      await page.getByLabel("更多工具", { exact: true }).click();
      await page.getByRole("button", { name: "AI 脚本助手", exact: true }).click();
      await page.getByLabel("更多工具", { exact: true }).click();
      await ai.waitFor();
    };
    try {
      const project = await gate.json("POST", "/api/projects", { name: `脚本AI-${round}-${theme}` });
      const { application, appPath } = await createScene(gate, page, project.id);
      application.pages[0].nodes.push(widget("a", "目标甲", 60), widget("b", "目标乙", 220));
      application.scripts = [script("a", "甲脚本"), script("b", "乙脚本")];
      await gate.json("PUT", appPath, application);
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${application.pages[0].id}`);
      await page.getByRole("checkbox", { name: "自动保存", exact: true }).uncheck();
      await page.getByRole("button", { name: "脚本", exact: true }).click();
      await page.locator(".monaco-editor .view-lines").waitFor();
      await page.locator(".behavior-script-list > button").filter({ hasText: "甲脚本" }).click();
      await page.route(`**${appPath}`, route => { if (route.request().method() === "PUT") entry.writes++; return route.continue(); });
      await open();
      await run("解释脚本"); await waitCount(1);
      await ai.locator("textarea").fill("后续关注点保留");
      await shot("pending");
      await run("停止");
      assert.equal(await ai.locator("textarea").inputValue(), "后续关注点保留");
      await run("解释脚本"); await waitCount(2);
      streams[0].release(sse("OLD-STOPPED"));
      assert.equal(await ai.getByRole("button", { name: "停止", exact: true }).count(), 1);
      streams[1].release(sse("当前解释：未运行脚本"));
      await ai.getByText("当前解释：未运行脚本", { exact: true }).waitFor();
      assert.doesNotMatch(await ai.innerText(), /OLD-STOPPED/);
      entry.steps.push("stop-retry-keeps-input-and-ignores-late-response");

      await run("解释脚本"); await waitCount(3);
      await mode("诊断");
      streams[2].release(sse("OLD-MODE"));
      await run("诊断脚本"); await waitCount(4);
      streams[3].release({ contentType: "text/event-stream", body: "event: error\ndata: {\"message\":\"isolated provider unavailable\"}\n\n" });
      await ai.getByRole("status").filter({ hasText: "模型插件暂不可用" }).waitFor();
      assert.doesNotMatch(await ai.innerText(), /OLD-MODE/);
      await shot("fallback");
      entry.steps.push("mode-switch-cancels-old-result-provider-failure-keeps-local-diagnostics");

      await run("诊断脚本"); await waitCount(5);
      await page.locator(".behavior-script-list > button").filter({ hasText: "乙脚本" }).click();
      streams[4].release(sse("OLD-SCRIPT"));
      await ai.locator(".behavior-script-ai-context strong").filter({ hasText: "乙脚本" }).waitFor();
      await run("诊断脚本"); await waitCount(6);
      assert.equal(streams[5].body.context.script.id, "b");
      await mode("返回脚本");
      streams[5].release(sse("OLD-CLOSED"));
      await open();
      assert.doesNotMatch(await ai.innerText(), /OLD-SCRIPT|OLD-CLOSED/);
      entry.steps.push("file-switch-and-back-cancel-without-cross-file-results");

      await mode("生成"); await ai.locator("textarea").fill("按照车间规程处理当前卡片");
      await run("生成并检查"); await waitCount(7);
      streams[6].release(sse(JSON.stringify({ normalizedIntent: "function onStart() { fetch('https://invalid.example'); }" })));
      await ai.locator(".ai-script-draft-review").waitFor();
      assert.equal(await ai.getByRole("button", { name: "确认并插入编辑器", exact: true }).isDisabled(), true);
      await run("取消");
      await ai.locator("textarea").fill("按照车间规程处理当前卡片");
      await run("生成并检查"); await waitCount(8);
      streams[7].release(sse(JSON.stringify({ normalizedIntent: "隐藏组件", summary: "隐藏当前卡片" })));
      const confirm = ai.getByRole("button", { name: "确认并插入编辑器", exact: true });
      await confirm.waitFor(); assert.equal(await confirm.isEnabled(), true);
      const before = await page.locator(".monaco-editor .view-lines").innerText();
      await shot("review");
      assert.equal(entry.writes, 0, "生成审查不得自动持久化");
      await confirm.click();
      await ai.getByRole("button", { name: "撤销本次 AI 插入", exact: true }).waitFor();
      const inserted = await page.locator(".monaco-editor .view-lines").innerText();
      assert.notEqual(inserted, before); assert.match(inserted, /hide|visible|visibility/);
      await run("撤销本次 AI 插入");
      assert.equal(await page.locator(".monaco-editor .view-lines").innerText(), before);
      assert.equal(entry.writes, 0); assert.deepEqual((await gate.json("GET", appPath)).scripts, application.scripts);
      entry.steps.push("invalid-model-code-blocked-valid-declaration-reviewed-inserted-and-undone-no-save-or-run");
      entry.contrast = await ai.evaluate(collectTextContrast, ".behavior-script-ai-header button, .behavior-script-ai-context strong, .behavior-script-ai-context small, .behavior-script-ai-prompt, .behavior-script-ai-run");
      assert.deepEqual(entry.contrast.filter(item => item.text && item.contrast < 4.5), []);
      await shot("undo");
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack ?? String(error); await shot("failed"); }
    finally { streams.forEach(item => item.release(sse("released-on-cleanup"))); await context.close(); console.log(JSON.stringify(entry)); }
    if (!entry.passed) throw new Error(entry.failure);
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
assert.equal(report.cases.length, 4); assert.ok(report.cases.every(entry => entry.passed));
