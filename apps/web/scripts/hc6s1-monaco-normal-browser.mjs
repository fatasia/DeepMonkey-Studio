/**
 * H-C6-S1 Monaco 常态路径自动化验收(此前 UI wiring 刀走的是降级编辑器)。
 *
 * 用法:node apps/web/scripts/hc6s1-monaco-normal-browser.mjs
 * 产物:test-output/hc6s1-monaco-20261003/*.png + report.json
 *
 * Leg(真实产品链):隔离 gate(独立端口/数据目录)→ 登录 → 建项目/场景 → Studio →
 *   工具坞「仿真与开发 → 行为脚本」→ 新建脚本 → 断言 Monaco 常态(.monaco-editor 在场、
 *   降级 fallback 不在场)→ Monaco 内输入带类型错误的代码 → 智能诊断出现(problems)→
 *   修正 → 保存成功 → 保存后面板保持。
 * 截图 1280×1080 深色(显式锁定)。
 */
import assert from "node:assert/strict";
import { mkdir as mkdirAsync } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const outputDirectory = "test-output/hc6s1-monaco-20261003";
const outputRoot = resolve(repositoryRoot, outputDirectory);
await mkdirAsync(outputRoot, { recursive: true });

const report = { startedAt: new Date().toISOString(), steps: [], assertions: [], screenshots: [], failures: [] };
const step = (id, detail) => { report.steps.push({ id, ...(detail ? { detail } : {}) }); console.log(`  ✓ ${id}${detail ? ` — ${JSON.stringify(detail)}` : ""}`); };
const check = (id, ok, detail) => {
  report.assertions.push({ id, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  if (!ok) report.failures.push(id);
  console.log(`  ${ok ? "✓" : "✗"} assert ${id}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  assert.ok(ok, `断言失败: ${id}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};
const shot = async (page, name) => {
  await page.screenshot({ path: resolve(outputRoot, `${name}.png`) });
  report.screenshots.push(`${outputDirectory}/${name}.png`);
  console.log(`  📷 ${name}.png`);
};

const gate = await createIsolatedStudioGate("hc6s1-monaco-normal", {});
let page;
const consoleErrors = [];
try {
  const context = await gate.browser.newContext({ viewport: { width: 1280, height: 1080 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("console", (entry) => {
    if (entry.type() !== "error") return;
    const location = entry.location()?.url ?? "";
    consoleErrors.push(`console: ${entry.text().slice(0, 160)} @ ${location.slice(0, 160)}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) consoleErrors.push(`http ${response.status()}: ${response.url().slice(0, 200)}`);
  });
  page.on("dialog", (dialog) => void dialog.accept());

  const project = await gate.json("POST", "/api/projects", { name: "HC6S1 Monaco 常态验收" });
  await gate.loginPage(page);
  await page.getByLabel("当前项目").selectOption(project.id);
  await page.getByRole("button", { name: "项目场景", exact: true }).click();
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("Monaco 常态场景");
  const applicationResponse = page.waitForResponse((candidate) =>
    candidate.url().includes(`/api/projects/${project.id}/applications`) && candidate.request().method() === "POST");
  await page.getByRole("button", { name: "创建并进入" }).click();
  const application = await (await applicationResponse).json();
  const scene = application.scenes?.[0];
  const studioUrl = `${gate.origin}/studio/${encodeURIComponent(project.id)}/applications/${encodeURIComponent(application.metadata.id)}/scenes/${encodeURIComponent(scene.id)}`;
  await page.goto(studioUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1200);
  step("studio-entered");

  // 行为脚本面板
  const developTrigger = page.getByRole("button", { name: "仿真与开发" });
  await developTrigger.click();
  await page.waitForTimeout(400);
  await page.locator("#scene-tool-menu-develop").getByRole("menuitem", { name: "行为脚本", exact: true }).click();
  await page.locator("section.behavior-panel").waitFor({ timeout: 30_000 });
  step("behavior-panel-open");

  // 新建脚本 → Monaco 常态断言(动态 import 首载较大,放宽超时)
  await page.locator(".behavior-script-list").getByRole("button", { name: "新建", exact: true }).click();
  await page.locator(".monaco-editor").first().waitFor({ timeout: 120_000 });
  check("monaco-normal-loaded", await page.locator(".monaco-editor").count() > 0);
  check("no-fallback", await page.locator(".professional-code-fallback").count() === 0);
  await page.waitForTimeout(800);
  await shot(page, "01-monaco-normal");

  // Monaco 内输入带类型错误的代码 → 智能诊断出现(错误波浪线或 problems 面板;worker 崩溃时两者皆空)
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.type("const speed: number = ;");
  await page.waitForTimeout(2500);
  const diagnosticsVisible = await page.locator(".professional-code-problems li, .monaco-editor .squiggly-error").count() > 0;
  check("intelligence-diagnostics-live", diagnosticsVisible);
  await shot(page, "02-monaco-diagnostics");

  // 修正为合法代码并保存
  await page.keyboard.press("ControlOrMeta+KeyA");
  await page.keyboard.type("function onUpdate(ctx) { ctx.log('monaco normal path ok'); }");
  await page.waitForTimeout(1200);
  const saveButton = page.getByRole("button", { name: "保存脚本" });
  check("save-enabled", await saveButton.count() > 0 && await saveButton.isEnabled().catch(() => false));
  if (await saveButton.isEnabled().catch(() => false)) {
    await saveButton.click();
    await page.waitForTimeout(1500);
  }
  step("script-saved");
  check("monaco-still-alive", await page.locator(".monaco-editor").count() > 0
    && await page.locator(".professional-code-fallback").count() === 0);
  await shot(page, "03-after-save");

  const realErrors = consoleErrors.filter((line) =>
    !line.includes("favicon") && !line.includes("probe-bake") && !line.includes("ERR_ABORTED"));
  console.log("console-errors:", JSON.stringify(realErrors, null, 1));
  check("no-unclassified-console-error", realErrors.length === 0, { count: realErrors.length });
} finally {
  report.finishedAt = new Date().toISOString();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(resolve(outputRoot, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\n报告:${resolve(outputRoot, "report.json")}`);
  await gate.close();
}
console.log("\nE1 风格全链 PASS" && report.failures.length === 0 ? "✅ Monaco 常态验收全绿" : `❌ 失败:${report.failures.join(", ")}`);
process.exit(report.failures.length === 0 ? 0 : 1);
