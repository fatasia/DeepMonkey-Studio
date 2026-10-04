import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../apps/cloud-render-worker/node_modules/playwright-core/index.js";

/**
 * T0 刀 2 用户组合预制体：真实浏览器端到端（Chrome 真机）。
 * 夹具：apps/web/tests/user-prefab-browser.html（引擎行为桩 + 生产模块全链）。
 * 流程：多选→存为预制体→实例 A→移成员→检测覆盖→更新原型 v2→实例 B→应用更新(diff 确认,B 泵体传播)→重置 A。
 * 证据：断言区 8 项 data-pass + 深浅主题截图 + 零页面错误。
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = path.join(root, "test-output", "prefab-browser-e2e");
await mkdir(evidence, { recursive: true });
const origin = process.env.PREFAB_FIXTURE_ORIGIN ?? "http://127.0.0.1:5199";

const browser = await playwright.chromium.launch({
  headless: true,
  executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
try {
  const context = await browser.newContext({ viewport: { width: 1680, height: 980 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/tests/user-prefab-browser.html`);
  await page.waitForSelector("#prefab-checks");

  const check = async (id) => {
    await page.waitForFunction((checkId) => document.querySelector(`[data-check="${checkId}"]`)?.getAttribute("data-pass") === "true", id, { timeout: 15000 });
  };
  const openMemberMenu = async (memberId) => {
    await page.locator(`[data-member-row="${memberId}"] summary`).click();
  };

  // 1. 多选三个对象 → 存为预制体（命名 + 分类）。
  for (const id of ["pump", "motor", "base"]) {
    await page.click(`[data-object-row="${id}"]`, { modifiers: ["Shift"] });
  }
  await page.getByRole("button", { name: "存为预制体", exact: true }).click();
  const saveDialog = page.getByRole("dialog", { name: "存为预制体" });
  await saveDialog.waitFor();
  await saveDialog.getByLabel("预制体名称").fill("卧式泵组");
  await saveDialog.getByLabel("预制体分类").fill("泵/风机");
  await saveDialog.getByRole("button", { name: "存为预制体" }).click();
  await check("save");
  await check("persist");

  // 2. 插入实例 A（相机目标点），层级与相对偏移保持。反馈时限 <100ms（体验红线计量）。
  const insertFeedbackMs = await page.evaluate(() => new Promise((resolve, reject) => {
    const start = performance.now();
    const observer = new MutationObserver(() => {
      if (document.querySelectorAll(".user-prefab-chip").length < 3) return;
      observer.disconnect(); clearTimeout(timer); resolve(performance.now() - start);
    });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error("No insert feedback")); }, 2000);
    observer.observe(document.body, { subtree: true, childList: true });
    document.querySelector("[data-insert-prefab]").click();
  }));
  assert.ok(insertFeedbackMs <= 100, `insert feedback exceeded 100ms: ${insertFeedbackMs.toFixed(1)}ms`);
  await check("instantiate");
  await check("placement");
  const chips = await page.locator(".user-prefab-chip").count();
  assert.ok(chips >= 3, `expected >=3 member chips, got ${chips}`);

  // 3. 移动 A 的泵体成员 → 检测覆盖（路径级登记）。
  // memberObjectIds = { pump, motor, base }（来自窗口内调试句柄）。
  const mapping = await page.evaluate(() => window.__prefabDebug.instances()[0].memberObjectIds);
  await page.click(`[data-member-row="${mapping.pump}"] .asset-main`);
  await page.click('[data-fixture="move-member"]');
  await openMemberMenu(mapping.pump);
  await page.getByRole("button", { name: "检测实例覆盖" }).click();
  await check("override");

  // 4. 先插入实例 B（仍为 v1），再更新原型（此实例）→ v2；A/B 均待更新。
  await page.click("[data-insert-prefab]");
  await page.waitForFunction(() => window.__prefabDebug.instances().length === 2);
  const mappingB = await page.evaluate(() => window.__prefabDebug.instances()[1].memberObjectIds);
  await openMemberMenu(mapping.pump);
  await page.getByRole("button", { name: "从此实例更新原型" }).click();
  await check("pending");

  // 5. 应用更新到 B：diff 对话框列出泵体位置 1 → 1.6，确认后 B 泵体传播到 1.6。
  await openMemberMenu(mappingB.pump);
  await page.getByRole("button", { name: "应用原型更新", exact: true }).click();
  const applyDialog = page.getByRole("dialog", { name: "应用原型更新" });
  await applyDialog.waitFor();
  const dialogText = await applyDialog.innerText();
  assert.ok(dialogText.includes("属性更新（1）"), `diff dialog should list 1 property change, got: ${dialogText}`);
  assert.ok(dialogText.includes("位置.x"), `diff dialog should show position path, got: ${dialogText}`);
  await page.screenshot({ path: path.join(evidence, "apply-diff-dialog-dark.png") });
  await applyDialog.getByRole("button", { name: /应用更新/ }).click();
  await check("apply");

  // 6. 应用更新到 A（覆盖保留，仅版本推进）→ 重置 A 泵体清除覆盖。
  await openMemberMenu(mapping.pump);
  await page.getByRole("button", { name: "应用原型更新", exact: true }).click();
  await page.getByRole("dialog", { name: "应用原型更新" }).waitFor();
  await page.getByRole("dialog", { name: "应用原型更新" }).getByRole("button", { name: /应用更新/ }).click();
  await page.waitForFunction(() => window.__prefabDebug.instances()[0].prefabVersion === 2);
  await openMemberMenu(mapping.pump);
  await page.getByRole("button", { name: "重置为原型" }).click();
  await check("reset");

  // 7. 全绿 + 深浅主题截图；再制造一次覆盖出徽章截图。
  const allPass = await page.getAttribute("#prefab-checks", "data-all-pass");
  assert.equal(allPass, "true", "all checks should pass");
  await page.screenshot({ path: path.join(evidence, "prefab-dark.png"), fullPage: true });
  await page.click(`[data-member-row="${mappingB.pump}"] .asset-main`);
  await page.click('[data-fixture="move-member"]');
  await openMemberMenu(mappingB.pump);
  await page.getByRole("button", { name: "检测实例覆盖" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".user-prefab-chip.overridden").length >= 1);
  await page.screenshot({ path: path.join(evidence, "prefab-dark-override-badge.png") });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(evidence, "prefab-light.png"), fullPage: true });
  assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(" | ")}`);
  await writeFile(path.join(evidence, "result.json"), JSON.stringify({ ok: true, checks: "8/8", themes: ["dark", "light"], insertFeedbackMs: Number(insertFeedbackMs.toFixed(1)), pageErrors }, null, 2));
  console.log(`PREFAB E2E: 8/8 checks PASS; insert feedback ${insertFeedbackMs.toFixed(1)}ms <=100ms; screenshots in test-output/prefab-browser-e2e`);
} catch (error) {
  console.error("PREFAB E2E FAILED:", error instanceof Error ? error.message : error);
  try {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) {
      await page.screenshot({ path: path.join(evidence, "failure.png"), fullPage: true });
      const checks = await page.locator("#prefab-checks").innerText().catch(() => "");
      const log = await page.locator("ul[aria-label='操作日志']").innerText().catch(() => "");
      await writeFile(path.join(evidence, "failure-checks.txt"), `${checks}\n---LOG---\n${log}`);
    }
  } catch { /* evidence best-effort */ }
  process.exitCode = 1;
} finally {
  await browser.close();
}
