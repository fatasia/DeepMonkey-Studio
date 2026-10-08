/**
 * P4-B5 浏览器验收(H-C7-P4 基准 B5:雾/环境切换经 lighting.set / environment.set 命令面)。
 *
 * 用法:node apps/web/scripts/p4-b5-lighting-acceptance.mjs <round>   (round = 1|2)
 * 产物:test-output/p4-b5-lighting-20261002/round<N>/*.png + report-round<N>.json
 *
 * 基建复用 isolatedStudioGate(独立端口/独立数据目录/OBJECT_STORE=local)。
 * 链路:MCP tools/call(editor.scene-transaction)→ 浏览器 driver → ViewerSceneCommandPort
 *   setLighting/setEnvironment(2026-10-02 实装)→ ViewerEngine setGlobalLighting/
 *   setSceneEnvironment/setWeather。验收 = 灯光强度/天气/环境强度三轴 + 保存重开保持
 *   + base64 截图 + 幂等回写零退化。
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir as mkdirAsync } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";

const round = Number(process.argv[2] ?? "1");
assert.ok(round === 1 || round === 2, "用法:node p4-b5-lighting-acceptance.mjs <1|2>");
const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const outputRoot = resolve(repositoryRoot, `test-output/p4-b5-lighting-20261002/round${round}`);
await mkdirAsync(outputRoot, { recursive: true });

const report = { round, startedAt: new Date().toISOString(), steps: [], assertions: [], screenshots: [], transactions: [], failures: [] };
const step = (id, detail) => { report.steps.push({ id, ...(detail ? { detail } : {}) }); console.log(`  ✓ ${id}${detail ? ` — ${JSON.stringify(detail)}` : ""}`); };
const check = (id, ok, detail) => {
  report.assertions.push({ id, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  if (!ok) report.failures.push(id);
  console.log(`  ${ok ? "✓" : "✗"} assert ${id}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  assert.ok(ok, `断言失败: ${id}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};
const shot = async (page, name) => {
  await page.screenshot({ path: resolve(outputRoot, `${name}.png`) });
  report.screenshots.push(`test-output/p4-b5-lighting-20261002/round${round}/${name}.png`);
};
/** 画布平均亮度（0-1）：页面内解码截图像素，为灯光/背景切换提供确定性视觉证据。 */
const averageLuminance = async (page) => {
  const base64 = await page.locator('.viewport canvas:not([aria-hidden="true"])').first().screenshot({ type: "png" });
  return page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await new Promise((resolveLoad, rejectLoad) => { image.onload = resolveLoad; image.onerror = () => rejectLoad(new Error("截图解码失败")); });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let total = 0;
    for (let index = 0; index < data.length; index += 4) total += 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
    return total / (data.length / 4) / 255;
  }, base64.toString("base64"));
};

