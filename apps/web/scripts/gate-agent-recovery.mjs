import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";

const gate = await createIsolatedStudioGate("agent-recovery");
const report = { boundary: "Isolated production UI; deterministic Agent HTTP fixtures. Real orchestrator/provider/query recovery is covered separately by API integration tests. No live provider or original project writes.", cases: [] };
const tool = { id: "data.query.read", label: "读取数据证据", description: "当前项目只读数据", effect: "read", risk: "low", requiresApproval: false };
try {
  for (const theme of ["dark", "light"]) for (const width of [1440, 980]) {
    const project = await gate.json("POST", "/api/projects", { name: `Agent recovery ${theme} ${width}` });
    const entry = { theme, width, errors: [], expectedHttpErrors: [], actions: [] };
    report.cases.push(entry);
    const context = await gate.browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    let checkpoint, rejectStaleOnce = true;
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["warning", "error"].includes(message.type())) return;
      if (/Failed to load resource.*409/.test(message.text())) entry.expectedHttpErrors.push(message.text());
      else entry.errors.push(message.text());
    });
    await context.route("**/api/public/branding", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } });
    });
    await context.route("**/api/projects/**/ai/agent-**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path.endsWith("/agent-tools")) return route.fulfill({ json: { tools: [tool] } });
      if (request.method() === "POST" && path.endsWith("/agent-runs")) {
        checkpoint = waiting(project.id, request.postDataJSON().objective);
        return route.fulfill({ status: 202, json: checkpoint });
      }
      if (request.method() === "POST" && path.endsWith("/resume")) {
        const body = request.postDataJSON(); entry.actions.push(body);
        assert.equal(body.expectedRevision, checkpoint.revision);
        if (checkpoint.status === "awaiting-input") {
          assert.equal(body.selectionId, "line-b");
          await new Promise(done => setTimeout(done, 250));
          checkpoint = failed(checkpoint);
        } else if (rejectStaleOnce) {
          rejectStaleOnce = false;
          return route.fulfill({ status: 409, json: { message: "检查点已更新，请刷新后再继续", code: "checkpoint-conflict" } });
        } else {
          assert.equal(body.selectionId, undefined);
          checkpoint = { ...checkpoint, status: "completed", revision: checkpoint.revision + 2, failure: undefined,
            decisionRecoveries: [{ revision: checkpoint.revision, resumedAt: "2026-09-05", failure: checkpoint.failure }],
            completion: { kind: "finish", rationale: "已读取证据", summary: "产线 B 温度为 25°C，保留原查询结果。", decisionStatus: "production", evidenceIds: ["read-1"] } };
        }
      }
      return route.fulfill({ json: checkpoint });
    });
    const open = async () => {
      await page.getByRole("button", { name: "AI 助手", exact: true }).click();
      await page.getByRole("tab", { name: "执行任务", exact: true }).click();
      return page.getByRole("region", { name: "工业 Agent 工作区" });
    };
    const screenshot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`), fullPage: true });
    try {
      await gate.loginPage(page);
      await page.getByLabel("当前项目", { exact: true }).selectOption(project.id);
      let workspace = await open();
      await workspace.getByRole("textbox").fill("检查设备温度，选择明确的数据源后给出证据");
      await workspace.getByRole("button", { name: "预览并运行", exact: true }).click();
      await workspace.getByRole("region", { name: "选择数据源", exact: true }).waitFor();
      await screenshot("choices");
      entry.contrast = await workspace.evaluate(collectTextContrast, ".industrial-agent-selection strong, .industrial-agent-selection small, .industrial-agent-selection code");
      assert.ok(entry.contrast.length >= 5 && entry.contrast.every(item => item.contrast >= 4.5), JSON.stringify(entry.contrast));
      await page.reload(); workspace = await open();
      await workspace.getByRole("region", { name: "选择数据源", exact: true }).waitFor();
      const choice = workspace.getByRole("button", { name: /产线 B/ });
      await choice.focus(); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
      await workspace.getByRole("button", { name: "重试决策并继续", exact: true }).waitFor();
      assert.equal(entry.actions.length, 1);
      entry.recoveryContrast = await workspace.evaluate(collectTextContrast, ".industrial-agent-approval strong, .industrial-agent-approval small, .industrial-agent-approval button, .industrial-agent-notice, .industrial-agent-error strong");
      assert.ok(entry.recoveryContrast.every(item => item.contrast >= 4.5), JSON.stringify(entry.recoveryContrast));
      await screenshot("provider-failed");
      await page.reload(); workspace = await open();
      await workspace.getByRole("button", { name: "重试决策并继续", exact: true }).click();
      await workspace.getByText("检查点已更新，请刷新后再继续", { exact: true }).waitFor();
      await workspace.getByRole("button", { name: "刷新", exact: true }).click();
      await workspace.getByRole("button", { name: "重试决策并继续", exact: true }).click();
      await workspace.getByText("产线 B 温度为 25°C，保留原查询结果。", { exact: true }).waitFor();
      await page.waitForFunction(() => {
        const bar = document.querySelector(".industrial-agent-progress");
        return bar && bar.firstElementChild.getBoundingClientRect().width >= bar.getBoundingClientRect().width * .99;
      });
      assert.equal(checkpoint.toolRecords.length, 1);
      assert.equal(checkpoint.id, `fixture-${project.id}`);
      await screenshot("completed");
      const overflow = await workspace.evaluate(element => element.scrollWidth > element.clientWidth + 1);
      assert.equal(overflow, false); assert.deepEqual(entry.errors, []);
      entry.passed = true;
    } catch (error) { entry.failure = String(error); await screenshot("failed"); }
    finally { await context.close(); }
  }
} finally {
  await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2));
  await gate.close();
}
console.log(JSON.stringify({ output: gate.output, ...report }, null, 2));
assert.ok(report.cases.every(entry => entry.passed), `See ${gate.output}`);

function waiting(projectId, objective) {
  return { schemaVersion: 1, id: `fixture-${projectId}`, projectId, principal: "fixture", objective, context: {}, status: "awaiting-input",
    budget: { maxSteps: 10, maxToolCalls: 6, maxDurationMs: 90000 }, usage: { steps: 1, toolCalls: 0, activeDurationMs: 100 },
    allowedToolIds: [tool.id], decisions: [], toolRecords: [], seenToolFingerprints: [], revision: 2,
    createdAt: "2026-09-05", updatedAt: "2026-09-05", pendingSelection: { step: 1, question: "两个数据源都包含设备温度，请选择产线", options: [
      { id: "line-a", label: "产线 A · 电机温度", description: "设备名称 · 温度 · 时间" }, { id: "line-b", label: "产线 B · 电机温度", description: "设备名称 · 温度 · 时间" },
    ] } };
}
function failed(checkpoint) {
  return { ...checkpoint, revision: 4, status: "failed", pendingSelection: undefined,
    selections: [{ step: 1, option: checkpoint.pendingSelection.options[1], selectedBy: "fixture", selectedAt: "2026-09-05" }],
    failure: { code: "decision-provider-unavailable", phase: "decision", retryable: true, message: "上游请求失败：HTTP 504" },
    usage: { ...checkpoint.usage, steps: 2, toolCalls: 1 }, seenToolFingerprints: ["read-fingerprint"],
    toolRecords: [{ step: 2, effect: "read", fingerprint: "read-fingerprint", startedAt: "2026-09-05", completedAt: "2026-09-05",
      call: { toolId: tool.id, arguments: {}, resources: [{ kind: "project", id: checkpoint.projectId }] },
      outcome: { status: "completed", evidence: [{ id: "read-1", kind: "data", label: "产线 B 温度证据", source: "受控查询" }], verificationEvidence: [] } }] };
}
