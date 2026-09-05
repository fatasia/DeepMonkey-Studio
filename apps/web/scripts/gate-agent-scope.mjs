import assert from "node:assert/strict";
import { collectTextContrast } from "./browserTextContrast.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = "http://127.0.0.1:5173";
const output = fileURLToPath(new URL("../../../test-output/codex-2026-09-05/agent-scope/", import.meta.url));
await mkdir(output, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const report = { createdAt: new Date().toISOString(), boundary: "Agent responses are isolated fixtures; no actual model or tool execution", cases: [] };
try {
  for (const width of [1440, 980]) for (const theme of ["dark", "light"]) {
    const entry = { width, theme, errors: [], writes: [] };
    report.cases.push(entry);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/api/public/branding", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } });
    });
    const pending = [];
    let heldCatalogProject, heldStartProject, heldPoll = false;
    const hold = async (route, kind, project) => {
      let release;
      const ready = new Promise(resolve => { release = resolve; });
      pending.push({ kind, project, release });
      await ready;
      await route.fulfill({ json: kind === "catalog" ? { tools: [tool(project)] } : checkpoint(project) }).catch(() => undefined);
    };
    await context.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const agent = path.match(/^\/api\/projects\/([^/]+)\/ai\/(agent-tools|agent-runs)(.*)$/);
      if (agent) {
        const [, project, resource] = agent;
        if (resource === "agent-tools") {
          if (project === heldCatalogProject) return hold(route, "catalog", project);
          return route.fulfill({ json: { tools: [tool(project)] } });
        }
        if (request.method() === "POST" && project === heldStartProject) return hold(route, "start", project);
        if (request.method() === "GET" && heldPoll) return hold(route, "poll", project);
        return route.fulfill({ json: checkpoint(project, request.method() === "DELETE" ? "cancelled" : "running") });
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && path !== "/api/auth/login") {
        entry.writes.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 409, json: { message: "Unexpected write blocked" } });
      }
      return route.fallback();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on("pageerror", e => entry.errors.push(e.message));
    page.on("console", m => { if (["warning", "error"].includes(m.type())) entry.errors.push(m.text()); });
    const waitHeld = async kind => {
      const deadline = Date.now() + 10000;
      while (!pending.some(p => p.kind === kind) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
      const item = pending.find(p => p.kind === kind);
      assert.ok(item, `Missing held ${kind}`);
      return item;
    };
    try {
      await page.goto(`${origin}/manager`);
      await page.getByLabel("用户名", { exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill("admin");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      const projects = page.getByLabel("当前项目");
      await projects.selectOption({ label: "智造综合案例验证" });
      const first = await projects.inputValue();
      heldCatalogProject = first;
      await page.getByRole("button", { name: "AI 助手", exact: true }).click();
      await page.getByRole("tab", { name: "执行任务", exact: true }).click();
      const catalog = await waitHeld("catalog");
      await projects.selectOption({ label: "QA 回归检查 20260905" });
      const second = await projects.inputValue();
      const workspace = page.getByRole("region", { name: "工业 Agent 工作区" });
      await workspace.locator(".industrial-agent-capabilities > summary").click();
      await workspace.getByText(tool(second).label, { exact: true }).waitFor();
      catalog.release();
      await workspace.getByRole("textbox").fill("QA delayed start");
      heldStartProject = second;
      await workspace.getByRole("button", { name: "预览并运行", exact: true }).dblclick();
      const start = await waitHeld("start");
      assert.equal(pending.filter(p => p.kind === "start").length, 1);
      heldCatalogProject = undefined;
      await projects.selectOption(first);
      await workspace.getByText(tool(first).label, { exact: true }).waitFor();
      start.release();
      assert.equal(await workspace.getByRole("textbox").inputValue(), "");
      await workspace.getByRole("textbox").fill("QA current project");
      heldStartProject = undefined;
      heldPoll = true;
      await workspace.getByRole("button", { name: "预览并运行", exact: true }).click();
      const poll = await waitHeld("poll");
      await workspace.getByRole("button", { name: "取消", exact: true }).click();
      await workspace.getByRole("button", { name: "开始新任务", exact: true }).waitFor();
      poll.release();
      assert.equal(await workspace.locator(".industrial-agent-status small").innerText(), `QA ${first}`);
      await workspace.getByRole("button", { name: "开始新任务", exact: true }).click();
      await workspace.getByRole("textbox").fill("保留下一条目标");
      assert.equal(await workspace.locator(".industrial-agent-run").count(), 0);
      assert.equal(await workspace.getByText(tool(second).label, { exact: true }).count(), 0);
      await page.screenshot({ path: `${output}${theme}-${width}.png` });
      entry.contrast = await workspace.evaluate(collectTextContrast, ".industrial-agent-heading strong, .industrial-agent-heading small, .industrial-agent-start > label > span, .industrial-agent-capabilities summary strong, .industrial-agent-examples button, button.primary");
      assert.ok(entry.contrast.length >= 5 && entry.contrast.every(item => item.contrast >= 4.5 && item.fontSize >= 11), JSON.stringify(entry.contrast));
      assert.notEqual(await workspace.locator("button.primary").evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)");
      assert.deepEqual(entry.errors, []);
      assert.deepEqual(entry.writes, []);
      entry.passed = true;
    } catch (error) { entry.failure = String(error); await page.screenshot({ path: `${output}${theme}-${width}-failed.png` }); }
    finally { pending.forEach(p => p.release()); await context.close(); }
  }
} finally { await browser.close(); await writeFile(`${output}report.json`, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
assert.ok(report.cases.every(item => item.passed), `See ${output}`);

function tool(project) { return { id: "qa.read", label: `只读能力 ${project}`, description: "QA no side effects", effect: "read", risk: "low", requiresApproval: false }; }
function checkpoint(projectId, status = "running") {
  return { schemaVersion: 1, id: `qa-${projectId}`, projectId, principal: "qa", objective: `QA ${projectId}`, context: {}, status,
    budget: { maxSteps: 10, maxToolCalls: 6, maxDurationMs: 90000 }, usage: { steps: 1, toolCalls: 0, activeDurationMs: 100 },
    allowedToolIds: ["qa.read"], decisions: [], toolRecords: [], seenToolFingerprints: [], createdAt: "2026-09-05T06:00:00Z", updatedAt: "2026-09-05T06:01:00Z", revision: status === "cancelled" ? 8 : 4 };
}