const gate = await createIsolatedStudioGate("p4-b5-lighting-acceptance");
let page;
let mcpCallCount = 0;
try {
  const context = await gate.browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // 深色主题锁定。
  await page.route("**/api/public/branding", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), themeMode: "dark" } });
  });

  /* ---------------- 场景准备 ---------------- */
  const project = await gate.json("POST", "/api/projects", { name: `P4-B5 验收-轮${round}` });
  await gate.loginPage(page);
  await page.getByLabel("当前项目").selectOption(project.id);
  await page.getByRole("button", { name: "项目场景", exact: true }).click();
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("P4-B5 验收场景");
  const application = await (async () => {
    const response = page.waitForResponse((candidate) =>
      candidate.url().includes(`/api/projects/${project.id}/applications`) && candidate.request().method() === "POST");
    await page.getByRole("button", { name: "创建并进入" }).click();
    return response.then((entry) => entry.json());
  })();
  const scene = application.scenes?.[0];
  check("scene-created", Boolean(scene?.id && application.metadata?.id), { projectId: project.id, sceneId: scene?.id });
  const sceneEditorUrl = `${gate.origin}/studio/${encodeURIComponent(project.id)}/applications/${encodeURIComponent(application.metadata.id)}/scenes/${encodeURIComponent(scene.id)}`;
  await page.goto(sceneEditorUrl, { waitUntil: "networkidle", timeout: 90_000 });
  await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor();
  const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  check("dark-theme", theme !== "light", { theme });
  step("scene-editor-ready");

  /* ---------------- MCP 事务提交 helpers ---------------- */
  // 1) 发现 active-editor 会话(resources/list → editorResource URI 带 sessionId)。
  const mcpRpc = async (method, params) => {
    const response = await gate.client.fetch("/api/mcp", {
      method: "POST",
      data: { jsonrpc: "2.0", id: ++mcpCallCount, method, ...(params ? { params } : {}) },
    });
    assert.ok(response.ok(), `MCP ${method}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  // 会话在页面 reload 后重建(sessionId 随浏览器重新生成),所以可变并在轴 4 重发现。
  let editorResource;
  let sessionId;
  let draftRevision;
  const rediscoverActiveEditor = async (label) => {
    const listedNow = await mcpRpc("resources/list", {});
    editorResource = (listedNow.result?.resources ?? []).find((entry) =>
      typeof entry.uri === "string" && entry.uri.startsWith("studio://active-editor/"));
    check(`active-editor-found:${label}`, Boolean(editorResource?.uri), { uri: editorResource?.uri });
    const summaryBodyNow = await mcpRpc("resources/read", { uri: editorResource.uri });
    const summaryNow = JSON.parse(summaryBodyNow.result?.contents?.[0]?.text ?? "{}");
    sessionId = summaryNow.sessionId;
    check(`active-editor-summary:${label}`, Boolean(sessionId) && summaryNow.schema === "deep-monkey.active-editor.v1",
      { sessionId, schema: summaryNow.schema, draftRevision: summaryNow.draftRevision });
    draftRevision = Number(summaryNow.draftRevision ?? 0);
    return summaryNow;
  };
  const firstSummary = await rediscoverActiveEditor("initial");
  check("active-editor-found", Boolean(editorResource?.uri), { uri: editorResource?.uri });
  /** draftRevision 读证：命令进入浏览器 draft（persisted 不随命令变化，保存后才提交）。
   * summary 资源按 revision 寻址,事务后旧 URI 过期,每次重新 list 取最新 URI。 */
  const readDraftRevision = async () => {
    const listedNow = await mcpRpc("resources/list", {});
    const uriNow = (listedNow.result?.resources ?? []).find((entry) =>
      typeof entry.uri === "string" && entry.uri.startsWith("studio://active-editor/"))?.uri;
    assert.ok(uriNow, "active-editor 资源消失");
    const body = await mcpRpc("resources/read", { uri: uriNow });
    return Number(JSON.parse(body.result?.contents?.[0]?.text ?? "{}").draftRevision ?? -1);
  };

  // 2) 读 active-editor scene-context 拿对象清单(验证读链)。
  const sceneContextUri = editorResource.uri.replace(/\?.*$/, "")
    + `/scene-context/scene-objects?revision=${firstSummary.draftRevision}&persistedRevision=${firstSummary.persistedRevision}&page=0`;
  const contextBody = await mcpRpc("resources/read", { uri: sceneContextUri });
  const contextText = contextBody.result?.contents?.[0]?.text ?? "";
  let contextJson;
  try { contextJson = JSON.parse(contextText); } catch { contextJson = contextText.slice(0, 200); }
  const contextIsArray = Array.isArray(contextJson);
  const contextItems = contextIsArray ? contextJson.length : (contextJson.items?.length ?? contextJson.total ?? 0);
  check("scene-context-read", contextText.length > 0, { isArray: contextIsArray, items: contextItems, preview: typeof contextJson === "string" ? contextJson : Object.keys(contextJson).slice(0, 5) });

  // 3) 事务提交(tools/call editor.scene-transaction)。
  // CAS 合同:baseRevision 必须来自刚读取的活跃编辑器资源,每次提交前实时读基准。
  const submitTransaction = async (id, commands) => {
    draftRevision = await readDraftRevision();
    const rpc = await mcpRpc("tools/call", {
      name: "editor.scene-transaction",
      arguments: {
        projectId: project.id,
        sessionId,
        transaction: { id, sceneId: scene.id, baseRevision: draftRevision, commands },
      },
    });
    const payload = rpc.result ?? {};
    const structured = payload.structuredContent ?? payload;
    if (structured.status !== "committed") {
      console.log("  [debug] rpc.result keys:", Object.keys(payload), "structured:", JSON.stringify(structured));
    }
    report.transactions.push({ id, status: structured.status });
    assert.ok(structured.status === "committed", `事务 ${id} 状态 ${structured.status}: ${JSON.stringify(structured.issue ?? "").slice(0, 300)}`);
    return structured;
  };

  /* ---------------- 轴 1:灯光强度(lighting.set intensity) ---------------- */
  // 读证通道:draft 命令只进浏览器草稿(persisted 保存前不变,负控),
  // 生效=draftRevision 前进+事务 committed;持久化数值断言在轴 4 保存重载后。
  const luminanceBaseline = await averageLuminance(page);
  await submitTransaction("b5-lighting", [
    { id: "b5-l1", type: "lighting.set", sceneId: scene.id, patch: { intensity: 0.4, globalIlluminationEnabled: true } },
  ]);
  await page.waitForTimeout(800);
  await shot(page, "01-lighting-dimmed");
  const lightingDraftRevision = await readDraftRevision();
  check("lighting-draft-advanced", lightingDraftRevision > firstSummary.draftRevision, { draftRevision: lightingDraftRevision, base: firstSummary.draftRevision });
  const persistedAfterLighting = await gate.json("GET", `/api/projects/${project.id}/scenes/${scene.id}`);
  check("persisted-unchanged-before-save", persistedAfterLighting.lighting?.intensity !== 0.4, { persistedIntensity: persistedAfterLighting.lighting?.intensity });
  const luminanceDimmed = await averageLuminance(page);
  step("axis1-lighting", { luminanceBaseline, luminanceDimmed });

  /* ---------------- 轴 2:天气(environment.set weather) ---------------- */
  await submitTransaction("b5-weather", [
    { id: "b5-e1", type: "environment.set", sceneId: scene.id, patch: { weather: "fog" } },
  ]);
  await page.waitForTimeout(800);
  await shot(page, "02-weather-fog");
  const weatherDraftRevision = await readDraftRevision();
  check("weather-draft-advanced", weatherDraftRevision > lightingDraftRevision, { draftRevision: weatherDraftRevision });
  const luminanceFog = await averageLuminance(page);
  step("axis2-weather", { luminanceFog });

  /* ---------------- 轴 3:环境强度+背景色 ---------------- */
  await submitTransaction("b5-env", [
    { id: "b5-e2", type: "environment.set", sceneId: scene.id, patch: { environmentIntensity: 1.4, backgroundColor: "#101418" } },
  ]);
  await page.waitForTimeout(800);
  await shot(page, "03-env-intensity");
  const envDraftRevision = await readDraftRevision();
  check("env-draft-advanced", envDraftRevision > weatherDraftRevision, { draftRevision: envDraftRevision });
  const luminanceDark = await averageLuminance(page);
  step("axis3-environment", { luminanceDark });

  /* ---------------- 轴 4:保存重开保持(持久化数值主断言) ---------------- */
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await page.waitForTimeout(2500);
  const saved = await gate.json("GET", `/api/projects/${project.id}/scenes/${scene.id}`);
  check("save-lighting-persisted", saved.lighting?.intensity === 0.4 && saved.lighting?.globalIlluminationEnabled === true, { intensity: saved.lighting?.intensity });
  check("save-weather-persisted", saved.weather === "fog", { weather: saved.weather });
  check("save-env-persisted", saved.environment?.environmentIntensity === 1.4 && saved.environment?.backgroundColor === "#101418",
    { intensity: saved.environment?.environmentIntensity, bg: saved.environment?.backgroundColor });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  await shot(page, "04-after-reload");
  // reload 后浏览器重建编辑器会话,重发现 active-editor(轴 5 事务用新会话)。
  await rediscoverActiveEditor("after-reload");
  const reloadedDraftRevision = draftRevision;
  const afterReload = await gate.json("GET", `/api/projects/${project.id}/scenes/${scene.id}`);
  check("reload-lighting-kept", afterReload.lighting?.intensity === 0.4 && afterReload.lighting?.globalIlluminationEnabled === true, { intensity: afterReload.lighting?.intensity });
  check("reload-weather-kept", afterReload.weather === "fog", { weather: afterReload.weather });
  check("reload-env-kept", afterReload.environment?.environmentIntensity === 1.4 && afterReload.environment?.backgroundColor === "#101418", {});
  const luminanceReloaded = await averageLuminance(page);
  step("axis4-reload-kept", { luminanceDark, luminanceReloaded });

  /* ---------------- 轴 5:混批(lighting.set+environment.set)幂等回写零退化 ---------------- */
  const idempotent = await submitTransaction("b5-idempotent", [
    { id: "b5-l2", type: "lighting.set", sceneId: scene.id, patch: { intensity: 0.4 } },
    { id: "b5-e3", type: "environment.set", sceneId: scene.id, patch: { weather: "fog" } },
  ]);
  const idempotentReceipt = idempotent.receipt ?? {};
  check("mixed-batch-command-ids", JSON.stringify(idempotentReceipt.commandIds) === JSON.stringify(["b5-l2", "b5-e3"]), { commandIds: idempotentReceipt.commandIds });
  await page.waitForTimeout(800);
  await shot(page, "05-idempotent-mixed-batch");
  const idempotentDraftRevision = await readDraftRevision();
  check("idempotent-draft-advanced", idempotentDraftRevision > reloadedDraftRevision, { draftRevision: idempotentDraftRevision, base: reloadedDraftRevision });
  check("no-page-errors", pageErrors.length === 0, { errors: pageErrors.slice(0, 3) });
  step("axis5-idempotent");

  report.finishedAt = new Date().toISOString();
  report.passed = report.failures.length === 0;
  writeFileSync(resolve(outputRoot, `report-round${round}.json`), JSON.stringify(report, null, 1));
  console.log(`round ${round}: ${report.passed ? "PASS" : "FAIL"}(${report.assertions.filter(a => a.ok).length}/${report.assertions.length})`);
  if (!report.passed) process.exitCode = 1;
} finally {
  await gate.close().catch(() => {});
}
