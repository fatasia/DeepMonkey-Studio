import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

// 隔离浏览器真实登录；只注入 AI 传输响应，不调用模型、写入场景或改品牌配置。
const origin = process.env.BIM_STUDIO_QA_ORIGIN ?? "http://127.0.0.1:5173";
const output = fileURLToPath(new URL("../../../test-output/codex-2026-09-05/ai-lifecycle/", import.meta.url));
await mkdir(output, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const report = { createdAt: new Date().toISOString(), cases: [] };
try {
  for (const theme of ["dark", "light"]) for (const width of [1440, 980]) {
    const entry = { theme, width, passed: false, errors: [], unexpectedWrites: [] };
    report.cases.push(entry);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/api/public/branding", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", e => entry.errors.push(e.message));
    page.on("console", m => { if (["warning", "error"].includes(m.type())) entry.errors.push(m.text()); });
    page.on("request", r => {
      if (!["GET", "HEAD", "OPTIONS"].includes(r.method()) && !/\/api\/(auth\/login|ai\/assistant\/stream|projects\/[^/]+\/capabilities\/invoke)$/.test(r.url())) entry.unexpectedWrites.push(`${r.method()} ${r.url()}`);
    });
    const streams = [], capabilities = [];
    const held = queue => async route => {
      let release;
      const response = new Promise(resolve => { release = resolve; });
      queue.push({ body: route.request().postDataJSON(), release });
      const payload = await response;
      await route.fulfill(payload).catch(() => undefined); // 已取消的请求允许无法再写响应。
    };
    await page.route("**/api/ai/assistant/stream", held(streams));
    await page.route("**/api/projects/*/capabilities/invoke", held(capabilities));
    const prompt = page.getByRole("textbox", { name: "向 AI 助手提问", exact: true });
    const open = async () => {
      await page.getByRole("button", { name: "AI 助手", exact: true }).click();
      await prompt.waitFor();
    };
    const send = async text => { await prompt.fill(text); await prompt.press("Enter"); };
    const waitCount = async (queue, count) => {
      const until = Date.now() + 10000;
      while (queue.length < count && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(queue.length, count);
    };
    const shot = name => page.screenshot({ path: `${output}${theme}-${width}-${name}.png` });
    try {
      await page.goto(`${origin}/manager`);
      await page.getByRole("textbox", { name: "用户名", exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill("admin");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByLabel("当前项目").selectOption({ label: "智造综合案例验证" });
      await open();
      await send("第一条问题");
      await prompt.press("Enter");
      await waitCount(streams, 1);
      assert.equal(await prompt.inputValue(), "");
      await prompt.fill("下一条草稿");
      assert.equal(await page.getByRole("tab", { name: "执行任务", exact: true }).isDisabled(), true);
      await shot("pending-draft");
      streams[0].release(sse("第一条回答"));
      await page.locator(".ai-conversation-turn").filter({ hasText: "第一条回答" }).waitFor();
      assert.equal(await prompt.inputValue(), "下一条草稿");
      await send("待取消问题");
      await waitCount(streams, 2);
      await page.getByRole("button", { name: "停止生成", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "请求已停止" }).waitFor();
      await send("新一轮问题");
      await waitCount(streams, 3);
      streams[1].release(sse("过期回答不能出现"));
      assert.equal(await page.getByRole("button", { name: "停止生成", exact: true }).count(), 1);
      await prompt.fill("保留这条草稿");
      streams[2].release(sse("新一轮回答"));
      await page.locator(".ai-conversation-turn").filter({ hasText: "新一轮回答" }).waitFor();
      assert.equal(await prompt.inputValue(), "保留这条草稿");
      assert.equal(await page.getByText("过期回答不能出现", { exact: true }).count(), 0);
      await shot("completed-draft");
      await send("关闭时取消");
      await waitCount(streams, 4);
      await prompt.press("Escape");
      await open();
      streams[3].release(sse("关闭后的过期回答"));
      await page.getByRole("button", { name: "问数据", exact: true }).click();
      await send("读取温度");
      await waitCount(capabilities, 1);
      assert.equal(capabilities[0].body.capabilityId, "data.query.draft");
      await page.getByRole("button", { name: "停止生成", exact: true }).click();
      capabilities[0].release(json({ output: { planning: { plan: { datasetId: "fixture" } } }, warnings: [] }));
      await send("再次读取温度");
      await waitCount(capabilities, 2);
      assert.equal(capabilities[1].body.capabilityId, "data.query.draft", "已取消的 draft 不得触发 read");
      capabilities[1].release(json({ output: { planning: { plan: { datasetId: "fixture" } } }, warnings: [] }));
      await waitCount(capabilities, 3);
      assert.equal(capabilities[2].body.capabilityId, "data.query.read");
      await page.getByRole("button", { name: "停止生成", exact: true }).click();
      capabilities[2].release(json({ output: { datasetName: "过期 SQL 结果", columns: [], rows: [] }, evidence: [], warnings: [] }));
      await page.getByRole("button", { name: "全平台", exact: true }).click();
      await send("切项目时取消");
      await waitCount(streams, 5);
      await page.getByLabel("当前项目").selectOption({ label: "QA 回归检查 20260905" });
      streams[4].release(sse("旧项目结果"));
      await page.getByRole("button", { name: "发送", exact: true }).waitFor();
      assert.equal(await prompt.inputValue(), "");
      assert.equal(await page.locator(".ai-conversation-turn").count(), 0);
      assert.equal(await page.getByText(/过期 SQL 结果|旧项目结果|关闭后的过期回答/).count(), 0);
      await shot("project-reset");
      const bounds = await page.locator(".ai-assistant-panel").evaluate(e => {
        const r = e.getBoundingClientRect();
        return { left: r.left, right: r.right, height: r.height, scroll: e.scrollWidth, client: e.clientWidth };
      });
      assert.ok(bounds.left >= 0 && bounds.right <= width + 1 && bounds.scroll <= bounds.client + 1, JSON.stringify(bounds));
      assert.deepEqual(entry.errors, []);
      assert.deepEqual(entry.unexpectedWrites, []);
      Object.assign(entry, { passed: true, streamRequests: streams.length, capabilityRequests: capabilities.length, bounds });
    } catch (error) { entry.error = error.stack; await shot("failed"); }
    finally {
      streams.forEach(item => item.release(sse("已取消")));
      capabilities.forEach(item => item.release(json({})));
      await context.close();
    }
  }
} finally {
  await browser.close();
  await writeFile(`${output}report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
assert.ok(report.cases.length === 4 && report.cases.every(item => item.passed), `See ${output}report.json`);
function sse(text) { return { contentType: "text/event-stream", body: `event: done\ndata: ${JSON.stringify({ text, model: "isolated-qa" })}\n\n` }; }
function json(value) { return { contentType: "application/json", body: JSON.stringify(value) }; }
