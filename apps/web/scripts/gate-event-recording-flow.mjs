import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

// Focused product CI, using the same browser runtime as gate-product-browser.
// Services are supplied by the caller; require an explicitly isolated test server.
if (process.env.C4_RECORDING_TEST_SERVER !== "isolated") throw Error("Set C4_RECORDING_TEST_SERVER=isolated only for a disposable test API");
const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const output = resolve(repo, "test-output/c4-recording"); mkdirSync(output, { recursive: true });
const origin = process.env.C4_RECORDING_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const apiOrigin = process.env.C4_RECORDING_API_ORIGIN ?? "http://127.0.0.1:4100";
const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const sourcePaths = ["apps/api/src/index.ts", "apps/api/src/productionDataEvents.ts", "apps/web/src/components/OperationsCenter.tsx", "apps/web/src/components/EventRecordingPanel.tsx", "apps/web/src/components/eventRecordingPanelModel.ts", "apps/web/src/components/EventRecordingPanel.css", "apps/web/scripts/gate-event-recording-flow.mjs"];
const sourceHashes = Object.fromEntries(sourcePaths.map(path => [path, createHash("sha256").update(readFileSync(resolve(repo, path))).digest("hex")]));
const report = { createdAt: new Date().toISOString(), scope: "actual OperationsCenter recording UI and production REST; isolated JSON metadata", sourceHashes, rounds: [], errors: [] };
let page;
try {
  for (let round = 1; round <= 2; round++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true, reducedMotion: "reduce" });
    try {
      page = await context.newPage(); page.setDefaultTimeout(30_000);
      page.on("pageerror", error => report.errors.push(error.message));
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.getByLabel("用户名").fill("admin"); await page.getByLabel("密码").fill(process.env.BIM_STUDIO_ADMIN_PASSWORD ?? "admin");
      const loginResponse = page.waitForResponse(response => response.url().endsWith("/api/auth/login") && response.request().method() === "POST");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      const login = await (await loginResponse).json();
      const headers = { Authorization: `Bearer ${login.token}` };
      await page.locator(".scene-manager-page").waitFor({ state: "visible" });
      await page.locator('summary[aria-label="项目管理"]').click();
      await page.getByRole("button", { name: "新建项目", exact: true }).click();
      await page.getByLabel("项目名称").fill(`C4录制验收-${Date.now()}-r${round}`);
      const projectResponse = page.waitForResponse(response => response.url().endsWith("/api/projects") && response.request().method() === "POST");
      await page.getByRole("button", { name: "创建并切换", exact: true }).click();
      const project = await (await projectResponse).json(); assert.ok(project.id);
      const studyResponse = await context.request.post(`${apiOrigin}/api/projects/${project.id}/operations/logistics/des-studies`, { headers, data: { name: "C4真实仿真证据", templateId: "agv-line-v1", seed: "c4-recording", replications: 2, agvCount: 2, bufferCapacity: 4 } });
      assert.equal(studyResponse.status(), 200, await studyResponse.text());
      await page.getByRole("button", { name: "智能运营", exact: true }).click();
      await page.getByRole("button", { name: "现场监控", exact: true }).click();
      const panel = page.getByRole("region", { name: "事件持久录制" }); await panel.waitFor();
      await panel.getByText("读取录制完成", { exact: true }).waitFor();
      await panel.scrollIntoViewIfNeeded(); await panel.screenshot({ path: resolve(output, `r${round}-01-empty-dark-1280.png`) });
      await panel.locator("summary").filter({ hasText: "可选帧映射" }).click();
      await panel.getByLabel("固定帧步长（ms）").fill("100");
      const openedResponse = page.waitForResponse(response => response.url().endsWith(`/projects/${project.id}/data/recordings`) && response.request().method() === "POST");
      await panel.getByRole("button", { name: "建立录制", exact: true }).click();
      const opened = await (await openedResponse).json(); const id = opened.recording.manifest.recordingId;
      await panel.getByText("建立录制完成", { exact: true }).waitFor();
      await panel.locator("summary").filter({ hasText: "写入一条事件" }).click();
      const epoch = Date.parse(opened.recording.manifest.startedAt);
      for (const [sequence, offset] of [[1, 150], [3, 220], [2, 250]]) {
        await panel.getByLabel("录制事件 JSON").fill(JSON.stringify({ source: "manual/plc", key: "temperature", value: sequence + 25, sequence, timestamp: new Date(epoch + offset).toISOString() }));
        await panel.getByRole("button", { name: "写入并落盘", exact: true }).click(); await panel.getByText("写入事件完成", { exact: true }).waitFor();
      }
      await panel.getByText("存在缺口或乱序", { exact: true }).waitFor();
      await panel.getByRole("button", { name: "关闭录制段", exact: true }).click(); await panel.getByText("关闭录制段完成", { exact: true }).waitFor();
      await panel.screenshot({ path: resolve(output, `r${round}-02-gapped-dark-1280.png`) });
      // A real page reload loses component state: history must come from production disk storage.
      await page.reload({ waitUntil: "networkidle" });
      if (!(await page.locator(".operations-page").isVisible())) await page.getByRole("button", { name: "智能运营", exact: true }).click();
      await page.getByRole("button", { name: "现场监控", exact: true }).click();
      await panel.getByText("读取录制完成", { exact: true }).waitFor(); await panel.getByLabel("历史录制").selectOption(id);
      await panel.getByText("读取历史完成", { exact: true }).waitFor();
      await panel.locator("summary").filter({ hasText: "重开录制段" }).click();
      await panel.getByLabel("重开出处 JSON").fill(JSON.stringify({ connectionId: "manual-origin", generation: 1, lastSequence: 3, lastTimestamp: new Date(epoch + 220).toISOString() }));
      await panel.getByRole("button", { name: "手工重开", exact: true }).click(); await panel.getByText("重开录制段完成", { exact: true }).waitFor();
      await panel.getByLabel("录制事件 JSON").fill('{"source":"manual/plc","key":"temperature","value":29}');
      await panel.getByRole("button", { name: "写入并落盘", exact: true }).click(); await panel.getByText("写入事件完成", { exact: true }).waitFor();
      await panel.getByText("源序未知 · 到达序不代表源序", { exact: true }).waitFor();
      await panel.getByLabel("回放对齐").selectOption("sequence"); await panel.getByLabel("对齐起始").fill("1"); await panel.getByLabel("对齐终止").fill("3");
      await panel.getByText("匹配 2 条，展示前 100 条；回放检查只读，不向设备重发事件。", { exact: true }).waitFor();
      await panel.getByLabel("回放对齐").selectOption("frame"); await panel.getByLabel("对齐起始").fill("1");
      await panel.getByText("匹配 1 条，展示前 100 条；回放检查只读，不向设备重发事件。", { exact: true }).waitFor();
      await panel.getByLabel("回放对齐").selectOption("time");
      const timeWindow = await page.evaluate(epoch => {
        const format = value => new Date(value).toLocaleString("sv-SE", { hour12: false }).replace(" ", "T");
        return { from: format(epoch - 1000), to: format(epoch + 1000) };
      }, epoch);
      await panel.getByLabel("对齐起始").fill(timeWindow.from); await panel.getByLabel("对齐终止").fill(timeWindow.to);
      await page.waitForFunction(() => [...document.querySelectorAll(".event-recording tbody td:nth-child(2)")].map(cell => cell.textContent).join(",") === "1,3");
      await panel.getByLabel("回放对齐").selectOption("all");
      await panel.locator("summary").filter({ hasText: "Study 证据副本" }).click();
      const studies = await panel.getByLabel("运行记录").locator("option").evaluateAll(options => options.filter(option => option.value).map(option => option.value));
      assert.ok(studies.length); await panel.getByLabel("运行记录").selectOption(studies[0]);
      const downloadPromise = page.waitForEvent("download"); await panel.getByRole("button", { name: "导出证据副本", exact: true }).click();
      const download = await downloadPromise; const path = resolve(output, `r${round}-study-evidence.json`); await download.saveAs(path);
      const evidence = JSON.parse(readFileSync(path, "utf8"));
      assert.ok(evidence.assessment.integrityOk); assert.equal(evidence.recording.manifest.recordingId, id);
      assert.ok(evidence.study.result.evidenceRefs.some(ref => ref.startsWith(`event-recording:${id}@`)));
      await panel.screenshot({ path: resolve(output, `r${round}-03-study-dark-1280.png`) });
      await page.setViewportSize({ width: 480, height: 900 });
      await panel.scrollIntoViewIfNeeded(); await panel.screenshot({ path: resolve(output, `r${round}-04-dark-480.png`) });
      const narrow = await panel.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, pageWidth: document.documentElement.clientWidth, pageScrollWidth: document.documentElement.scrollWidth }));
      assert.ok(narrow.scrollWidth <= narrow.width + 1, JSON.stringify(narrow));
      await capturePanelHeader(page, panel, resolve(output, `r${round}-04-dark-480-header.png`));
      // Test appearance only, in a disposable context; use the production theme attribute.
      await page.evaluate(() => document.documentElement.dataset.theme = "light");
      await panel.screenshot({ path: resolve(output, `r${round}-05-light-480.png`) });
      await capturePanelHeader(page, panel, resolve(output, `r${round}-05-light-480-header.png`));
      await page.setViewportSize({ width: 1280, height: 900 }); await panel.screenshot({ path: resolve(output, `r${round}-06-light-1280.png`) });
      const reread = await context.request.get(`${apiOrigin}/api/projects/${project.id}/data/recordings/${id}`, { headers });
      assert.equal(reread.status(), 200); const persisted = await reread.json();
      assert.equal(persisted.recording.segments.length, 2); assert.equal(persisted.assessment.totals.eventCount, 3);
      assert.equal(persisted.assessment.totals.outOfOrderCount, 1); assert.equal(persisted.assessment.totals.seamCount, 1);
      assert.equal(persisted.assessment.integrity.sourceSequenceKnown, false);
      report.rounds.push({ round, projectId: project.id, recordingId: id, persisted: persisted.assessment, studyRef: evidence.study.result.evidenceRefs.find(ref => ref.startsWith("event-recording:")), narrow });
    } catch (error) {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: resolve(output, `r${round}-failure.png`), fullPage: true }).catch(() => {});
        writeFileSync(resolve(output, `r${round}-failure.txt`), await page.locator("body").innerText());
      }
      throw error;
    } finally { await context.close(); }
  }
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.failure = error.message;
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally { writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`); await browser.close(); }
console.log(`[c4-recording] passed two production rounds; evidence ${output}`);

async function capturePanelHeader(page, panel, path) {
  // The existing sticky OperationsTabs remains visible. Scroll the real container
  // to include the panel heading, rather than hiding navigation to create evidence.
  await panel.evaluate(element => {
    element.scrollIntoView({ block: "start" });
    let parent = element.parentElement;
    while (parent && parent.scrollHeight <= parent.clientHeight) parent = parent.parentElement;
    if (parent) parent.scrollTop -= 88;
  });
  await page.screenshot({ path, fullPage: true });
}
